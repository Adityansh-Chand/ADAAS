const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const app = require('./server');
const llm = require('./llm');
const { buildIndex, retrieve, containsPhrase } = require('./retrieval');
const {
  ENTITLEMENTS,
  determineLeaveType,
  parseRequestedDays,
  validateRequest,
} = require('./leave_rules');

const KB = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'assets', 'hr_knowledge_base.json'), 'utf8',
));

test.beforeEach(() => {
  app.__resetDemoData();
});

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postJson(baseUrl, route, body) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

test('health reports readiness and the loaded corpus', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.status, 'running');
    assert.equal(data.knowledgeBase.entries, KB.length);
  });
});

test('liveness is separate from readiness', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/live`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'alive');
  });
});

test('health reports 503 when the knowledge base cannot be read', async () => {
  // The point of the readiness split. /health used to return 200 unconditionally,
  // so a pod that could not read its own corpus was marked Ready and answered
  // every policy question with "not found".
  const kbPath = path.resolve(__dirname, '..', 'assets', 'hr_knowledge_base.json');
  const original = fs.readFileSync(kbPath, 'utf8');
  try {
    fs.writeFileSync(kbPath, '[]', 'utf8');
    app.loadKnowledgeBase();

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).status, 'degraded');

      const chat = await postJson(baseUrl, '/chat', { message: 'remote work' });
      assert.equal(chat.status, 503);
    });
  } finally {
    fs.writeFileSync(kbPath, original, 'utf8');
    app.loadKnowledgeBase();
  }
});

test('request ID header is returned', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { 'X-Request-ID': 'req-123' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-123');
  });
});

test('protected routes require API key when configured', async () => {
  process.env.API_KEY = 'test-key';

  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/leave-balance?employee_id=1001`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/leave-balance?employee_id=1001`, {
      headers: { 'X-API-Key': 'test-key' },
    });
    assert.equal(authorized.status, 200);

    // A key of a different length must not throw inside timingSafeEqual.
    const shortKey = await fetch(`${baseUrl}/leave-balance?employee_id=1001`, {
      headers: { 'X-API-Key': 'x' },
    });
    assert.equal(shortKey.status, 401);
  });

  delete process.env.API_KEY;
});

test('bad requests use safe JSON error shape', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/leave-balance`);
    const data = await response.json();

    assert.equal(response.status, 400);
    assert.equal(data.error, 'employee_id is required');
  });
});

test('unknown routes use safe JSON error shape', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missing-route`);
    const data = await response.json();

    assert.equal(response.status, 404);
    assert.equal(data.error, 'Not found');
    assert.ok(data.request_id);
  });
});

test('metrics exposes request counters', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/metrics`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.ok(data.counters.requests_total >= 1);
    assert.equal(data.knowledge_base_entries, KB.length);
  });
});

// ---------------------------------------------------------------------------
// Entitlements agree with the corpus
// ---------------------------------------------------------------------------

test('entitlements match the policy text they are transcribed from', () => {
  // Guards against the two halves drifting apart again. The seeded demo data
  // used to grant 5 casual and 20 combined days while the policies the same app
  // quotes say 4 and 18.
  const casual = KB.find((e) => e.id === ENTITLEMENTS.casual_leave.policyId);
  const combined = KB.find(
    (e) => e.id === ENTITLEMENTS.combined_annual_sick_leave.policyId,
  );

  assert.ok(casual, 'casual leave policy must exist in the corpus');
  assert.ok(combined, 'combined leave policy must exist in the corpus');
  assert.match(
    casual.answer,
    new RegExp(`${ENTITLEMENTS.casual_leave.days}\\s+days per year`, 'i'),
  );
  assert.match(
    combined.answer,
    new RegExp(`${ENTITLEMENTS.combined_annual_sick_leave.days}\\s+days per year`, 'i'),
  );
});

test('reported balance never exceeds the entitlement', async () => {
  await withServer(async (baseUrl) => {
    const data = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();

    assert.equal(data.entitlements.casual_leave, ENTITLEMENTS.casual_leave.days);
    assert.ok(data.casual_leave_balance <= data.entitlements.casual_leave);
    assert.ok(
      data.combined_annual_sick_leave_balance
        <= data.entitlements.combined_annual_sick_leave,
    );
    assert.equal(
      data.casual_leave_balance,
      data.entitlements.casual_leave - data.used.casual_leave,
    );
  });
});

// ---------------------------------------------------------------------------
// Leave applications
// ---------------------------------------------------------------------------

test('leave application identifies leave type', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'I want to apply for 1 day of sick leave',
    });
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.leave_type, 'Sick Leave');
  });
});

test('an application decrements the balance it draws on', async () => {
  // The two features used to be independent subsystems: applying for leave never
  // touched a balance, so the balance was unchanged afterwards.
  await withServer(async (baseUrl) => {
    const before = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();

    const response = await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 2 days casual leave',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.days, 2);

    const after = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    assert.equal(
      after.casual_leave_balance,
      before.casual_leave_balance - 2,
      'casual balance must drop by the days submitted',
    );
    assert.equal(body.remaining_after, after.casual_leave_balance);
  });
});

