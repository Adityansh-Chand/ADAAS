'use strict';

/**
 * End-to-end smoke test against a running server.
 *
 * The previous version only checked `response.ok`, so it printed "smoke test
 * passed" whether /chat returned a real policy answer or
 * "I couldn't find a matching company policy for that question" -- which, for
 * most real queries, is what it returned. A check that passes in both the
 * working and the broken case is not a check.
 *
 * Every assertion here is about content.
 */

const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const apiKey = process.env.API_KEY || '';

const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (apiKey) headers['X-API-Key'] = apiKey;

  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, headers: response.headers };
}

async function main() {
  // --- readiness ---
  const health = await request('/health');
  check('health returns 200', health.status === 200, `status ${health.status}`);
  check('health reports ready', health.body?.status === 'running',
    JSON.stringify(health.body));
  check('health reports a loaded corpus',
    (health.body?.knowledgeBase?.entries || 0) > 0,
    JSON.stringify(health.body?.knowledgeBase));

  const live = await request('/live');
  check('liveness returns 200', live.status === 200, `status ${live.status}`);

  // --- request id propagation ---
  const traced = await request('/health', { headers: { 'X-Request-ID': 'smoke-1' } });
  check('request id is echoed',
    traced.headers.get('x-request-id') === 'smoke-1',
    traced.headers.get('x-request-id'));

  // --- leave balance ---
  const balance = await request('/leave-balance?employee_id=1001');
  check('leave balance returns 200', balance.status === 200, `status ${balance.status}`);
  check('leave balance reports entitlements',
    balance.body?.entitlements?.casual_leave > 0,
    JSON.stringify(balance.body?.entitlements));
  check('remaining never exceeds entitlement',
    balance.body?.casual_leave_balance <= balance.body?.entitlements?.casual_leave
      && balance.body?.combined_annual_sick_leave_balance
        <= balance.body?.entitlements?.combined_annual_sick_leave,
    JSON.stringify(balance.body));

  // --- policy retrieval actually retrieves ---
  const chat = await request('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'What is the remote work policy?' }),
  });
  check('chat returns 200', chat.status === 200, `status ${chat.status}`);
  check('chat cites at least one source',
    Array.isArray(chat.body?.sources) && chat.body.sources.length > 0,
    JSON.stringify(chat.body?.sources));
  check('chat retrieves the flexible work policy, not attendance',
    chat.body?.sources?.[0] === 'Flexible Work Arrangement Policy',
    chat.body?.sources?.[0]);
  check('chat did not fall through to "no policy found"',
    !/couldn't find/i.test(chat.body?.answer || ''),
    (chat.body?.answer || '').slice(0, 80));

  // --- and honestly reports when it has nothing ---
  const nonsense = await request('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'zzzz qqqq xxxx' }),
  });
  check('chat reports no policy rather than guessing',
    /couldn't find/i.test(nonsense.body?.answer || '')
      && (nonsense.body?.sources || []).length === 0,
    JSON.stringify(nonsense.body));

  // --- leave application is validated, not rubber-stamped ---
  const overCap = await request('/leave-application', {
    method: 'POST',
    body: JSON.stringify({
      employee_id: '1001',
      request_text: 'I want 400 days of casual leave starting yesterday',
    }),
  });
  check('an over-cap request is refused', overCap.status === 422,
    `status ${overCap.status} ${JSON.stringify(overCap.body)}`);
  check('a refused request gets no reference id',
    !overCap.body?.reference_id, JSON.stringify(overCap.body));

  const before = (await request('/leave-balance?employee_id=1001')).body;
  const applied = await request('/leave-application', {
    method: 'POST',
    body: JSON.stringify({
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    }),
  });
  check('a valid request is accepted', applied.status === 200,
    `status ${applied.status} ${JSON.stringify(applied.body)}`);
  check('an accepted request gets a reference id',
    Boolean(applied.body?.reference_id), JSON.stringify(applied.body));
  check('the confirmation carries no markdown',
    !(applied.body?.message || '').includes('**'), applied.body?.message);

  const after = (await request('/leave-balance?employee_id=1001')).body;
  check('the balance dropped by the days submitted',
    after?.casual_leave_balance === before?.casual_leave_balance - 1,
    `${before?.casual_leave_balance} -> ${after?.casual_leave_balance}`);

  const listed = await request('/leave-applications');
  check('the application is listed',
    (listed.body?.applications || []).some(
      (a) => a.reference_id === applied.body?.reference_id),
    `${(listed.body?.applications || []).length} application(s)`);

  // --- intent classification ---
  const intent = await request('/intent', {
    method: 'POST',
    body: JSON.stringify({ message: 'show my leave balance' }),
  });
  check('intent returns 200', intent.status === 200, `status ${intent.status}`);
  check('intent classifies a balance query correctly',
    intent.body?.intent === 'leaveBalance', JSON.stringify(intent.body));
  check('intent reports which method decided',
    ['rules', 'rules_fallback', 'embedding'].includes(intent.body?.method),
    intent.body?.method);

  // --- decisions produce notifications ---
  const forDecision = await request('/leave-application', {
    method: 'POST',
    body: JSON.stringify({
      employee_id: '1001',
      request_text: 'apply for 1 day casual leave',
    }),
  });
  const beforeDecision = (await request('/leave-balance?employee_id=1001')).body;
  const decided = await request(
    `/leave-applications/${forDecision.body?.reference_id}/decision`,
    { method: 'POST', body: JSON.stringify({ decision: 'rejected', decided_by: '1002' }) },
  );
  check('a decision is accepted', decided.status === 200,
    `status ${decided.status} ${JSON.stringify(decided.body)}`);
  check('a rejection returns the days',
    decided.body?.restored_balance === beforeDecision?.casual_leave_balance + 1,
    `${beforeDecision?.casual_leave_balance} -> ${decided.body?.restored_balance}`);

  const secondDecision = await request(
    `/leave-applications/${forDecision.body?.reference_id}/decision`,
    { method: 'POST', body: JSON.stringify({ decision: 'rejected', decided_by: '1002' }) },
  );
  check('deciding twice is refused', secondDecision.status === 409,
    `status ${secondDecision.status}`);

  const notices = await request('/notifications?employee_id=1001&unread=true');
  check('the applicant is notified', (notices.body?.unread || 0) >= 1,
    JSON.stringify(notices.body));
  check('the notification names the decision',
    /rejected/i.test(notices.body?.notifications?.[0]?.message || ''),
    notices.body?.notifications?.[0]?.message);

  // --- report ---
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `  [${c.detail}]`}`);
  }
  console.log('');

  if (failed.length) {
    console.error(`smoke test failed: ${failed.length} of ${checks.length} checks`);
    process.exit(1);
  }
  console.log(`smoke test passed: ${checks.length} checks`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
