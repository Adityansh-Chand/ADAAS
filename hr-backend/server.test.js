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
    await postJson(baseUrl, '/leave-application', {
      employee_id: '1002',
      request_text: 'apply for 1 day annual leave',
    });

    // employee_id is now required, and this test used to call the route without
    // one -- which was how it passed while the handler returned everyone's
    // applications. The test encoded the bug: the route is wrapped in an
    // authorisation check on employee_id that the handler then ignored.
    const missing = await fetch(`${baseUrl}/leave-applications`);
    assert.equal(missing.status, 400);

    const response = await fetch(`${baseUrl}/leave-applications?employee_id=1001`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.ok(data.applications.length > 0);
    assert.ok(data.applications[0].reference_id);
    // The listing must be scoped, not merely filtered-looking.
    assert.ok(
      data.applications.every((a) => a.employee_id === '1001'),
      'another employee applications leaked into the response',
    );
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

  // 0.78, matching the gate in eval_intent.js -- see the note there on why a
  // 36-case probe cannot carry a tighter floor.
  const safe = 1 - (routedToAnAction / 36);
  assert.ok(safe >= 0.78,
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

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

const sessionModule = require('./session');

async function withSessions(fn) {
  const original = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-not-a-real-one';
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original;
  }
}

test('one employee cannot read another employee leave balance', async () => {
  // The bug this closes, and it did not need an identity provider to exist:
  // HR_EMPLOYEE_ID chose which employee the app displayed, and then every
  // endpoint accepted whatever employee_id the request carried. Editing a query
  // string was enough to read someone else's record.
  await withSessions(async () => {
    await withServer(async (baseUrl) => {
      const token = sessionModule.issue('1001');

      const own = await fetch(`${baseUrl}/leave-balance?employee_id=1001`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(own.status, 200);

      const other = await fetch(`${baseUrl}/leave-balance?employee_id=1002`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(other.status, 403);
      assert.match((await other.json()).error, /Not permitted/);
    });
  });
});

test('an approver may act for another employee, an employee may not', async () => {
  // The exemption is the reason `role` exists: approving someone else's leave is
  // an approver's whole function, so the rule cannot simply be "subject must
  // match" or the approval workflow stops working.
  await withSessions(async () => {
    await withServer(async (baseUrl) => {
      const approver = sessionModule.issue('9001', 'approver');
      const response = await fetch(`${baseUrl}/leave-balance?employee_id=1002`, {
        headers: { Authorization: `Bearer ${approver}` },
      });
      assert.equal(response.status, 200);
    });
  });
});

test('a tampered, expired or missing token is refused', async () => {
  await withSessions(async () => {
    await withServer(async (baseUrl) => {
      const good = sessionModule.issue('1001');

      const none = await fetch(`${baseUrl}/leave-balance?employee_id=1001`);
      assert.equal(none.status, 401);

      // Flip the last character of the signature.
      const last = good.slice(-1) === 'a' ? 'b' : 'a';
      const tampered = good.slice(0, -1) + last;
      const bad = await fetch(`${baseUrl}/leave-balance?employee_id=1001`, {
        headers: { Authorization: `Bearer ${tampered}` },
      });
      assert.equal(bad.status, 401);

      // Expiry is enforced, not decorative.
      const expired = sessionModule.issue('1001', 'employee', -60);
      assert.equal(sessionModule.verify(expired), null);
    });
  });
});

test('a forged payload without the signature is refused', async () => {
  // The attack a hand-rolled token invites: rewrite the claims, keep the shape.
  await withSessions(async () => {
    const forged = `${Buffer.from(JSON.stringify({
      sub: '9999', role: 'approver', exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url')}.not-a-signature`;
    assert.equal(sessionModule.verify(forged), null);
  });
});

test('with no secret set, scoping is off and /health says so', async () => {
  // The documented demo mode. It is a real weakness, and the point of asserting
  // it is that the weakness is *reported* rather than silently assumed.
  delete process.env.SESSION_SECRET;
  await withServer(async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.authorization, 'none');

    const other = await fetch(`${baseUrl}/leave-balance?employee_id=1002`);
    assert.equal(other.status, 200, 'demo mode deliberately does not scope');

    const session = await postJson(baseUrl, '/session', { employee_id: '1001' });
    assert.equal(session.status, 409);
  });
});

// ---------------------------------------------------------------------------
// The MongoDB path
//
// WHY THIS EXISTS, AND WHY IT DID NOT
//
// The README's second paragraph says "MongoDB is used when MONGODB_URI is
// configured and seeded in-memory data otherwise". Nine call sites in server.js
// branch on mongoUsable(), seven of them behavioural -- reading a balance,
// writing one, creating an application, listing them, recording a decision,
// storing a notification.
//
// Until this file, every one of the hundred-odd tests ran on the in-memory
// fallback and not one exercised any of it. The Atlas cluster this project used
// has been paused, so the path had not been run in a long time either. That is
// the exact shape of claim this repository polices everywhere else: a documented
// feature with no test, where nobody can say whether it works because nobody has
// asked.
//
// mongodb-memory-server runs a real mongod as a devDependency. Not a mock and not
// a fake driver: real mongoose models against a real server, so what passes here
// is what would happen against Atlas. It is dev-only, so it does not reach the
// production image -- the same rule the model tooling follows.
//
// Skipped rather than failed when the binary cannot be fetched, because an
// offline checkout should still be able to run the suite. Skipping prints, so it
// cannot be mistaken for passing.

const { seed: seedMongo, DEMO_USAGE, syntheticEmployees } = require('./scripts/seed_mongo');

let MongoMemoryServer = null;
try {
  ({ MongoMemoryServer } = require('mongodb-memory-server'));
} catch {
  // Left null; every test below reports the skip and returns.
}

const mongoose = require('mongoose');

async function withMongo(fn) {
  if (!MongoMemoryServer) {
    console.log('    (skipped: mongodb-memory-server is not installed)');
    return;
  }
  let mongod;
  try {
    mongod = await MongoMemoryServer.create();
  } catch (error) {
    console.log(`    (skipped: no mongod binary -- ${error.message.slice(0, 80)})`);
    return;
  }

  const previous = process.env.MONGODB_URI;
  const uri = mongod.getUri('adaas_test');
  process.env.MONGODB_URI = uri;
  try {
    // The server connects at require time, so reconnecting is what puts it on
    // the Mongo path for these tests. `app.__connectMongo` is exported for
    // exactly this -- a test that cannot reach the real branch is not testing it.
    const readyState = await app.__connectMongo();
    assert.equal(readyState, 1, 'mongoose must be connected, not still connecting');

    // Seeded, because a connected but EMPTY Mongo 404s every endpoint -- which is
    // what a fresh deployment did before scripts/seed_mongo.js existed, and a
    // test against an empty database would be measuring 404s.
    await seedMongo({ employees: 4, uri });
    await fn();
  } finally {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    if (previous === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previous;
    await mongod.stop();
  }
}

test('with Mongo connected, /health says mongodb rather than memory', async () => {
  await withMongo(async () => {
    await withServer(async (baseUrl) => {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.dataSource, 'mongodb');
    });
  });
});

test('a balance is read from and written to Mongo, not the in-memory seed',
  async () => {
    // The branch that matters most: if this silently used the fallback, an
    // application would appear to succeed and the stored balance would never move.
    await withMongo(async () => {
      await withServer(async (baseUrl) => {
        const before = await (await fetch(
          `${baseUrl}/leave-balance?employee_id=1001`,
        )).json();
        // The seeded value, which must be the same one the in-memory path uses --
        // switching MONGODB_URI on and off must not change the numbers.
        assert.equal(before.used.casual_leave, DEMO_USAGE[1001].casualLeaveUsed);

        const applied = await postJson(baseUrl, '/leave-application', {
          employee_id: '1001',
          request_text: 'apply for 1 day casual leave',
        });
        assert.equal(applied.status, 200);

        const after = await (await fetch(
          `${baseUrl}/leave-balance?employee_id=1001`,
        )).json();
        assert.equal(
          after.used.casual_leave,
          DEMO_USAGE[1001].casualLeaveUsed + 1,
          'the balance must move in Mongo, not just in the response',
        );

        // And it is genuinely in the collection, not in the fallback array.
        const stored = await mongoose.connection
          .collection('leavebalances').findOne({ employeeId: '1001' });
        assert.ok(stored, 'no LeaveBalance document was written');
        assert.equal(stored.casualLeaveUsed, DEMO_USAGE[1001].casualLeaveUsed + 1);
      });
    });
  });

test('an application is persisted and listed from Mongo', async () => {
  await withMongo(async () => {
    await withServer(async (baseUrl) => {
      const applied = await (await postJson(baseUrl, '/leave-application', {
        employee_id: '1002',
        request_text: 'apply for 1 day casual leave',
      })).json();
      assert.ok(applied.reference_id, 'no reference id issued');

      const listed = await (await fetch(
        `${baseUrl}/leave-applications?employee_id=1002`,
      )).json();
      assert.equal(listed.applications.length, 1);
      assert.equal(listed.applications[0].reference_id, applied.reference_id);

      const stored = await mongoose.connection
        .collection('leaveapplications').findOne({ referenceId: applied.reference_id });
      assert.ok(stored, 'no LeaveApplication document was written');
    });
  });
});

test('a rejection returns the days to the balance stored in Mongo', async () => {
  // The invariant the whole approval workflow rests on, checked against the
  // database rather than against the response body.
  await withMongo(async () => {
    await withServer(async (baseUrl) => {
      const applied = await (await postJson(baseUrl, '/leave-application', {
        employee_id: '2001',
        request_text: 'apply for 2 days casual leave',
      })).json();

      const seeded = syntheticEmployees(4)['2001'].casualLeaveUsed;
      const midway = await mongoose.connection
        .collection('leavebalances').findOne({ employeeId: '2001' });
      assert.equal(midway.casualLeaveUsed, seeded + 2);

      const decided = await postJson(
        baseUrl, `/leave-applications/${applied.reference_id}/decision`,
        { decision: 'rejected', decided_by: '9001' },
      );
      assert.equal(decided.status, 200);

      const after = await mongoose.connection
        .collection('leavebalances').findOne({ employeeId: '2001' });
      assert.equal(after.casualLeaveUsed, seeded, 'a rejection must return the days');
    });
  });
});

test('Mongo holds many employees independently', async () => {
  // The in-memory seed has two employees. A real deployment has as many as the
  // organisation does, and this is the check that they do not share a document --
  // a unique index on employeeId is easy to get wrong and the failure looks like
  // one person's leave moving when another files.
  await withMongo(async () => {
    await withServer(async (baseUrl) => {
      // The four synthetic employees the seeder wrote, plus the two demo ones.
      const synthetic = syntheticEmployees(4);
      const ids = Object.keys(synthetic);
      const before = Object.fromEntries(
        ids.map((id) => [id, synthetic[id].casualLeaveUsed]),
      );

      // One employee files twice, the rest once. If documents were shared -- a
      // missing unique index is the usual cause -- one person's leave would move
      // when another filed, and that is invisible with only two employees.
      for (const id of ids) {
        await postJson(baseUrl, '/leave-application', {
          employee_id: id,
          request_text: 'apply for 1 day casual leave',
        });
      }
      await postJson(baseUrl, '/leave-application', {
        employee_id: ids[0],
        request_text: 'apply for 1 day casual leave',
      });

      for (const id of ids) {
        const r = await (await fetch(`${baseUrl}/leave-balance?employee_id=${id}`)).json();
        const expected = before[id] + (id === ids[0] ? 2 : 1);
        assert.equal(r.used.casual_leave, expected,
          `employee ${id} should have used ${expected}, not ${r.used.casual_leave}`);
      }

      const count = await mongoose.connection
        .collection('leavebalances').countDocuments({});
      assert.equal(count, ids.length + Object.keys(DEMO_USAGE).length,
        'one document per employee, no sharing');
    });
  });
});

test('a connected but empty Mongo 404s everything, which is why the seeder exists',
  async () => {
    // The finding that produced scripts/seed_mongo.js. Nothing in this repository
    // ever wrote an employee into Mongo, so pointing MONGODB_URI at a working but
    // empty database made every endpoint 404 -- and it went unnoticed because
    // every other test runs on the in-memory fallback.
    //
    // The 404 itself is correct: an unknown employee id must not silently receive
    // a full entitlement. The gap was that there was no way to make one known.
    if (!MongoMemoryServer) {
      console.log('    (skipped: mongodb-memory-server is not installed)');
      return;
    }
    let mongod;
    try {
      mongod = await MongoMemoryServer.create();
    } catch (error) {
      console.log(`    (skipped: no mongod binary -- ${error.message.slice(0, 60)})`);
      return;
    }
    const previous = process.env.MONGODB_URI;
    process.env.MONGODB_URI = mongod.getUri('adaas_empty');
    try {
      assert.equal(await app.__connectMongo(), 1);
      await withServer(async (baseUrl) => {
        const balance = await fetch(`${baseUrl}/leave-balance?employee_id=1001`);
        assert.equal(balance.status, 404);
        const applied = await postJson(baseUrl, '/leave-application', {
          employee_id: '1001',
          request_text: 'apply for 1 day casual leave',
        });
        assert.equal(applied.status, 404);
      });

      // And seeding makes the same database usable, which is the whole claim.
      await seedMongo({ uri: process.env.MONGODB_URI });
      await withServer(async (baseUrl) => {
        const balance = await fetch(`${baseUrl}/leave-balance?employee_id=1001`);
        assert.equal(balance.status, 200);
      });
    } finally {
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect().catch(() => {});
      if (previous === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = previous;
      await mongod.stop();
    }
  });

test('the Mongo seed and the in-memory seed agree', () => {
  // Two seed sets that drift apart is how "it works on my machine" is earned,
  // and this project already had one instance of demo data contradicting the
  // policy text it quoted. Switching MONGODB_URI on and off must not change the
  // numbers a reviewer sees.
  const inMemory = app.__seededUsage();
  for (const [id, usage] of Object.entries(DEMO_USAGE)) {
    assert.equal(usage.casualLeaveUsed, inMemory[id].casual_leave,
      `employee ${id}: casual leave differs between the two seeds`);
    assert.equal(
      usage.combinedAnnualSickLeaveUsed, inMemory[id].combined_annual_sick_leave,
      `employee ${id}: combined leave differs between the two seeds`,
    );
  }
  assert.deepEqual(
    Object.keys(DEMO_USAGE).sort(), Object.keys(inMemory).sort(),
    'the two seeds must cover the same employees',
  );
});

test('falling back to memory is a reported state, not a silent one', async () => {
  // The other half of the claim. With no MONGODB_URI the service must run on
  // seeded data AND say so -- a deployment that thinks it is persisting and is
  // not is the worst of the three outcomes.
  const previous = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    await mongoose.disconnect().catch(() => {});
    await withServer(async (baseUrl) => {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.dataSource, 'memory');
      const balance = await (await fetch(
        `${baseUrl}/leave-balance?employee_id=1001`,
      )).json();
      assert.ok(balance.casual_leave_balance <= ENTITLEMENTS.casual_leave.days);
    });
  } finally {
    if (previous !== undefined) process.env.MONGODB_URI = previous;
  }
});