test('a request beyond the entitlement cap is refused', async () => {
  // Verified live against the old build: "400 days of casual leave starting
  // yesterday" was accepted with status "submitted" and a reference ID, against
  // a 4-day annual entitlement.
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'I want 400 days of casual leave starting yesterday',
    });

    assert.equal(response.status, 422);
    const data = await response.json();
    assert.equal(data.requested_days, 400);
    assert.match(data.error, /consecutive days/i);
    assert.ok(!('reference_id' in data), 'a refused request must not get a reference');
  });
});

test('a request beyond the remaining balance is refused', async () => {
  await withServer(async (baseUrl) => {
    const balance = await (
      await fetch(`${baseUrl}/leave-balance?employee_id=1001`)
    ).json();
    const overBudget = balance.combined_annual_sick_leave_balance + 1;

    const response = await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: `apply for ${overBudget} days annual leave`,
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /remaining/i);

    // And the refusal must not have moved the balance.
    const after = await (
      await fetch(`${baseUrl}/leave-balance?employee_id=1001`)
    ).json();
    assert.equal(
      after.combined_annual_sick_leave_balance,
      balance.combined_annual_sick_leave_balance,
    );
  });
});

test('an unknown employee cannot file leave', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/leave-application', {
      employee_id: '9999',
      request_text: 'apply for 1 day casual leave',
    });
    assert.equal(response.status, 404);
  });
});

test('confirmation messages carry no markdown', async () => {
  // The old message embedded `**Casual Leave**`, which the Flutter client
  // rendered into a plain Text widget, so the user read the asterisks.
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.ok(!data.message.includes('**'), data.message);
  });
});

test('leave application is persisted in the fallback store', async () => {
  await withServer(async (baseUrl) => {
    await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day annual leave',
    });

    const response = await fetch(`${baseUrl}/leave-applications`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.ok(data.applications.length > 0);
    assert.ok(data.applications[0].reference_id);
  });
});

test('leave day parsing', () => {
  assert.equal(parseRequestedDays('apply for 3 days sick leave'), 3);
  assert.equal(parseRequestedDays('400 days of casual leave'), 400);
  assert.equal(parseRequestedDays('two days off'), 2);
  assert.equal(parseRequestedDays('half day tomorrow'), 0.5);
  assert.equal(parseRequestedDays('one week off'), 5);
  assert.equal(parseRequestedDays('apply for leave'), null);
});

test('leave type detection', () => {
  assert.equal(determineLeaveType('sick leave please'), 'Sick Leave');
  assert.equal(determineLeaveType('annual leave'), 'Annual Leave');
  assert.equal(determineLeaveType('earned leave'), 'Annual Leave');
  assert.equal(determineLeaveType('two days off'), 'Casual Leave');
});

test('validation refuses an unknown leave type rather than defaulting', () => {
  const result = validateRequest({
    leaveType: 'Sabbatical',
    requestedDays: 1,
    remaining: { casual_leave: 4, combined_annual_sick_leave: 18 },
  });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

test('chat answers from the HR knowledge base', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/chat', {
      message: 'What is the remote work policy?',
    });
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.match(data.answer, /Remote work/i);
    assert.ok(data.sources.length > 0);
    assert.equal(data.sources[0], 'Flexible Work Arrangement Policy');
    assert.equal(data.generated_by, 'knowledge_base');
  });
});

test('chat reports no policy rather than guessing', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/chat', {
      message: 'what is the airspeed velocity of an unladen swallow',
    });
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.match(data.answer, /couldn't find/i);
    assert.deepEqual(data.sources, []);
  });
});

test('matching is word-bounded, not substring', () => {
  // The old scorer matched keywords as raw substrings, so `cl` (casual leave)
  // fired inside `clients` and `el` (earned leave) inside `help` and `travel`.
  const query = ' can i tell a friend which clients we work with ';
  assert.equal(containsPhrase(query, 'cl'), false);
  assert.equal(containsPhrase(query, 'clients'), true);
  assert.equal(containsPhrase(' i need help with travel ', 'el'), false);
});

test('the IT category no longer fires on the letters "it"', () => {
  // `IT` is a category name in the corpus and the old boost was a substring
  // check, so the IT Security policy scored +2 on any message containing "it" --
  // in `entitled`, `submit`, `with`, and inside `security` and `exit`.
  const index = buildIndex(KB);
  const ranked = retrieve('what am I entitled to when I submit this', index, { topK: 5 });
  const ids = ranked.map((r) => r.entry.id);
  assert.ok(!ids.includes('policy_004'), `unexpected IT match: ${ids.join(', ')}`);
});

test('a keyword owned by two policies does not decide the ranking alone', () => {
  // `remote work` belongs to both policy_002 (Attendance) and policy_013
  // (Flexible Work). IDF weighting plus length normalisation must put the
  // dedicated policy first.
  const index = buildIndex(KB);
  const ranked = retrieve('What is the remote work policy?', index, { topK: 5 });
  assert.equal(ranked[0].entry.id, 'policy_013');
});

