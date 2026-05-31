const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('./server');

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

test('health reports in-memory fallback when Mongo is not configured', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.status, 'running');
  });
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

test('leave balance returns seeded employee data', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/leave-balance?employee_id=1001`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.casual_leave_balance, 5);
  });
});

test('leave application identifies leave type', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/leave-application`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: '1001',
        request_text: 'I want to apply for sick leave',
      }),
    });
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.leave_type, 'Sick Leave');
  });
});

test('leave application is persisted in fallback store', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/leave-application`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: '1001',
        request_text: 'I want annual leave',
      }),
    });

    const response = await fetch(`${baseUrl}/leave-applications`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.ok(data.applications.length > 0);
  });
});

test('chat answers from the HR knowledge base', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What is the remote work policy?',
      }),
    });
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.match(data.answer, /Remote work/i);
    assert.ok(data.sources.length > 0);
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
  });
});
