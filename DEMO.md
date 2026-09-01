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

## 5b. The same question, with dense retrieval and reranking on

This is the demo. Stop the server and restart it with the models enabled:

```bash
cd hr-backend
npm install                    # devDependencies included; ~200 MB of models on first run
RETRIEVAL_MODE=reranked npm start
```

```bash
curl -s http://localhost:3000/health
```

`retrieval` now reads `{"mode":"reranked"}`. If the models were unavailable it
would read `{"mode":"dense",...,"degraded_because":"reranker_package_not_installed"}`,
or drop to `lexical` if the vectors were missing too — it never silently falls
back, and it degrades one step at a time.

Now the query that just failed:

```bash
curl -s -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"message":"Can I work from my house a few days a week?"}'
```

The Flexible Work Arrangement Policy, correctly. Across the whole paraphrase set
that is 0.1111 → 0.8333 top-1 and 0.1111 → 1.0000 recall@5.

The query the reranker was actually added for — two medical sub-policies that a
bi-encoder cannot separate, because they are the same topic at the same
granularity:

```bash
curl -s -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"message":"I am burnt out and need someone to talk to"}'
```

The Employee Assistance Program, not the on-site medical rooms. Without reranking
this returns the medical rooms.

And the threshold still holds, so it has not simply become a machine that always
guesses:

```bash
curl -s -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"message":"what is the capital of Portugal"}'
```

Still `"I couldn't find a matching company policy for that question."`

```bash
cd hr-backend
npm run eval
```

The full four-way comparison, both scorings, the abstention tiers and thirteen
gates. Three results are reported rather than hidden: hybrid fusion does **not**
beat dense alone; abstention rejects 12 of 12 plainly off-domain probes but only 2
of 12 HR-shaped questions the corpus does not answer; and the graded relevance
judgements show that **none** of the three remaining reranked misses is a labelling
artefact -- they are genuine ranking errors, which is the opposite of what the
previous README predicted.

```bash
npm run bakeoff
```

The model selection itself, on the dev half only. Five bi-encoders, eight
rerankers and eleven ways of combining the two scores -- including the five
rerankers that made it worse, the 768-dimension encoder that was no better than
the 384-dimension one, the 1.1 GB `bge-reranker-base` that came second from last,
and eleven fusion strategies that were all *exactly* as good as the cross-encoder
alone.

```bash
npm run bakeoff:intent
```

The same discipline for the intent decision rule, and it will refuse to open the
three held-out sets -- by throwing, not by convention. The incumbent k-NN came last
but one of thirteen candidates.

```bash
npm run probe:abstention
```

A third abstention signal, built and rejected: term-level corpus coverage. It
prints the least-covered word in every out-of-scope probe (`dog`, `car`, `sublet`,
`canteen`) and then shows why it cannot ship -- the weakest genuine query, about
taxi receipts, scores below eight of the twelve hard negatives.

## 5c. Intent classification, rules against embeddings

```bash
cd hr-backend
npm run eval:intent
```

Six sets, two methods, and the table says what each set is worth. Three are
clean: `held_out_3`, written before the classifier existed, at **rules 0.5667,
embedding 0.9667**; `held_out_4`, written before the classifier was *rewritten*, at
**rules 0.3667, embedding 0.8000**; and `held_out_5`, written before an
action-safety fix, at **rules 0.6389, embedding 0.9722**.

Scroll to the **action safety** block. It scores the 36 retrieval paraphrases,
which are policy questions by construction, and counts how often one becomes a
leave action. It exists because a screenshot found the app filing a five-day leave
application in answer to a question about working from home. 14 of 36 before, 8
after -- and the rule baseline still beats the fitted classifier at it, 3 misroutes
against 8, which is printed rather than omitted.

Set 3 previously read 0.9000, down from 0.9667 before the embedding model changed,
and the README then said the honest way to recover it was a fourth held-out set
written before anything was re-picked. That is exactly the order it happened in:
set 4 first, then a dev-only comparison of thirteen decision rules, then the
held-out sets read once. The incumbent k-NN came last but one; a plain logistic
regression on the same vectors won. Set 3 recovered to 0.9333 at that point --
two-thirds of the loss, not all of it -- and the 54 training examples added at the
same time turned out to contribute nothing, which the README says in as many
words. It reached 0.9667, the pre-swap figure, only after the action-safety fix,
which was not aimed at it.

Try three queries the rules get wrong. With `RETRIEVAL_MODE=reranked` running:

```bash
for Q in "just checking, do I still have days in hand"          "I want to be off on the 19th, sort that out"          "does the firm reimburse a taxi to the airport"; do
  curl -s -X POST http://localhost:3000/intent     -H "Content-Type: application/json" -d "{\"message\":\"$Q\"}"
  echo
done
```