// ---------------------------------------------------------------------------
// Delivery, secrets, and who owns the corpus
// ---------------------------------------------------------------------------

const smtpModule = require('./smtp');
const secretsModule = require('./secrets');
const corpusModule = require('./corpus');

/**
 * A real SMTP server, speaking the real protocol, that keeps what it is sent.
 *
 * Not a mock of the client: `smtp.js` runs unmodified and drives the actual
 * exchange -- EHLO, MAIL FROM, RCPT TO, DATA, QUIT. Only the relay is local,
 * which is the one part that cannot be present here.
 */
function smtpSink({ failAt = null } = {}) {
  const received = [];
  const server = require('node:net').createServer((socket) => {
    let inData = false;
    let message = '';
    let envelope = {};
    socket.setEncoding('utf8');
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.split('\r\n')) {
        if (line === '' && !inData) continue;
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push({ ...envelope, message });
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            message += `${line}\r\n`;
          }
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (failAt && verb === failAt) { socket.write('550 refused\r\n'); continue; }
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-sink\r\n250 SIZE 10240000\r\n');
        } else if (verb === 'STARTTLS') {
          // Declined, which exercises the branch where the upgrade does not
          // happen and credentials must therefore not be sent.
          socket.write('454 TLS not available\r\n');
        } else if (verb === 'MAIL') {
          envelope = { from: line, to: null }; message = ''; socket.write('250 Ok\r\n');
        } else if (verb === 'RCPT') {
          envelope.to = line; socket.write('250 Ok\r\n');
        } else if (verb === 'DATA') {
          inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 Bye\r\n'); socket.end();
        } else {
          socket.write('250 Ok\r\n');
        }
      }
    });
  });
  return {
    received,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return server.address().port;
    },
    stop() { return new Promise((r) => server.close(r)); },
  };
}

