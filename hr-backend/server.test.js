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
