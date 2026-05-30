# ADAAS — Artificially Driven Assistant for Automated Solutions

AI Flutter-based HR assistant with a Node/Express backend for leave balance, leave
application, and HR policy chat. The app routes user messages to either HR APIs
or policy Q&A using a shared intent router.

## Architecture

```mermaid
flowchart LR
  UserQuery --> IntentRouter
  IntentRouter --> LeaveBalanceAPI
  IntentRouter --> LeaveApplicationAPI
  IntentRouter --> ChatAPI
  ChatAPI --> HRKnowledgeBase
  ChatAPI --> OptionalLLM
  LeaveBalanceAPI --> MongoOrMemory
  LeaveApplicationAPI --> Response
  HRKnowledgeBase --> Response
  MongoOrMemory --> Response
  Response --> FlutterUI
```

## Backend

Endpoints:

- `GET /health`
- `GET /leave-balance?employee_id=1001`
- `POST /leave-application`
- `POST /chat`

Run:

```bash
cd hr-backend
npm install
npm test
npm start
```

The backend uses MongoDB when `MONGODB_URI` is configured and falls back to
seeded in-memory demo data otherwise. `GEMINI_API_KEY` is optional; without it,
policy chat returns deterministic knowledge-base answers.

## Flutter App

Run:

```bash
flutter test
flutter analyze
flutter run -d chrome --dart-define=HR_API_BASE_URL=http://localhost:3000
```

## Highlights

- BLoC chat flow.
- Shared intent router for tests and production code.
- Backend-hosted chat generation.
- Configurable API base URL via `HR_API_BASE_URL`.
- Local RAG fallback for policy answers.
- Unit tests for routing, model parsing, leave logic, RAG retrieval, and widgets.

## License

MIT