async function withSmtp(sink, env, fn) {
  const port = await sink.start();
  const saved = { ...process.env };
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(port),
    SMTP_SECURE: 'false',
    SMTP_STARTTLS: 'false',
    SMTP_FROM: 'adaas@example.test',
    ...env,
  });
  try {
    await fn(port);
  } finally {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_STARTTLS',
      'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'NOTIFY_EMAIL_TO']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await sink.stop();
  }
}

test('a decision reaches a real SMTP relay', async () => {
  // The gap this closes: a decision was recorded in a table and nobody was told
  // unless they happened to open the app and look.
  const sink = smtpSink();
  await withSmtp(sink, {}, async () => {
    const result = await smtpModule.send({
      to: 'hr@example.test',
      subject: 'Leave approved: LMS-TEST',
      text: 'Your request for 1 day(s) of Casual Leave was approved.',
    });
    assert.equal(result.ok, true);
    assert.equal(sink.received.length, 1);

    const sent = sink.received[0];
    assert.match(sent.to, /hr@example\.test/);
    assert.match(sent.from, /adaas@example\.test/);
    // Base64 with an explicit charset, so a non-ASCII policy name survives a
    // 7-bit relay rather than arriving mangled.
    assert.match(sent.message, /Content-Transfer-Encoding: base64/);
    const body = sent.message.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    assert.match(
      Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
      /approved/,
    );
  });
});