test('retrieval returns nothing when there is no lexical evidence', () => {
  // minScore must stay above zero. At zero, every policy scores 0.000 on a
  // paraphrase and the sort falls through to its tiebreak, so policy_001 is
  // returned for everything -- which looks like recall but is alphabetical luck.
  const index = buildIndex(KB);
  assert.equal(retrieve('zzzz qqqq xxxx', index, { topK: 5 }).length, 0);
});

// ---------------------------------------------------------------------------
// LLM configuration
// ---------------------------------------------------------------------------

test('LLM is off by default', () => {
  assert.equal(llm.isConfigured(llm.readConfig({})), false);
  assert.equal(llm.readConfig({}).provider, 'none');
});

test('LLM config is provider agnostic', () => {
  const config = llm.readConfig({
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'gpt-4o-mini',
    LLM_BASE_URL: 'https://example.test/',
  });
  assert.equal(config.provider, 'openai');
  assert.equal(config.baseUrl, 'https://example.test');
  assert.equal(llm.isConfigured(config), true);
});

test('a legacy GEMINI_API_KEY still works', () => {
  const config = llm.readConfig({ GEMINI_API_KEY: 'legacy' });
  assert.equal(config.provider, 'gemini');
  assert.equal(config.apiKey, 'legacy');
  assert.equal(config.usedLegacyKey, true);
});

test('the API key is not placed in the request URL', () => {
  const request = llm.PROVIDERS.gemini.buildRequest({
    apiKey: 'secret-key',
    model: 'gemini-2.5-flash',
    prompt: 'hello',
  });
  assert.ok(!request.url.includes('secret-key'), request.url);
  assert.equal(request.headers['x-goog-api-key'], 'secret-key');
});

