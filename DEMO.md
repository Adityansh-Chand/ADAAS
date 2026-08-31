# Demo

Fifteen minutes, no cloud account and no API key. The point of the sequence is
that it shows the system refusing things as well as doing them — a demo where
everything succeeds tells you nothing about whether the failure paths are real.

Every response below is committed under `examples/responses/`, captured from the
running service rather than written by hand.

## 1. Start the backend

Terminal 1:

```bash
cd hr-backend
npm ci
npm start
```

You should see `LLM: none (answers come straight from the knowledge base)` and
`MONGODB_URI not set; using in-memory HR demo data.`

## 2. Prove it works, by content

Terminal 2:

```bash
cd hr-backend
npm run smoke
```

Twenty checks, all about response content. It asserts that retrieval returns the
Flexible Work Arrangement Policy rather than Attendance, that an over-cap leave
request is refused with no reference ID, and that an accepted one moves the
balance. The previous version of this script checked only HTTP status, so it
passed while `/chat` returned "I couldn't find a matching company policy".

## 3. See the retrieval numbers

```bash
cd hr-backend
npm run eval
```

Prints top-1, recall@5 and MRR for both eval sets with every miss listed. Set A
scores 0.9231 and Set B scores 0.1111 — Set B being the honest one. This is the
most informative thing in the repository.

## 4. Readiness actually means something

```bash
curl -i http://localhost:3000/health
curl -i http://localhost:3000/live
```

`/health` reports the corpus size and returns **503** if the corpus cannot be
read. `/live` only reports that the process is up. Temporarily rename
`assets/hr_knowledge_base.json`, restart, and `/health` turns 503 while `/live`
stays 200 — which is what stops Kubernetes routing traffic to a pod that would
answer every question with "not found".

## 5. Policy questions

Run these from the repository root so the `examples/` paths resolve.

```bash
curl -s -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d @examples/requests/chat.json
```

Two sources come back, most relevant first, and `generated_by` says
`knowledge_base` because no LLM is configured.

Now the honest failure — a question the corpus can answer, phrased the way an
employee would:

```bash
curl -s -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"message":"Can I work from my house a few days a week?"}'
```

`"I couldn't find a matching company policy for that question."` Policy 013
answers this directly; it is not retrieved because the query contains none of
the indexed keyword strings. That single response is the argument for the
capstone's retrieval work.

## 6. Leave balance, checkable against the policy

```bash
curl -s "http://localhost:3000/leave-balance?employee_id=1001"
```

Returns entitlement, used and remaining. The entitlements — 4 casual days and 18
combined annual/earned/sick — are transcribed from `policy_003_cl` and
`policy_003_el_sl`, and a test asserts they still match that text.

## 7. A leave application that is refused

```bash
curl -s -X POST http://localhost:3000/leave-application -H "Content-Type: application/json" -d @examples/requests/leave-application-rejected.json
```

**422**, citing the policy: *"Casual Leave allows a maximum of 2 consecutive days
at a time (policy_003_cl); you requested 400."* No reference ID is issued. The
previous build accepted this with `status: "submitted"` and a reference.

## 8. A leave application that succeeds, and moves the balance

```bash
curl -s -X POST http://localhost:3000/leave-application -H "Content-Type: application/json" -d @examples/requests/leave-application.json
curl -s "http://localhost:3000/leave-balance?employee_id=1001"
curl -s http://localhost:3000/leave-applications
```

The balance drops by the days submitted. Previously the two features never
touched each other, so the balance was unchanged no matter how much leave you
filed.

## 9. Protected endpoints

```bash
API_KEY=demo-key npm start
```

```bash
curl -i "http://localhost:3000/leave-balance?employee_id=1001"
curl -s "http://localhost:3000/leave-balance?employee_id=1001" -H "X-API-Key: demo-key"
```

## Flutter walkthrough

Terminal 1:

```bash
cd hr-backend
npm start
```

Terminal 2:

```bash
flutter run -d chrome --dart-define=HR_API_BASE_URL=http://localhost:3000
```

Try, in order:

| Prompt | What to notice |
|---|---|
| `Show my leave balance` | Two rows, not three — annual and sick are one shared pool in the policy. Remaining is shown against entitlement. |
| `apply for 1 day casual leave` | Plain-text confirmation with the server's reference ID, and the remaining count. |
| `Show my leave balance` | It went down. |
| `I want 400 days of casual leave` | Refused, citing the policy. |
| `What is the remote work policy?` | Answer plus its cited source. |
| `Can I take maternity leave?` | A policy answer, not a leave application. The old router filed this as an application because the sentence contains "take" and "leave". |
| `Can I work from my house a few days a week?` | Honest "no matching policy". |

### Then the part worth demoing

Stop the backend (Ctrl-C in terminal 1) and try again:

```
apply for 1 day casual leave
```

A red bubble labelled **NOT COMPLETED**: *"Your leave request was not submitted
because the HR service could not be reached. Nothing has been filed — please try
again."*

The previous build replied *"Success! Your request for **Casual Leave** has been
submitted for approval. Reference ID: LMS-123456"* — with nothing written
anywhere and the reference ID cut from the current timestamp. Nothing in the UI
could tell it apart from a real confirmation, because the state model had no
notion of failure at all.

## Sample files

- Requests: `examples/requests/chat.json`, `leave-application.json`,
  `leave-application-rejected.json`
- Responses: `examples/responses/health.json`, `metrics.json`,
  `leave-balance.json`, `leave-application.json`,
  `leave-application-rejected.json`, `leave-applications.json`, `chat.json`,
  `chat-no-policy.json`