test('credentials are never sent over an unencrypted connection', async () => {
  // The check worth having in hand-rolled SMTP. The sink declines STARTTLS, so
  // the connection stays plaintext -- and AUTH must refuse rather than proceed.
  const sink = smtpSink();
  await withSmtp(sink, {
    SMTP_STARTTLS: 'true', SMTP_USER: 'someone', SMTP_PASS: 'a-password',
  }, async () => {
    await assert.rejects(
      () => smtpModule.send({ to: 'hr@example.test', subject: 's', text: 't' }),
      /refusing to send SMTP credentials over an unencrypted connection/,
    );
    // And nothing was queued.
    assert.equal(sink.received.length, 0);
  });
});

test('a rejected recipient surfaces as a failure, not a silent success', async () => {
  const sink = smtpSink({ failAt: 'RCPT' });
  await withSmtp(sink, {}, async () => {
    await assert.rejects(
      () => smtpModule.send({ to: 'nobody@example.test', subject: 's', text: 't' }),
      /RCPT got 550/,
    );
  });
});

test('a body line of a single dot cannot truncate the message', () => {
  // Dot-stuffing. Without it, a line containing only "." ends DATA early: the
  // message is truncated and everything after it is read as SMTP commands. It is
  // a message-splitting bug with a security flavour, and it is the classic
  // hand-written-SMTP mistake.
  const stuffed = smtpModule.dotStuff('first\r\n.\r\nlast');
  assert.equal(stuffed, 'first\r\n..\r\nlast');
  assert.ok(!/\r\n\.\r\n/.test(stuffed), 'a bare dot line must not survive');
});

test('a secret in a file beats one in the environment', async () => {
  // Precedence, not fallback. If both are set the file is the deliberate
  // configuration and the variable is usually left over from a compose file
  // nobody updated -- preferring the environment would make a mounted secret
  // silently ineffective, which is the worst of the four outcomes.
  const file = path.join(require('node:os').tmpdir(), `adaas-secret-${process.pid}`);
  fs.writeFileSync(file, 'from-the-file\n');
  try {
    const env = { API_KEY: 'from-the-environment', API_KEY_FILE: file };
    assert.equal(secretsModule.read('API_KEY', env), 'from-the-file');

    secretsModule.resolveAll(env);
    assert.equal(env.API_KEY, 'from-the-file');
    assert.deepEqual(secretsModule.status(env).from_file, ['API_KEY']);
  } finally {
    fs.unlinkSync(file);
  }
});

test('an unreadable secret file refuses rather than falling back', () => {
  // A broken secret mount must not degrade to whatever stale value is around --
  // the service would come up looking healthy with the wrong credential.
  const env = { API_KEY: 'stale', API_KEY_FILE: '/definitely/not/here' };
  assert.throws(() => secretsModule.read('API_KEY', env), /could not be read/);
});

test('the corpus validates against its declared schema', () => {
  const meta = corpusModule.loadMeta();
  assert.ok(meta, 'the corpus must have a governance record');
  assert.deepEqual(corpusModule.validate(KB, meta), []);
});

test('the governance digest agrees with the one the vectors were built from', () => {
  // Two independently maintained files describing the same corpus. They are
  // computed separately on purpose -- a shared helper would keep them agreeing
  // even if the helper itself were wrong -- and the first version of corpus.js
  // hashed different fields and disagreed, which is the drift this catches.
  const committed = evalFileRaw('embeddings.json');
  assert.equal(corpusModule.digestOf(KB), committed.corpus_digest);
  assert.equal(corpusModule.loadMeta().content_digest, committed.corpus_digest);
});