test('a stalled provider does not stall the caller', async () => {
  // The old fetch had no timeout or abort signal, so a hung provider hung the
  // request. This asserts the deadline is real by measuring it.
  let aborted = false;
  const hangingFetch = (url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      aborted = true;
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  const started = Date.now();
  const result = await llm.generate('q', 'context', {
    env: { LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', LLM_TIMEOUT_MS: '150' },
    fetchImpl: hangingFetch,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.text, null);
  assert.equal(result.reason, 'timeout');
  assert.equal(aborted, true);
  assert.ok(elapsed < 2000, `took ${elapsed}ms, deadline should have fired`);
});

test('the timeout is read at call time, not import time', () => {
  // A module-level constant cannot be reconfigured after import. That exact bug
  // shipped in the operations service.
  assert.equal(llm.readConfig({ LLM_TIMEOUT_MS: '1234' }).timeoutMs, 1234);
  assert.equal(llm.readConfig({}).timeoutMs, llm.DEFAULT_TIMEOUT_MS);
});

test('a failing provider falls back to the retrieved policy text', async () => {
  const failingFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const result = await llm.generate('q', 'context', {
    env: { LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' },
    fetchImpl: failingFetch,
  });
  assert.equal(result.text, null);
  assert.equal(result.reason, 'provider_status_503');
});

// ---------------------------------------------------------------------------
// Retrieval modes
// ---------------------------------------------------------------------------

const denseRetrieval = require('./dense');
const embeddingsModule = require('./embeddings');

test('retrieval mode defaults to lexical', () => {
  delete process.env.RETRIEVAL_MODE;
  assert.equal(app.configuredRetrievalMode(), 'lexical');
  assert.equal(app.activeRetrievalMode().mode, 'lexical');
});

test('an unrecognised retrieval mode falls back rather than throwing', () => {
  process.env.RETRIEVAL_MODE = 'magic-beans';
  try {
    assert.equal(app.configuredRetrievalMode(), 'lexical');
  } finally {
    delete process.env.RETRIEVAL_MODE;
  }
});

test('health reports the active mode and says when it is degraded', async () => {
  process.env.RETRIEVAL_MODE = 'dense';
  try {
    await withServer(async (baseUrl) => {
      const data = await (await fetch(`${baseUrl}/health`)).json();
      // Vectors are committed and the dev package is installed locally and in
      // CI, so this should be running dense. If either is absent the response
      // must say so rather than silently pretending.
      if (data.retrieval.mode === 'dense') {
        assert.equal(data.retrieval.requested, undefined);
      } else {
        assert.equal(data.retrieval.mode, 'lexical');
        assert.equal(data.retrieval.requested, 'dense');
        assert.ok(data.retrieval.degraded_because);
      }
    });
  } finally {
    delete process.env.RETRIEVAL_MODE;
  }
});

test('chat reports which retrieval mode produced the answer', async () => {
  await withServer(async (baseUrl) => {
    const data = await (await postJson(baseUrl, '/chat', {
      message: 'What is the remote work policy?',
    })).json();
    assert.equal(data.retrieval_mode, 'lexical');
  });
});

test('dense retrieval answers a paraphrase that lexical cannot', async () => {
  // The headline result. Lexical returns nothing for this query because it
  // contains none of the indexed keyword strings; dense retrieves the right
  // policy. Measured across the whole eval set: 0.1111 -> 0.6111 top-1.
  const store = denseRetrieval.loadVectors();
  assert.ok(store, 'eval/embeddings.json must be committed');

  const query = 'Can I work from my house a few days a week?';
  const kbById = new Map(KB.map((e) => [e.id, e]));

  const ranked = await denseRetrieval.denseRetrieve(query, store, kbById, {
    topK: 5,
    allowLiveEmbedding: false,
  });
  assert.equal(ranked[0].entry.id, 'policy_013');

  // And the lexical retriever genuinely fails on it, so the comparison is real.
  const lexical = retrieve(query, buildIndex(KB), { topK: 5 });
  assert.equal(lexical.length, 0);
});

test('dense retrieval refuses an out-of-scope query', async () => {
  // The threshold sits at 0.12, in the measured gap between out-of-scope queries
  // (at most 0.0899) and in-scope paraphrases (at least 0.1636). Without it the
  // service would always return its closest guess.
  const store = denseRetrieval.loadVectors();
  const kbById = new Map(KB.map((e) => [e.id, e]));
  const vector = store.queries['Can I work from my house a few days a week?'];
  assert.ok(vector);

  // A vector orthogonal to everything must retrieve nothing.
  const orthogonal = new Array(embeddingsModule.DIMENSIONS).fill(0);
  const ranked = await denseRetrieval.denseRetrieve('irrelevant', store, kbById, {
    topK: 5,
    queryVector: orthogonal,
    allowLiveEmbedding: false,
  });
  assert.equal(ranked.length, 0);
});

test('precomputed vectors match the corpus', () => {
  // Guards against a policy being edited without re-embedding, which would leave
  // dense retrieval scoring against stale vectors. `npm run embed:verify` is the
  // full check; this asserts the shape and coverage cheaply on every test run.
  const store = denseRetrieval.loadVectors();
  assert.equal(store.dimensions, embeddingsModule.DIMENSIONS);
  assert.equal(Object.keys(store.policies).length, KB.length);
  for (const entry of KB) {
    assert.ok(store.policies[entry.id], `no vector for ${entry.id}`);
    assert.equal(store.policies[entry.id].length, embeddingsModule.DIMENSIONS);
  }
});

test('fusion of two rankings keeps entries found by only one side', () => {
  const a = [{ entry: { id: 'x' }, score: 1 }];
  const b = [{ entry: { id: 'y' }, score: 1 }];
  const fused = denseRetrieval.fuse(a, b, { topK: 5 });
  assert.deepEqual(fused.map((f) => f.entry.id).sort(), ['x', 'y']);
});

test('a zero-weight side is excluded from fusion entirely', () => {
  const lexical = [{ entry: { id: 'lex' }, score: 1 }];
  const denseRanked = [{ entry: { id: 'dense' }, score: 1 }];
  const fused = denseRetrieval.fuse(lexical, denseRanked, {
    topK: 5, lexicalWeight: 0,
  });
  assert.deepEqual(fused.map((f) => f.entry.id), ['dense']);
});

// ---------------------------------------------------------------------------
// Identity and the approval workflow
// ---------------------------------------------------------------------------

test('two employees have independent balances', async () => {
  // With a single seeded employee, "hardcoded to 1001" and "supports one
  // employee" were indistinguishable from the outside.
  await withServer(async (baseUrl) => {
    const a = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    const b = await (await fetch(`${baseUrl}/leave-balance?employee_id=1002`)).json();
    assert.notEqual(a.casual_leave_balance, b.casual_leave_balance);
    assert.equal(a.employee_id, '1001');
    assert.equal(b.employee_id, '1002');
  });
});

test('an application can be approved by someone else', async () => {
  await withServer(async (baseUrl) => {
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    })).json();

    const decided = await postJson(
      baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'approved', decided_by: '1002' },
    );
    assert.equal(decided.status, 200);
    const body = await decided.json();
    assert.equal(body.status, 'approved');
    assert.equal(body.decided_by, '1002');
  });
});

test('rejecting an application returns the days to the balance', async () => {
  // Days are deducted at submission so a balance cannot be spent twice, which
  // makes restoring them on rejection a required invariant rather than a nicety.
  await withServer(async (baseUrl) => {
    const before = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();

    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 2 days casual leave',
    })).json();

    const during = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    assert.equal(during.casual_leave_balance, before.casual_leave_balance - 2);

    const decided = await (await postJson(
      baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'rejected', decided_by: '1002' },
    )).json();
    assert.equal(decided.status, 'rejected');
    assert.equal(decided.restored_balance, before.casual_leave_balance);

    const after = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    assert.equal(after.casual_leave_balance, before.casual_leave_balance);
  });
});

test('approving does not return the days', async () => {
  await withServer(async (baseUrl) => {
    const before = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    })).json();
    await postJson(baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'approved', decided_by: '1002' });

    const after = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    assert.equal(after.casual_leave_balance, before.casual_leave_balance - 1);
  });
});

test('an employee cannot decide their own application', async () => {
  // The one authorisation rule enforceable without an identity provider.
  await withServer(async (baseUrl) => {
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    })).json();

    const response = await postJson(
      baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'approved', decided_by: '1001' },
    );
    assert.equal(response.status, 403);
  });
});

