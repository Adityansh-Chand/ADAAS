# Demo

This demo shows the ADAAS HR backend answering policy questions, returning leave
balances, submitting leave applications, and exposing metrics. It also includes a
short Flutter app walkthrough.

## Backend Run

Terminal 1:

```bash
cd hr-backend
npm install
npm start
```

Terminal 2:

```bash
cd hr-backend
npm run smoke
```

To demo protected endpoints, start with an API key:

```bash
API_KEY=demo-key npm start
```

## Backend Curl Walkthrough

Run these curl commands from the `ADAAS` repository root so the `examples/`
paths resolve.

Health:

```bash
curl http://localhost:3000/health
```

Metrics:

```bash
curl http://localhost:3000/metrics
```

Leave balance:

```bash
curl "http://localhost:3000/leave-balance?employee_id=1001"
```

Submit leave application:

```bash
curl -X POST http://localhost:3000/leave-application \
  -H "Content-Type: application/json" \
  -d @examples/requests/leave-application.json
```

List leave applications:

```bash
curl http://localhost:3000/leave-applications
```

Chat:

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d @examples/requests/chat.json
```

Protected request when `API_KEY` is set:

```bash
curl "http://localhost:3000/leave-balance?employee_id=1001" \
  -H "X-API-Key: demo-key"
```

## Flutter App Walkthrough

Terminal 1:

```bash
cd hr-backend
npm start
```

Terminal 2:

```bash
flutter run -d chrome \
  --dart-define=HR_API_BASE_URL=http://localhost:3000
```

Try these prompts in the chat UI:

- `Show my leave balance`
- `I want to apply for sick leave tomorrow`
- `What is the remote work policy?`

## Sample Files

- Requests: `examples/requests/chat.json`, `leave-application.json`
- Responses: `examples/responses/health.json`, `metrics.json`, `leave-balance.json`, `leave-application.json`, `leave-applications.json`, `chat.json`