test('an edited corpus fails the governance check', () => {
  // Mutation test: the check must be able to fail. A corpus edited without
  // updating the governance record means last_reviewed now refers to different
  // text, which is precisely the silent staleness this exists to prevent.
  const edited = KB.map((e, i) => (i === 0 ? { ...e, answer: `${e.answer} EDITED` } : e));
  const problems = corpusModule.validate(edited, corpusModule.loadMeta());
  assert.ok(problems.some((p) => /content_digest/.test(p)), problems.join('; '));

  const missingField = KB.map((e, i) => (i === 0 ? { ...e, answer: '' } : e));
  assert.ok(
    corpusModule.validate(missingField, corpusModule.loadMeta())
      .some((p) => /missing or empty answer/.test(p)),
  );

  const badCategory = KB.map((e, i) => (i === 0 ? { ...e, category: 'Medcial' } : e));
  assert.ok(
    corpusModule.validate(badCategory, corpusModule.loadMeta())
      .some((p) => /not in the declared list/.test(p)),
  );
});

test('the corpus reports an owner and a review age, and does not invent one', () => {
  // UNASSIGNED is the honest value. An invented owner reads as accountability
  // while providing none, which is worse than an empty field.
  const status = corpusModule.status(KB);
  assert.equal(status.governed, true);
  assert.equal(status.digest_matches, true);
  assert.equal(typeof status.review_age_days, 'number');
  assert.equal(typeof status.review_overdue, 'boolean');
  assert.equal(status.owner_assigned, status.owner !== 'UNASSIGNED');
  assert.match(status.provenance, /synthetic/);
});

// ---------------------------------------------------------------------------
// Identity: verifying a token from a provider
// ---------------------------------------------------------------------------

const oidcModule = require('./oidc');

/**
 * A stand-in identity provider: a real RSA key pair, a real discovery document
 * and a real JWKS, served over HTTP.
 *
 * This is not a mock of the verifier -- the verifier runs unmodified and does its
 * own fetching, key selection and signature check. What is faked is only the
 * provider, which is the one part that cannot be present on this machine. Every
 * check below therefore exercises the code that would run against Okta or Entra.
 */