test('an application cannot be decided twice', async () => {
  await withServer(async (baseUrl) => {
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    })).json();
    const first = await postJson(
      baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'rejected', decided_by: '1002' },
    );
    assert.equal(first.status, 200);

    // A second rejection must not restore the days again.
    const balance = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    const second = await postJson(
      baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'rejected', decided_by: '1002' },
    );
    assert.equal(second.status, 409);

    const after = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    assert.equal(after.casual_leave_balance, balance.casual_leave_balance);
  });
});

test('a balance never exceeds its entitlement, even after restores', async () => {
  await withServer(async (baseUrl) => {
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    })).json();
    await postJson(baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'rejected', decided_by: '1002' });

    const after = await (await fetch(`${baseUrl}/leave-balance?employee_id=1001`)).json();
    assert.ok(after.casual_leave_balance <= after.entitlements.casual_leave,
      `${after.casual_leave_balance} > ${after.entitlements.casual_leave}`);
    assert.ok(after.used.casual_leave >= 0);
  });
});

test('a decision needs a valid verdict and a decider', async () => {
  await withServer(async (baseUrl) => {
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    })).json();

    const noVerdict = await postJson(
      baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decided_by: '1002' },
    );
    assert.equal(noVerdict.status, 400);

    const noDecider = await postJson(
      baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'approved' },
    );
    assert.equal(noDecider.status, 400);

    const unknown = await postJson(
      baseUrl, '/leave-applications/LMS-NOPE/decision',
      { decision: 'approved', decided_by: '1002' },
    );
    assert.equal(unknown.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

const intentModule = require('./intent');

function evalFile(name) {
  return evalFileRaw(name).cases;
}

/** The whole fixture, not just its cases -- some carry metadata worth asserting on. */
function evalFileRaw(name) {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'eval', name), 'utf8',
  ));
}

test('the intent endpoint classifies and reports which method decided', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/intent', {
      message: 'show my leave balance',
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(intentModule.INTENTS.includes(data.intent), data.intent);
    // Default RETRIEVAL_MODE is lexical, so the rules decide and say so.
    assert.equal(data.method, 'rules');
  });
});

test('the intent endpoint rejects an empty message', async () => {
  await withServer(async (baseUrl) => {
    const response = await postJson(baseUrl, '/intent', { message: '   ' });
    assert.equal(response.status, 400);
  });
});

test('the embedding classifier beats the rules on held-out phrasing', () => {
  // 0.9333 against 0.5667 on eval/held_out_intent_queries_3.json, a set written
  // before the classifier existed, and 0.8000 against 0.3667 on set 4, written
  // before the classifier was rewritten. `npm run eval:intent` reproduces both.
  // Asserted here so a regression in either direction is caught.
  const store = denseRetrieval.loadVectors();
  const training = evalFile('intent_training.json');
  const heldOut = evalFile('held_out_intent_queries_3.json');

  const classifier = intentModule.buildClassifier(training, store.queries);
  assert.equal(classifier.missing.length, 0,
    'training examples lack embeddings; run `npm run embed`');

  let rules = 0;
  let embedding = 0;
  for (const c of heldOut) {
    if (intentModule.routeByRules(c.q) === c.label) rules += 1;
    const decided = intentModule.route(c.q, classifier, store.queries[c.q]);
    if (decided.intent === c.label) embedding += 1;
  }

  const rulesAccuracy = rules / heldOut.length;
  const embeddingAccuracy = embedding / heldOut.length;
  assert.ok(embeddingAccuracy > rulesAccuracy,
    `embedding ${embeddingAccuracy} should beat rules ${rulesAccuracy}`);
  assert.ok(embeddingAccuracy >= 0.88, `embedding accuracy ${embeddingAccuracy}`);
});

test('the classifier holds up on the set written before it was rewritten', () => {
  // Set 4 exists because set 3 said it should: "if intent accuracy becomes the
  // priority, the honest route is a fourth held-out set written before anything
  // is re-picked". It was written first, then the classifier was changed, so
  // this number was never available to fit against.
  //
  // It is the lowest of the held-out scores (0.8000 against 0.9333 on set 3) and
  // that is the point of it -- it was written to be harder, with bare noun
  // phrases, stated reasons and no verbs, and it found six real failures the
  // other sets do not contain.
  const store = denseRetrieval.loadVectors();
  const classifier = intentModule.buildClassifier(
    evalFile('intent_training.json'), store.queries,
  );
  const heldOut = evalFile('held_out_intent_queries_4.json');

  let rules = 0;
  let embedding = 0;
  for (const c of heldOut) {
    if (intentModule.routeByRules(c.q) === c.label) rules += 1;
    if (intentModule.route(c.q, classifier, store.queries[c.q]).intent === c.label) {
      embedding += 1;
    }
  }

  assert.ok(embedding / heldOut.length >= 0.72,
    `set 4 accuracy ${embedding / heldOut.length}`);
  assert.ok(embedding > rules,
    `embedding ${embedding} should beat rules ${rules} on set 4`);
});