All three classify correctly, each reporting `"method":"embedding"`. Restart with
`RETRIEVAL_MODE=lexical` and the same three fall through to `policyQuestion`.

## 5d. The screenshots, regenerated from the running app

```bash
node tool/capture_screenshots.js
```

Drives the real app in headless Chrome against the backend you already have
running and rewrites `docs/screenshots/`. Nothing in the README is a mock-up: the
policy text is what retrieval returned and the balance figures are what the API
returned. It waits for the page to stop changing rather than sleeping a fixed
amount, because the first attempt captured the loading indicator instead of the
answer.

This is also the command that found the intent bug above.

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

## 8b. Approving and rejecting

File one, then reject it:

```bash
REF=$(curl -s -X POST http://localhost:3000/leave-application   -H "Content-Type: application/json"   -d @examples/requests/leave-application.json | python -c "import json,sys;print(json.load(sys.stdin)['reference_id'])")

curl -s "http://localhost:3000/leave-balance?employee_id=1001"

curl -s -X POST "http://localhost:3000/leave-applications/$REF/decision"   -H "Content-Type: application/json"   -d @examples/requests/leave-decision.json

curl -s "http://localhost:3000/leave-balance?employee_id=1001"
```

The days come back. They are deducted at submission so a balance cannot be spent
twice by two concurrent requests, which makes restoring them on rejection a
required invariant rather than a nicety.

Three refusals worth trying:

```bash
# Deciding twice -- 409, and the days are not restored again
curl -s -X POST "http://localhost:3000/leave-applications/$REF/decision"   -H "Content-Type: application/json" -d '{"decision":"rejected","decided_by":"1002"}'

# Self-approval -- 403
REF2=$(curl -s -X POST http://localhost:3000/leave-application   -H "Content-Type: application/json"   -d '{"employee_id":"1001","request_text":"apply for 1 day casual leave"}'   | python -c "import json,sys;print(json.load(sys.stdin)['reference_id'])")
curl -s -X POST "http://localhost:3000/leave-applications/$REF2/decision"   -H "Content-Type: application/json" -d '{"decision":"approved","decided_by":"1001"}'

# Unknown reference -- 404
curl -s -X POST "http://localhost:3000/leave-applications/LMS-NOPE/decision"   -H "Content-Type: application/json" -d '{"decision":"approved","decided_by":"1002"}'
```

## 8c. The applicant is told

The rejection above wrote a notification:

```bash
curl -s "http://localhost:3000/notifications?employee_id=1001&unread=true"
```

Previously a decision moved a balance silently and left the employee to notice.
Acknowledge it:

```bash
NID=$(curl -s "http://localhost:3000/notifications?employee_id=1001"   | python -c "import json,sys;print(json.load(sys.stdin)['notifications'][0]['id'])")
curl -s -X POST "http://localhost:3000/notifications/$NID/ack"   -H "Content-Type: application/json" -d '{}'
```

And check the approver was not notified — the notification is addressed to the
applicant:

```bash
curl -s "http://localhost:3000/notifications?employee_id=1002"
```

In the app, a pending decision appears before the answer to whatever you asked,
in its own bubble labelled **WHILE YOU WERE AWAY**.

## 8d. A second employee

```bash
curl -s "http://localhost:3000/leave-balance?employee_id=1002"
```

Different usage from 1001, so identity is observably real rather than notional.
In the app:

```bash
flutter run -d chrome   --dart-define=HR_API_BASE_URL=http://localhost:3000   --dart-define=HR_EMPLOYEE_ID=1002
```

The header shows `employee 1002`. This is a demo identity selected at build time,
not authentication — the header is there so that is visible rather than implied.

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
| `Can I take maternity leave?` | A policy answer, not a leave application. The old rule-based router filed this as an application because the sentence contains "take" and "leave". |
| `just checking, do I still have days in hand` | A balance. The rules read this as a policy question; the classifier does not. |
| `Can I work from my house a few days a week?` | With the backend on `lexical`, an honest "no matching policy"; on `reranked`, the Flexible Work policy. |
| the theme button, top right | Cycles system → light → dark. Every message kind is legible in both, and CI fails the build if any pairing drops below WCAG AA. |

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
- Requests: also `leave-decision.json`
- Responses: `examples/responses/health.json`, `metrics.json`,
  `leave-balance.json`, `leave-balance-1002.json`, `leave-application.json`,
  `leave-application-rejected.json`, `leave-decision.json`,
  `leave-applications.json`, `chat.json`, `chat-no-policy.json`