function fakeIdp({ kid = 'test-key-1' } = {}) {
  const { publicKey, privateKey } = require('node:crypto').generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  let issuer;
  const server = require('node:http').createServer((req, res) => {
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/openid-configuration') {
      send({ issuer, jwks_uri: `${issuer}/jwks` });
      return;
    }
    if (req.url === '/jwks') { send({ keys: [jwk] }); return; }
    res.writeHead(404); res.end();
  });

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  return {
    async start() {
      await new Promise((resolve) => server.listen(0, resolve));
      issuer = `http://127.0.0.1:${server.address().port}`;
      return issuer;
    },
    stop() { return new Promise((resolve) => server.close(resolve)); },
    /** Sign a token. Overrides let a test break exactly one thing at a time. */
    mint(claims = {}, { header = {}, tamper = false, key = privateKey } = {}) {
      const now = Math.floor(Date.now() / 1000);
      const h = b64({ alg: 'RS256', typ: 'JWT', kid, ...header });
      const p = b64({
        iss: issuer,
        aud: 'adaas',
        sub: '1001',
        exp: now + 3600,
        iat: now,
        ...claims,
      });
      if (header.alg === 'none') return `${h}.${p}.`;
      const sig = require('node:crypto')
        .sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key)
        .toString('base64url');
      if (!tamper) return `${h}.${p}.${sig}`;
      // Replace the last character with a DIFFERENT one. The first version
      // appended 'A' unconditionally, so on a run where the real signature
      // already ended in 'A' the tamper was a no-op, the signature verified, and
      // the test failed for lack of the rejection it was asserting. The RSA key
      // is generated per run, so it passed locally and failed in CI -- a flaky
      // test of the test's own making, not a defect in the verifier.
      const last = sig.slice(-1);
      return `${h}.${p}.${sig.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    },
  };
}

async function withIdp(fn, env = {}) {
  const idp = fakeIdp();
  const issuer = await idp.start();
  const saved = { ...process.env };
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_AUDIENCE = 'adaas';
  Object.assign(process.env, env);
  oidcModule.__clearCache();
  try {
    await fn(idp, issuer);
  } finally {
    for (const k of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_EMPLOYEE_CLAIM',
      'OIDC_ROLE_CLAIM', 'SESSION_SECRET']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    oidcModule.__clearCache();
    await idp.stop();
  }
}

test('a valid ID token authenticates, and scoping still applies', async () => {
  // The half that was missing. session.js already enforced that a caller may only
  // act for its own subject; what it could not do was establish who the caller is,
  // because /session mints a token for any employee id it is asked for.
  await withIdp(async (idp) => {
    await withServer(async (baseUrl) => {
      const token = idp.mint({ sub: '1001' });

      const own = await fetch(`${baseUrl}/leave-balance?employee_id=1001`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(own.status, 200);

      // Verified identity does not mean unlimited authority.
      const other = await fetch(`${baseUrl}/leave-balance?employee_id=1002`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(other.status, 403);
    });
  });
});

test('a token signed by the wrong key is refused', async () => {
  await withIdp(async (idp) => {
    const other = require('node:crypto').generateKeyPairSync('rsa', {
      modulusLength: 2048,
    }).privateKey;
    await assert.rejects(
      () => oidcModule.verifyIdToken(idp.mint({}, { key: other })),
      /signature does not verify/,
    );
  });
});

test('alg none and a tampered signature are both refused', async () => {
  // The two classic JWT forgeries. `alg: none` works when a verifier reads the
  // algorithm out of the token it is verifying, which is why this one is pinned.
  await withIdp(async (idp) => {
    await assert.rejects(
      () => oidcModule.verifyIdToken(idp.mint({}, { header: { alg: 'none' } })),
      /unsupported alg/,
    );
    await assert.rejects(
      () => oidcModule.verifyIdToken(idp.mint({}, { tamper: true })),
      /signature does not verify/,
    );
  });
});

test('a token for another application is refused', async () => {
  // Cross-application confusion: a correctly signed, unexpired token from the
  // same provider, issued for something else entirely.
  await withIdp(async (idp) => {
    await assert.rejects(
      () => oidcModule.verifyIdToken(idp.mint({ aud: 'some-other-app' })),
      /does not include adaas/,
    );
  });
});

test('an expired token is refused, and clock skew is bounded', async () => {
  await withIdp(async (idp) => {
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(
      () => oidcModule.verifyIdToken(idp.mint({ exp: now - 3600 })),
      /expired/,
    );
    // Inside the allowance, a just-expired token still passes -- deliberate, and
    // bounded, because a zero allowance rejects valid tokens intermittently when
    // two clocks differ by seconds.
    const justExpired = idp.mint({ exp: now - 5 });
    const ok = await oidcModule.verifyIdToken(justExpired);
    assert.equal(ok.employeeId, '1001');
  });
});

test('the employee id comes from a configurable claim', async () => {
  // Mapping a directory identity onto an HR employee number is a deployment
  // concern with no correct universal answer, so it is a setting. A token with
  // nothing in the configured claim is refused rather than defaulted.
  await withIdp(async (idp) => {
    const found = await oidcModule.verifyIdToken(
      idp.mint({ employee_number: '1002' }),
    );
    assert.equal(found.employeeId, '1002');

    await assert.rejects(
      () => oidcModule.verifyIdToken(idp.mint({ employee_number: undefined })),
      /has no employee_number claim/,
    );
  }, { OIDC_EMPLOYEE_CLAIM: 'employee_number' });
});

test('a provider claiming a different issuer is refused', async () => {
  // A discovery document naming an issuer other than the configured one is either
  // a misconfiguration or a redirect somewhere unintended. Both are refusals.
  await withIdp(async (idp, issuer) => {
    process.env.OIDC_ISSUER = `${issuer}/tenant-two`;
    oidcModule.__clearCache();
    await assert.rejects(() => oidcModule.fetchKeys(), /returned 404|names issuer/);
  });
});

test('an unknown role claim does not become approver', async () => {
  // The dangerous default. If the role claim is missing or unrecognised the
  // principal must be an employee, because defaulting to approver would let any
  // authenticated person act for anyone else.
  await withIdp(async (idp) => {
    await withServer(async (baseUrl) => {
      const token = idp.mint({ sub: '1001', adaas_role: 'superuser' });
      const other = await fetch(`${baseUrl}/leave-balance?employee_id=1002`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(other.status, 403, 'an unrecognised role must not grant authority');
    });
  });
});

test('health names which identity path is live', async () => {
  await withIdp(async () => {
    await withServer(async (baseUrl) => {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.authorization, 'oidc');
      assert.equal(health.identity.configured, true);
      assert.equal(health.identity.employee_claim, 'sub');
    });
  });
});

// ---------------------------------------------------------------------------
// Where the models live
// ---------------------------------------------------------------------------

const modelClient = require('./model_client');

test('a configured model service becomes the only source, with no silent fallback',
  async () => {
    // The property worth protecting. Two sources that can substitute for each
    // other without saying so is how a deployment ends up serving vectors from a
    // different model than it reports -- and the committed vectors are verified
    // against one specific model, so the swap would be invisible and wrong.
    //
    // This machine HAS the local package, which is what makes the test
    // meaningful: with MODEL_SERVICE_URL pointing at nothing, the local model
    // must not quietly take over.
    const original = process.env.MODEL_SERVICE_URL;
    process.env.MODEL_SERVICE_URL = 'http://127.0.0.1:1';
    try {
      assert.equal(modelClient.activeSource(), 'service');
      await assert.rejects(
        () => modelClient.embedQueries(['anything']),
        (error) => {
          assert.equal(error.name, 'ModelSourceUnavailable');
          assert.match(error.message, /unreachable/);
          return true;
        },
      );
    } finally {
      if (original === undefined) delete process.env.MODEL_SERVICE_URL;
      else process.env.MODEL_SERVICE_URL = original;
    }
  });

test('the model source is reported rather than inferred', async () => {
  // /health used to say which retrieval mode was live but not where the vectors
  // came from, so "dense" meant two different deployments -- one with an
  // in-process model, one talking to a service -- and nothing distinguished them.
  await withServer(async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.ok(['service', 'local', 'none'].includes(health.retrieval.model_source),
      `unexpected model_source ${health.retrieval.model_source}`);
  });
});

test('the model service startup check catches a model mismatch', async () => {
  // The failure this exists to catch is quiet: a service upgraded to a different
  // encoder returns vectors of the right shape that no longer compare with the
  // committed ones, and retrieval is merely worse. Better to refuse at startup.
  const original = process.env.MODEL_SERVICE_URL;
  const fake = require('node:http').createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      embedding_model: 'some/other-encoder',
      rerank_model: modelClient.RERANK_MODEL_ID,
    }));
  });
  await new Promise((resolve) => fake.listen(0, resolve));
  process.env.MODEL_SERVICE_URL = `http://127.0.0.1:${fake.address().port}`;
  try {
    const result = await modelClient.checkService();
    assert.equal(result.ok, false);
    assert.match(result.reason, /model mismatch/);
    assert.match(result.reason, /some\/other-encoder/);
  } finally {
    if (original === undefined) delete process.env.MODEL_SERVICE_URL;
    else process.env.MODEL_SERVICE_URL = original;
    await new Promise((resolve) => fake.close(resolve));
  }
});