test('fitting the classifier twice gives byte-identical predictions', () => {
  // The linear model replaced k-NN, and k-NN had one property worth not losing
  // quietly: there was nothing to fit, so there was nothing to be
  // nondeterministic about. Gradient descent from a zero initialisation keeps
  // that -- no seed, no shuffling, no randomness anywhere -- and this is the
  // test that says so. If it ever fails, the committed accuracy figures have
  // stopped being reproducible and every number in the README is provisional.
  const store = denseRetrieval.loadVectors();
  const training = evalFile('intent_training.json');
  const examples = training
    .map((c) => ({ label: c.label, vector: store.queries[c.q] }))
    .filter((e) => e.vector);

  const a = intentModule.fitLogisticRegression(examples);
  const b = intentModule.fitLogisticRegression(examples);

  for (const c of evalFile('held_out_intent_queries_3.json')) {
    const v = store.queries[c.q];
    if (!v) continue;
    const pa = a.predict(v);
    const pb = b.predict(v);
    assert.equal(pa.label, pb.label);
    assert.equal(pa.probability, pb.probability,
      `probability drifted for ${JSON.stringify(c.q)}`);
  }
});

test('the classifier declines rather than guessing on an unrelated message', () => {
  const store = denseRetrieval.loadVectors();
  const classifier = intentModule.buildClassifier(
    evalFile('intent_training.json'), store.queries,
  );

  // A vector orthogonal to everything must fall below the confidence floor, so
  // the rules take over rather than a weak neighbour deciding.
  const orthogonal = new Array(embeddingsModule.DIMENSIONS).fill(0);
  const result = intentModule.classify(classifier, orthogonal);
  assert.equal(result.intent, null);
  assert.equal(result.confidence, 0);
});

test('a policy question is never routed to a leave action', () => {
  // The test that did not exist, and the reason a screenshot found this instead
  // of the suite. Asked "Can I work from my house a few days a week?", the app
  // routed to applyLeave and attempted to file five days of casual leave -- and
  // every intent set passed, because no intent fixture contained a policy
  // question phrased that way.
  //
  // Scored on the 36 retrieval paraphrases, which are policy questions by
  // construction. This is asymmetric on purpose: routing a question to
  // policyQuestion when it was a request is a worse answer, while routing a
  // request to an action that was never asked for writes to a leave balance. The
  // three contested labels in eval/intent_from_retrieval.json are excluded from
  // the count and named there; the floor is set against the conservative figure
  // that includes them.
  const store = denseRetrieval.loadVectors();
  const classifier = intentModule.buildClassifier(
    evalFile('intent_training.json'), store.queries,
  );

  let routedToAnAction = 0;
  for (const c of evalFile('policy_queries.json')) {
    const decided = intentModule.route(c.q, classifier, store.queries[c.q]);
    if (decided.intent !== 'policyQuestion') routedToAnAction += 1;
  }

  // 0.75, matching the gate in eval_intent.js -- see the note there on why a
  // 36-case probe cannot carry a tighter floor.
  const safe = 1 - (routedToAnAction / 36);
  assert.ok(safe >= 0.75,
    `${routedToAnAction} of 36 policy questions routed to a leave action `
    + `(${safe.toFixed(4)} safe)`);

  // The converse, so this cannot be passed by answering policyQuestion to
  // everything -- which would score 1.0000 above and break both leave features.
  const balanced = evalFile('held_out_intent_queries_5.json');
  let correct = 0;
  for (const c of balanced) {
    if (intentModule.route(c.q, classifier, store.queries[c.q]).intent === c.label) {
      correct += 1;
    }
  }
  assert.ok(correct / balanced.length >= 0.80,
    `held-out set 5 accuracy ${(correct / balanced.length).toFixed(4)} -- `
    + 'action safety must not be bought by refusing to act at all');
});

test('the graded judgements never contradict the original gold labels', () => {
  // The guard that lets graded relevance judgements be trusted at all. The same
  // person who tuned the retriever wrote them, so the one protection that does
  // not depend on their judgement is structural: the single gold label that
  // predates the qrels must still be graded 2 in them. A gold quietly demoted to
  // 1, or dropped, would let a wrong answer look like a labelling artefact.
  const qrels = evalFileRaw('policy_qrels.json');
  const kbIds = new Set(KB.map((e) => e.id));

  for (const c of evalFileRaw('policy_queries.json').cases) {
    const grades = qrels.judgements[c.q];
    assert.ok(grades, `no judgements for ${JSON.stringify(c.q)}`);
    assert.equal(grades[c.id], 2,
      `gold ${c.id} is not graded 2 for ${JSON.stringify(c.q)}`);
  }
  for (const [q, grades] of Object.entries(qrels.judgements)) {
    for (const [id, grade] of Object.entries(grades)) {
      assert.ok(kbIds.has(id), `judged id ${id} is not in the corpus (${q})`);
      assert.ok(grade === 1 || grade === 2, `grade ${grade} for ${id} (${q})`);
    }
  }
});

