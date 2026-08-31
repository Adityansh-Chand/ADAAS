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
