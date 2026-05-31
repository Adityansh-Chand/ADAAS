const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const apiKey = process.env.API_KEY || '';

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  await request('/health');
  await request('/metrics');
  await request('/leave-balance?employee_id=1001');
  await request('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'What is the remote work policy?' }),
  });

  console.log('smoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