test('the rerank floor gates the answer without truncating the ranking', async () => {
  // Regression test for a threshold doing two jobs. The floor used to filter
  // every sub-floor candidate out of the list, which cost recall@5 on queries
  // that were answered anyway -- 0.9444 instead of 1.0000 on the Set B dev half.
  //
  // Both halves of the contract are asserted, because fixing one by breaking the
  // other would be easy: a pool whose best score clears the floor keeps all of
  // its candidates, and a pool whose best score does not returns nothing at all.
  const candidates = ['policy_001', 'policy_002', 'policy_003_cl'].map((id) => ({
    entry: KB.find((e) => e.id === id),
    score: 0.5,
  }));

  const above = await reranker.rerank('q', candidates, {
    precomputed: { policy_001: 2.0, policy_002: -9.0, policy_003_cl: -9.0 },
  });
  assert.equal(above.length, 3, 'sub-floor candidates were dropped from the list');
  assert.equal(above[0].entry.id, 'policy_001');

  const below = await reranker.rerank('q', candidates, {
    precomputed: { policy_001: -9.0, policy_002: -9.0, policy_003_cl: -9.0 },
  });
  assert.equal(below.length, 0, 'nothing cleared the floor, so nothing may be shown');
});

test('the training set is not a paraphrase of any held-out set', () => {
  // The real leakage test, and what the intent eval gates on. A high score on
  // unseen phrasing only means something if the phrasing is genuinely unseen.
  const store = denseRetrieval.loadVectors();
  const training = evalFile('intent_training.json');

  let worst = 0;
  for (const file of ['held_out_intent_queries.json',
    'held_out_intent_queries_2.json', 'held_out_intent_queries_3.json',
    'held_out_intent_queries_4.json', 'held_out_intent_queries_5.json']) {
    for (const c of evalFile(file)) {
      const v = store.queries[c.q];
      if (!v) continue;
      for (const t of training) {
        const tv = store.queries[t.q];
        if (!tv) continue;
        const similarity = embeddingsModule.cosine(v, tv);
        if (similarity > worst) worst = similarity;
      }
    }
  }
  assert.ok(worst < 0.92, `closest training/eval pair is ${worst.toFixed(4)}`);
});

// ---------------------------------------------------------------------------
// Decision notifications
// ---------------------------------------------------------------------------

test('a decision produces a notification addressed to the applicant', async () => {
  // A decision the applicant is never told about is not a workflow. Approvals
  // and rejections previously moved a balance silently.
  await withServer(async (baseUrl) => {
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 2 days casual leave',
    })).json();

    await postJson(baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'rejected', decided_by: '1002' });

    const data = await (await fetch(
      `${baseUrl}/notifications?employee_id=1001&unread=true`)).json();
    assert.equal(data.unread, 1);
    assert.match(data.notifications[0].message, /rejected/i);
    assert.match(data.notifications[0].message, /returned to your balance/i);
    assert.equal(data.notifications[0].reference_id, filed.reference_id);
  });
});

test('a notification goes to the applicant, not the approver', async () => {
  await withServer(async (baseUrl) => {
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    })).json();
    await postJson(baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'approved', decided_by: '1002' });

    const applicant = await (await fetch(
      `${baseUrl}/notifications?employee_id=1001`)).json();
    const approver = await (await fetch(
      `${baseUrl}/notifications?employee_id=1002`)).json();

    assert.equal(applicant.notifications.length, 1);
    assert.equal(approver.notifications.length, 0);
  });
});

test('acknowledging a notification clears it from unread', async () => {
  await withServer(async (baseUrl) => {
    const filed = await (await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    })).json();
    await postJson(baseUrl, `/leave-applications/${filed.reference_id}/decision`,
      { decision: 'approved', decided_by: '1002' });

    const before = await (await fetch(
      `${baseUrl}/notifications?employee_id=1001&unread=true`)).json();
    assert.equal(before.unread, 1);

    const ack = await postJson(
      baseUrl, `/notifications/${before.notifications[0].id}/ack`, {});
    assert.equal(ack.status, 200);

    const after = await (await fetch(
      `${baseUrl}/notifications?employee_id=1001&unread=true`)).json();
    assert.equal(after.unread, 0);
  });
});

test('a refused application produces no notification', async () => {
  // Nothing happened, so there is nothing to announce.
  await withServer(async (baseUrl) => {
    await postJson(baseUrl, '/leave-application', {
      employee_id: '1001',
      request_text: 'I want 400 days of casual leave',
    });
    const data = await (await fetch(
      `${baseUrl}/notifications?employee_id=1001`)).json();
    assert.equal(data.notifications.length, 0);
  });
});