test('the model service speaks the shape the client expects', async () => {
  // A contract test across the process boundary, without loading a model: the
  // service is required in-process and its request validation is exercised. It
  // is the argument shapes that drift, not the arithmetic.
  //
  // Skipped rather than failed when model-service/node_modules is absent. It is
  // a separate package with its own dependencies -- that separation is the whole
  // point of it -- so a checkout that has only run `npm ci` in hr-backend cannot
  // load it. Skipping loudly is right here; silently passing would not be, which
  // is why this prints.
  let service;
  try {
    service = require('../model-service/server');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    console.log('    (skipped: run `npm ci` in model-service/ to exercise this)');
    return;
  }
  const server = service.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    // The three constants that must agree across the boundary.
    assert.equal(health.embedding_model, modelClient.MODEL_ID);
    assert.equal(health.rerank_model, modelClient.RERANK_MODEL_ID);
    assert.equal(health.query_prefix, embeddingsModule.QUERY_PREFIX);

    // bge is asymmetric, so `kind` is required and an unknown value is refused
    // rather than defaulted -- getting the side wrong is silent and costs
    // accuracy.
    const bad = await fetch(`${base}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['x'], kind: 'sideways' }),
    });
    assert.equal(bad.status, 400);

    const noTexts = await fetch(`${base}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: [], kind: 'query' }),
    });
    assert.equal(noTexts.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
    'held_out_intent_queries_4.json', 'held_out_intent_queries_5.json',
    'held_out_intent_queries_6.json']) {
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

// ---------------------------------------------------------------------------
// The answer layer
//
// Everything above this point tests the machinery that decides WHICH policy
// comes back. These test what the employee reads, which nothing verified until
// answers.js existed. The distinction matters more than it sounds: a retrieval
// miss announces itself as "no matching policy", and a generated answer with the
// wrong entitlement announces nothing at all.

const answersModule = require('./answers');

test('the quantity extractor finds numbers behind a modifier', () => {
  // The gate found this, not inspection. The first version required the unit to
  // follow the number directly and silently missed three load-bearing figures:
  // the 2-consecutive-day cap on casual leave, the 3-day medical certificate
  // threshold, and the 3-day absence that counts as job abandonment. Any of them
  // could have been changed to any value with no check noticing.
  const found = answersModule.quantities(
    'Maximum of 2 consecutive days allowed. Sick leave >3 consecutive days '
    + 'requires a certificate. Reimbursed within 10 working days.',
  ).map((q) => `${q.value} ${q.unit}`);
  assert.deepEqual(found, ['2 day', '3 day', '10 day']);
});

test('the quantity extractor does not invent quantities from clock times', () => {
  // The other half, and the reason the modifier list is closed rather than a
  // wildcard. A false quantity is worse than a missed one: it fires on true
  // policy text, and the control gate forbids that outright.
  const text = 'Core operating hours are typically 9:00 AM - 6:00 PM. '
    + '3+ late entries/month may result in warnings.';
  assert.deepEqual(answersModule.quantities(text), []);
});

test('a number absent from the context is reported as unsupported', () => {
  const context = 'Source: Leave Policy\nPolicy Details: Entitlement: 4 days per year.';
  const verdict = answersModule.verify(
    'You get 5 days of casual leave per year.', { context, sources: [] },
  );
  assert.equal(verdict.grounded, false);
  assert.ok(verdict.findings.some((f) => f.check === 'unsupported_number'));
});

test('a REAL number bound to the wrong entitlement is still caught', () => {
  // The case that justifies entitlementConflicts existing separately from the
  // unsupported-number check. 18 is a genuine corpus figure and is almost always
  // in the retrieved context, because dense retrieval pulls the whole leave
  // family -- so "18 days of casual leave" quotes the context accurately and is
  // still false. A check that only asked "is this number present" would pass it.
  const context = 'Source: Leave Policy\nPolicy Details: Casual: 4 days per year. '
    + 'Combined annual/sick: 18 days per year.';
  const verdict = answersModule.verify(
    'You are entitled to 18 days of casual leave per year.',
    { context, sources: [] },
  );
  assert.equal(verdict.grounded, false);
  const conflict = verdict.findings.find((f) => f.check === 'entitlement_conflict');
  assert.ok(conflict, 'the wrong-pool binding was not reported');
  assert.match(conflict.detail, /policy_003_cl says 4/);
  // And specifically NOT as an unsupported number, because 18 is supported.
  assert.ok(!verdict.findings.some((f) => f.check === 'unsupported_number'));
});

test('a sentence naming two leave types is not guessed at', () => {
  // With both leave types in one sentence there is no basis for binding a number
  // to either, and reporting a conflict would be a guess. Across a whole answer
  // both types and both figures co-occur constantly.
  const context = 'Policy Details: Casual: 4 days. Combined: 18 days.';
  const verdict = answersModule.verify(
    'Casual leave and sick leave together give you 18 days per year.',
    { context, sources: [] },
  );
  assert.ok(!verdict.findings.some((f) => f.check === 'entitlement_conflict'));
});

test('a cited source that was never retrieved is reported', () => {
  const verdict = answersModule.verify(
    'Casual leave is 4 days. Source: Employee Handbook Addendum, Section 47.3',
    {
      context: 'Policy Details: Entitlement: 4 days per year.',
      sources: ['Leave Policy, Section 3.0'],
    },
  );
  assert.ok(verdict.findings.some((f) => f.check === 'fabricated_citation'));
});

test('a genuinely retrieved source is not reported as fabricated', () => {
  const source = 'Corporate Code of Conduct, Section 1.0';
  const verdict = answersModule.verify(
    `Confidential information must not be disclosed. Source: ${source}`,
    { context: `Source: ${source}\nPolicy Details: ...`, sources: [source] },
  );
  assert.ok(!verdict.findings.some((f) => f.check === 'fabricated_citation'));
});

test('every real corpus answer passes every check against its own context', () => {
  // The control gate, as a unit test rather than only inside the eval. A verifier
  // that flags true policy text has no usable operating point, and it is the one
  // failure that would make everything in eval/answer_report.json meaningless --
  // a check that fires on everything detects every mutation.
  const dense = require('./dense');
  const store = dense.loadVectors();
  const { contextFor } = require('./scripts/eval_answers');
  for (const entry of KB) {
    const { context, sources } = contextFor(entry.id, KB, store);
    const verdict = answersModule.verify(entry.answer, { context, sources });
    assert.equal(
      verdict.grounded, true,
      `${entry.id} was flagged: ${JSON.stringify(verdict.findings)}`,
    );
    assert.equal(verdict.verbatim, true, `${entry.id} is not verbatim in its own context`);
  }
});

test('the mutation suite is deterministic and covers every declared class', () => {
  // Regenerated from the corpus on every run rather than stored, so it cannot
  // drift from the policy text -- which means it has to be reproducible or the
  // reported detection rates move for no reason. They already did once: the
  // generator picked one swap target per document by Set iteration order, and an
  // unrelated widening of the quantity extractor moved swapped_number detection
  // by 30 points with no check changing.
  const { buildMutations, PREDICTIONS } = require('./scripts/eval_answers');
  const first = buildMutations(KB);
  const second = buildMutations(KB);
  assert.deepEqual(first, second, 'the mutation suite is not deterministic');
  assert.ok(first.length > 100, `only ${first.length} mutations generated`);

  const classes = new Set(first.map((m) => m.cls));
  for (const cls of Object.keys(PREDICTIONS)) {
    assert.ok(classes.has(cls), `${cls} has a declared prediction but no mutations`);
  }
  for (const cls of classes) {
    assert.ok(PREDICTIONS[cls], `${cls} has mutations but no declared prediction`);
  }
});

test('every mutation actually changes the answer it mutates', () => {
  // A mutation identical to the original is scored as an undetected unfaithful
  // answer: it drags the reported rate down while testing nothing. The
  // dropped_condition class is the one at risk, since it works by removing a
  // sentence that may not be present.
  const { buildMutations } = require('./scripts/eval_answers');
  const byId = new Map(KB.map((e) => [e.id, e]));
  for (const m of buildMutations(KB)) {
    const original = byId.get(m.policyId);
    if (!original) continue;
    // Written from scratch rather than derived, so there is nothing to compare.
    if (m.cls === 'entitlement_swap') continue;
    assert.notEqual(
      m.answer, original.answer,
      `${m.cls} on ${m.policyId} did not change anything: ${m.note}`,
    );
  }
});

test('the extractive path returns no verification verdict', async () => {
  // With no LLM_PROVIDER the answer IS the retrieved policy text, so there is
  // nothing to verify. Returning a grounded verdict on an identity would tell a
  // reader the generative path had been checked when it has not been, which is
  // the specific misreading this whole section exists to prevent.
  await withServer(async (baseUrl) => {
    const body = await (await postJson(baseUrl, '/chat', {
      message: 'How many casual leave days do I get?',
    })).json();
    assert.equal(body.generated_by, 'knowledge_base');
    assert.equal(
      body.verified, undefined,
      'the extractive path must not report a verification verdict',
    );
  });
});

test('a model-written answer is verified, and a bad one is flagged', async () => {
  // The guard in the request path, exercised end to end against a stubbed
  // provider so no key and no network are involved. Two things are asserted: that
  // a verdict appears at all for a generated answer, and that a finding does NOT
  // suppress the answer -- the exact checks have a measured sensitivity of 0.3867
  // and turning a false positive into a refusal to answer would make the guard
  // worse than not having one.
  const previous = {
    provider: process.env.LLM_PROVIDER,
    key: process.env.LLM_API_KEY,
    base: process.env.LLM_BASE_URL,
  };
  const realFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_API_KEY = 'test-key-not-a-real-one';
  process.env.LLM_BASE_URL = 'http://127.0.0.1:9';

  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:9')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: 'You are entitled to 99 days of casual leave per year. '
                + 'Source: Imaginary Manual, Section 12.5',
            },
          }],
        }),
      };
    }
    return realFetch(url, options);
  };

  try {
    await withServer(async (baseUrl) => {
      const body = await (await postJson(baseUrl, '/chat', {
        message: 'How many casual leave days do I get?',
      })).json();
      assert.equal(body.generated_by, 'openai');
      assert.ok(body.verified, 'a generated answer must carry a verdict');
      assert.equal(body.verified.grounded, false);
      const checks = body.verified.findings.map((f) => f.check);
      assert.ok(checks.includes('unsupported_number'), JSON.stringify(checks));
      assert.ok(checks.includes('fabricated_citation'), JSON.stringify(checks));
      // The answer is still returned. Flagging is not refusing.
      assert.match(body.answer, /99 days/);

      const metrics = await (await fetch(`${baseUrl}/metrics`)).json();
      assert.ok(metrics.counters.answers_verified_total >= 1);
      assert.ok(metrics.counters.answers_flagged_total >= 1);
    });
  } finally {
    globalThis.fetch = realFetch;
    if (previous.provider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previous.provider;
    if (previous.key === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previous.key;
    if (previous.base === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = previous.base;
  }
});