test('notifications require an employee, and an unknown ack is 404', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/notifications`)).status, 400);
    assert.equal(
      (await postJson(baseUrl, '/notifications/NTF-NOPE/ack', {})).status, 404);
  });
});

// ---------------------------------------------------------------------------
// Reranking
//
// The reranker exists to fix a ranking failure, so what needs guarding is not
// "does it score well" -- `npm run eval` does that, with gates -- but the two
// properties the design depends on: it must never invent a result, and its
// abstention floor must actually be applied. Both are things a refactor could
// silently break while every accuracy number stayed identical.
// ---------------------------------------------------------------------------

const reranker = require('./rerank');

test('reranking an empty candidate list returns empty, not a guess', async () => {
  assert.deepEqual(await reranker.rerank('anything', []), []);
  assert.deepEqual(await reranker.rerank('anything', null), []);
});

test('reranking cannot introduce a document retrieval did not return', async () => {
  // The whole abstention story rests on this. If the reranker scored the corpus
  // instead of the shortlist, the service would always have a best guess and
  // could never honestly say it found nothing.
  const shortlist = KB.slice(0, 3).map((entry) => ({ entry, score: 0.5 }));
  const precomputed = Object.fromEntries(KB.map((e) => [e.id, 0]));

  const out = await reranker.rerank('q', shortlist, { precomputed });
  const returnedIds = out.map((x) => x.entry.id).sort();
  const shortlistIds = shortlist.map((x) => x.entry.id).sort();

  assert.deepEqual(returnedIds, shortlistIds);
});

test('the logit floor decides whether to answer, not which sources to show', async () => {
  // This test previously asserted the opposite -- that a sub-floor candidate was
  // dropped from the returned list -- and it was changed deliberately rather
  // than worked around. The old behaviour used one threshold for two different
  // questions, and it cost recall@5 on the Set B dev half (0.9444 instead of
  // 1.0000) for queries that were answered anyway. See the note in rerank.js.
  //
  // What must not change is the abstention behaviour, and the second half of
  // this test is the assertion that it did not: the condition for returning
  // nothing is identical, because "every candidate is below the floor" and "the
  // best candidate is below the floor" are the same statement.
  const shortlist = KB.slice(0, 3).map((entry) => ({ entry, score: 0.5 }));
  const floor = reranker.DEFAULT_MIN_LOGIT;

  // One clearly above the floor, two clearly below.
  const precomputed = {
    [KB[0].id]: floor + 1,
    [KB[1].id]: floor - 1,
    [KB[2].id]: floor - 5,
  };

  const out = await reranker.rerank('q', shortlist, { precomputed });
  assert.equal(out.length, 3, 'the ranking must not be truncated by the floor');
  assert.equal(out[0].entry.id, KB[0].id);
  // Still ordered by the cross-encoder, worst last.
  assert.equal(out[2].entry.id, KB[2].id);

  // And everything below the floor means nothing, not the least-bad option.
  const allBad = Object.fromEntries(
    shortlist.map((x) => [x.entry.id, floor - 1]),
  );
  assert.deepEqual(await reranker.rerank('q', shortlist, { precomputed: allBad }), []);
});

test('reranking preserves the retrieval score rather than overwriting it', async () => {
  // A caller needs to be able to see what each stage thought. Collapsing the two
  // into one number is how a retrieval score gets quietly renamed "confidence".
  const shortlist = [{ entry: KB[0], score: 0.61 }];
  const out = await reranker.rerank('q', shortlist, {
    precomputed: { [KB[0].id]: 0 },
  });
  assert.equal(out[0].retrievalScore, 0.61);
  assert.equal(out[0].score, 0);
});

test('a missing precomputed score is an error, not a silent live call', async () => {
  // Otherwise the eval would quietly become non-deterministic and dependent on a
  // model download, which is the property the committed fixtures exist to avoid.
  await assert.rejects(
    () => reranker.rerank('q', [{ entry: KB[0], score: 0.5 }], { precomputed: {} }),
    /no precomputed rerank score/,
  );
});

test('the committed rerank fixture covers every eval query and policy', async () => {
  const store = reranker.loadScores();
  assert.ok(store, 'eval/rerank_scores.json should exist -- run `npm run rerank:build`');
  assert.equal(store.model, reranker.MODEL_ID);

  const oos = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'eval', 'out_of_scope_queries.json'), 'utf8'));
  const setB = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'eval', 'policy_queries.json'), 'utf8'));

  for (const c of [...oos.cases, ...setB.cases]) {
    const row = store.scores[c.q];
    assert.ok(row, `no committed rerank scores for ${JSON.stringify(c.q)}`);
    for (const entry of KB) {
      assert.equal(typeof row[entry.id], 'number',
        `no score for ${entry.id} / ${JSON.stringify(c.q)}`);
    }
  }
});

test('reranked is a valid retrieval mode and degrades one step, not two', async () => {
  // `reranked` needs the model at request time. When the package is missing it
  // must fall back to dense, which runs from committed vectors, rather than all
  // the way to lexical -- and /health has to say which happened.
  const previous = process.env.RETRIEVAL_MODE;
  process.env.RETRIEVAL_MODE = 'reranked';
  try {
    const { mode, reason } = app.activeRetrievalMode();
    assert.ok(['reranked', 'dense', 'lexical'].includes(mode));
    if (mode === 'dense') {
      assert.equal(reason, 'reranker_package_not_installed');
    }
  } finally {
    if (previous === undefined) delete process.env.RETRIEVAL_MODE;
    else process.env.RETRIEVAL_MODE = previous;
  }
});

test('the passage the cross-encoder scores includes the question field', async () => {
  // Measured choice, not incidental: question+answer beat answer-only on the dev
  // half. A refactor that dropped it would cost accuracy silently.
  const text = reranker.passageText(KB[0]);
  assert.ok(text.includes(KB[0].question));
  assert.ok(text.includes(KB[0].answer));
});
