const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');

const LeaveApplication = require('./models/LeaveApplication');
const LeaveBalance = require('./models/LeaveBalance');
const llm = require('./llm');
const { buildIndex, retrieve } = require('./retrieval');
const denseRetrieval = require('./dense');
const reranker = require('./rerank');
const modelClient = require('./model_client');
const notificationStore = require('./notifications');
const session = require('./session');
const oidcModule = require('./oidc');
const secrets = require('./secrets');
const corpus = require('./corpus');
const intentModule = require('./intent');
const embeddings = require('./embeddings');
const {
  ENTITLEMENTS,
  POOL_FOR_TYPE,
  determineLeaveType,
  parseRequestedDays,
  validateRequest,
} = require('./leave_rules');

dotenv.config();

// Before anything reads a secret. `FOO_FILE` beats `FOO`, which is how Docker
// secrets and Kubernetes secret volumes deliver values without putting them in
// the environment -- where they are visible in `docker inspect`, in
// /proc/<pid>/environ, and in any crash dump.
const secretsFromFiles = secrets.resolveAll();
if (secretsFromFiles.length) {
  console.log(`secrets read from files: ${secretsFromFiles.join(', ')}`);
}

const app = express();
const port = process.env.PORT || 3000;
const mongoURI = process.env.MONGODB_URI;
let mongoReady = false;
const startedAt = Date.now();
const counters = {
  requests_total: 0,
  errors_total: 0,
  chat_requests_total: 0,
  chat_no_policy_total: 0,
  leave_applications_total: 0,
  leave_applications_rejected_total: 0,
  llm_fallback_total: 0,
  retrieval_dense_failures_total: 0,
  retrieval_rerank_failures_total: 0,
  leave_decisions_total: 0,
  intent_requests_total: 0,
  intent_embedding_failures_total: 0,
  notifications_created_total: 0,
};

// ---------------------------------------------------------------------------
// Knowledge base
//
// Loaded once at startup and indexed, instead of a synchronous readFileSync plus
// JSON.parse inside every /chat request. `kbError` is what lets /health report
// unreadiness: previously /health returned 200 unconditionally, so a pod that
// could not read its own corpus was marked Ready and answered every policy
// question with "not found".
// ---------------------------------------------------------------------------
// Explicit override, defaulting to the repository layout.
//
// The container previously relied on `__dirname/../assets` happening to resolve
// to the `/assets/` the Dockerfile copies to -- true only because WORKDIR is
// exactly one level deep. Changing WORKDIR to `/usr/src/app` would have broken
// /chat at runtime while every build check still passed.
const INTENT_TRAINING_PATH = path.resolve(
  __dirname, '..', 'eval', 'intent_training.json',
);
const KB_PATH = process.env.KB_PATH
  ? path.resolve(process.env.KB_PATH)
  : path.resolve(__dirname, '..', 'assets', 'hr_knowledge_base.json');
let knowledgeBase = [];
let retrievalIndex = null;
let kbError = null;
let vectorStore = null;
let kbById = new Map();
// Declared with the rest of the module state rather than beside
// loadIntentClassifier(): that function is hoisted but a `let` is not, so
// calling it during startup hit a temporal-dead-zone error.
let intentClassifier = null;

// ---------------------------------------------------------------------------
// Retrieval mode
//
// Default is `lexical`, which needs nothing beyond the corpus. `dense` and
// `hybrid` score 0.6111 top-1 on paraphrased questions against lexical's 0.1111
// -- see `npm run eval` -- but they need a query embedded at request time, which
// means the optional @huggingface/transformers devDependency. That package pulls
// in onnxruntime-node and sharp, whose advisories have no fix available, so it is
// deliberately absent from the production image (`npm ci --omit=dev`) and
// `npm audit --omit=dev` reports zero vulnerabilities.
//
// The measured consequence of that choice is stated in the README rather than
// hidden: the default mode is the weaker one, and turning on the better one is
// one install and one environment variable away.
// ---------------------------------------------------------------------------
const VALID_RETRIEVAL_MODES = ['lexical', 'dense', 'hybrid', 'reranked'];

function configuredRetrievalMode() {
  const raw = (process.env.RETRIEVAL_MODE || 'lexical').trim().toLowerCase();
  return VALID_RETRIEVAL_MODES.includes(raw) ? raw : 'lexical';
}

/** The mode actually in use, which may be weaker than the one requested. */
function activeRetrievalMode() {
  const wanted = configuredRetrievalMode();
  if (wanted === 'lexical') return { mode: 'lexical', reason: 'configured' };
  if (!vectorStore) {
    return { mode: 'lexical', reason: 'no_precomputed_vectors' };
  }
  if (!embeddings.isAvailable()) {
    return { mode: 'lexical', reason: 'embeddings_package_not_installed' };
  }
  // Reranking needs the model at request time and cannot be precomputed for an
  // arbitrary query, so it degrades to plain dense rather than to lexical -- one
  // step down, not two.
  if (wanted === 'reranked' && !reranker.isAvailable()) {
    return { mode: 'dense', reason: 'reranker_package_not_installed' };
  }
  return { mode: wanted, reason: 'configured' };
}

function loadKnowledgeBase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('knowledge base is empty');
    }
    knowledgeBase = parsed;
    retrievalIndex = buildIndex(knowledgeBase);
    kbById = new Map(knowledgeBase.map((entry) => [entry.id, entry]));
    kbError = null;

    // Precomputed policy vectors. Absent is fine -- retrieval falls back to
    // lexical and /health says so.
    vectorStore = denseRetrieval.loadVectors();
    if (vectorStore && vectorStore.dimensions !== embeddings.DIMENSIONS) {
      console.error(
        `eval/embeddings.json has ${vectorStore.dimensions} dimensions, expected `
        + `${embeddings.DIMENSIONS}; ignoring it`,
      );
      vectorStore = null;
    }
  } catch (err) {
    knowledgeBase = [];
    retrievalIndex = null;
    kbById = new Map();
    vectorStore = null;
    kbError = err.message;
    console.error(`Failed to load knowledge base from ${KB_PATH}: ${err.message}`);
  }
  return kbError === null;
}

loadKnowledgeBase();
loadIntentClassifier();

// ---------------------------------------------------------------------------
// In-memory demo data
//
// Seeded as days *used* against the entitlements in leave_rules.js, which are
// transcribed from the policy corpus. Storing "used" rather than "remaining"
// means the numbers cannot drift out of agreement with the policy text.
// ---------------------------------------------------------------------------
const fallbackLeaveApplications = [];

// Two employees with different usage, so switching identity produces visibly
// different numbers. With a single seeded employee, "the app is hardcoded to
// 1001" and "the app supports one employee" were indistinguishable.
const SEEDED_LEAVE_USAGE = () => ({
  '1001': { casual_leave: 1, combined_annual_sick_leave: 3 },
  '1002': { casual_leave: 3, combined_annual_sick_leave: 11 },
});
const fallbackLeaveUsage = SEEDED_LEAVE_USAGE();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  counters.requests_total += 1;
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

function requireApiKey(req, res, next) {
  const expectedApiKey = process.env.API_KEY;
  if (!expectedApiKey) {
    next();
    return;
  }

  const provided = req.header('x-api-key') || '';
  const expectedBuffer = Buffer.from(expectedApiKey);
  const providedBuffer = Buffer.from(provided);

  const matches = expectedBuffer.length === providedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  if (!matches) {
    res.status(401).json({
      error: 'Invalid or missing API key',
      request_id: req.requestId,
    });
    return;
  }

  next();
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function connectMongo() {
  if (!mongoURI) {
    console.log('MONGODB_URI not set; using in-memory HR demo data.');
    return;
  }

  try {
    await mongoose.connect(mongoURI);
    mongoReady = true;
    console.log('MongoDB Connected');
  } catch (err) {
    mongoReady = false;
    console.log(`MongoDB unavailable; using in-memory HR demo data. ${err.message}`);
  }
}

function mongoUsable() {
  return mongoReady && mongoose.connection.readyState === 1;
}

// ---------------------------------------------------------------------------
// Policy retrieval and answering
// ---------------------------------------------------------------------------

function shapeRetrieval(ranked, mode) {
  return {
    matches: ranked,
    mode,
    sources: ranked.map((item) => item.entry.source),
    primaryAnswer: ranked[0]?.entry.answer || '',
    context: ranked
      .map((item) => `Source: ${item.entry.source}\nPolicy Details: ${item.entry.answer}`)
      .join('\n\n'),
  };
}

/**
 * Retrieve policies for a message.
 *
 * Async because the dense path has to embed the query at request time. Falls back
 * to lexical rather than failing if embedding turns out to be unavailable, and
 * reports which mode actually ran so a caller is never guessing.
 */
async function retrieveContext(message) {
  if (!retrievalIndex) return shapeRetrieval([], 'unavailable');

  const lexical = retrieve(message, retrievalIndex, { topK: 5 });
  const { mode } = activeRetrievalMode();
  if (mode === 'lexical') return shapeRetrieval(lexical, 'lexical');

  let denseRanked;
  try {
    denseRanked = await denseRetrieval.denseRetrieve(
      message, vectorStore, kbById, { topK: 5 },
    );
  } catch (error) {
    // A missing model or a load failure must degrade, not 500.
    counters.retrieval_dense_failures_total += 1;
    console.error(`dense retrieval unavailable, using lexical: ${error.message}`);
    return shapeRetrieval(lexical, 'lexical');
  }

  if (mode === 'dense') return shapeRetrieval(denseRanked, 'dense');

  if (mode === 'reranked') {
    try {
      // The pool is deliberately wider than the 5 that get returned: the
      // cross-encoder can only reorder what it is handed.
      const pooled = await denseRetrieval.denseRetrieve(
        message, vectorStore, kbById, { topK: reranker.DEFAULT_POOL },
      );
      const reranked = await reranker.rerank(message, pooled);
      return shapeRetrieval(reranked.slice(0, 5), 'reranked');
    } catch (error) {
      // Same rule as above: a model that will not load degrades, never 500s.
      counters.retrieval_rerank_failures_total += 1;
      console.error(`reranking unavailable, using dense: ${error.message}`);
      return shapeRetrieval(denseRanked, 'dense');
    }
  }

  // Hybrid measures no better than dense alone on this corpus -- identical top-1
  // and recall@5, marginally worse MRR -- and equal weighting is actively worse
  // than favouring dense. Offered because running the comparison is the point of
  // the harness, not because it wins.
  return shapeRetrieval(
    denseRetrieval.fuse(lexical, denseRanked, { topK: 5 }), 'hybrid',
  );
}

/**
 * The deterministic answer: the retrieved policy's own text, unaltered.
 *
 * It used to append "Source: <policy>" to the text as well. That duplicated the
 * `sources` field this endpoint already returns, and in the app it rendered
 * twice -- once inside the bubble and once as the citation line underneath.
 * Visible in the first committed screenshot, which is how it was noticed.
 *
 * The citation belongs in the structured field. An API consumer reads `sources`;
 * a UI renders it as a citation and can style it, order it, and say which of the
 * retrieved policies actually produced the answer. Baking it into prose gives up
 * all of that and gains nothing.
 */
function groundedAnswer(retrieval) {
  return retrieval.primaryAnswer;
}

async function generateAnswer(message, retrieval) {
  if (!retrieval.context) {
    return {
      answer: "I couldn't find a matching company policy for that question.",
      generated_by: 'none',
    };
  }

  const result = await llm.generate(message, retrieval.context);
  if (result.text) {
    return { answer: result.text, generated_by: llm.readConfig().provider };
  }

  if (result.reason !== 'not_configured') {
    counters.llm_fallback_total += 1;
  }

  return {
    answer: groundedAnswer(retrieval),
    generated_by: 'knowledge_base',
    llm_status: result.reason,
  };
}

// ---------------------------------------------------------------------------
// Leave balances
// ---------------------------------------------------------------------------

function balancePayload(employeeId, used) {
  const casualUsed = used.casual_leave || 0;
  const combinedUsed = used.combined_annual_sick_leave || 0;

  return {
    employee_id: employeeId,
    // Annual and sick leave are one pool in the policy, not two. Reporting them
    // as separate balances is what made the old numbers impossible to reconcile
    // with policy_003_el_sl.
    entitlements: {
      casual_leave: ENTITLEMENTS.casual_leave.days,
      combined_annual_sick_leave: ENTITLEMENTS.combined_annual_sick_leave.days,
    },
    used: {
      casual_leave: casualUsed,
      combined_annual_sick_leave: combinedUsed,
    },
    casual_leave_balance: ENTITLEMENTS.casual_leave.days - casualUsed,
    combined_annual_sick_leave_balance:
      ENTITLEMENTS.combined_annual_sick_leave.days - combinedUsed,
  };
}

async function readUsage(employeeId) {
  if (mongoUsable()) {
    const record = await LeaveBalance.findOne({ employeeId }).lean();
    if (record) {
      return {
        casual_leave: record.casualLeaveUsed || 0,
        combined_annual_sick_leave: record.combinedAnnualSickLeaveUsed || 0,
      };
    }
    return null;
  }

  return fallbackLeaveUsage[employeeId] || null;
}

async function findApplication(reference) {
  if (mongoUsable()) {
    const record = await LeaveApplication.findOne({ referenceId: reference }).lean();
    if (!record) return null;
    return {
      employee_id: record.employeeId,
      leave_type: record.leaveType,
      days: record.days,
      status: record.status,
    };
  }
  return fallbackLeaveApplications.find((a) => a.reference_id === reference) || null;
}

async function setApplicationStatus(reference, status, decidedBy) {
  if (mongoUsable()) {
    await LeaveApplication.updateOne(
      { referenceId: reference },
      { $set: { status, decidedBy, decidedAt: new Date() } },
    );
    return;
  }
  const application = fallbackLeaveApplications
    .find((a) => a.reference_id === reference);
  if (application) {
    application.status = status;
    application.decided_by = decidedBy;
    application.decided_at = new Date().toISOString();
  }
}

async function commitUsage(employeeId, pool, days) {
  if (mongoUsable()) {
    const field = pool === 'casual_leave'
      ? 'casualLeaveUsed'
      : 'combinedAnnualSickLeaveUsed';
    // $inc cannot enforce the schema's `min: 0`, so read-modify-write with a
    // clamp. Same reasoning as the fallback path: a restore must not push usage
    // below zero and report a balance above the entitlement.
    const record = await LeaveBalance.findOne({ employeeId }).lean();
    const current = (record && record[field]) || 0;
    await LeaveBalance.updateOne(
      { employeeId },
      { $set: { [field]: Math.max(0, current + days) } },
      { upsert: true },
    );
    return;
  }

  const usage = fallbackLeaveUsage[employeeId];
  // Clamped at zero: `days` is negative when a rejection restores leave, and a
  // double-rejection or a mismatched record must not produce negative usage,
  // which would report a balance above the entitlement.
  usage[pool] = Math.max(0, (usage[pool] || 0) + days);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Liveness: is the process up? Deliberately unconditional. */
app.get('/live', (req, res) => {
  res.json({ status: 'alive' });
});

/**
 * Readiness. Returns 503 when the service cannot actually serve policy
 * questions, so a Kubernetes readiness probe can take the pod out of rotation
 * instead of routing traffic to something that answers "not found" to
 * everything.
 */
app.get('/health', (req, res) => {
  const ready = kbError === null;
  const body = {
    status: ready ? 'running' : 'degraded',
    dataSource: mongoUsable() ? 'mongodb' : 'memory',
    knowledgeBase: ready
      ? { entries: knowledgeBase.length }
      : { entries: 0, error: kbError },
    llm: llm.isConfigured() ? llm.readConfig().provider : 'none',
    // Whether per-employee scoping is being enforced. Reported because
    // "unauthenticated" should be a visible state rather than something a
    // reader has to infer from the absence of a variable.
    authorization: session.mode(),
    identity: oidcModule.status(),
    secrets: secrets.status(),
    // Who owns the corpus and when it was last checked against real policy. A
    // wrong retrieval score shows up in an eval; a policy statement that went
    // stale eighteen months ago retrieves perfectly and is still wrong, and
    // nothing else here would notice.
    corpus: corpus.status(knowledgeBase),
    retrieval: (() => {
      const { mode, reason } = activeRetrievalMode();
      const requested = configuredRetrievalMode();
      const base = mode === requested
        ? { mode }
        : { mode, requested, degraded_because: reason };
      // Where the vectors come from, reported rather than inferred. 'service'
      // means a separate model-service process, which is what lets the
      // production image run dense or reranked retrieval at all -- the model
      // package carries advisories with no upstream fix and is not installed
      // there. 'local' is the in-process optional dependency, which is what
      // developers and CI use.
      return { ...base, model_source: modelClient.activeSource() };
    })(),
  };
  res.status(ready ? 200 : 503).json(body);
});

app.get('/metrics', (req, res) => {
  res.json({
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    counters,
    dataSource: mongoUsable() ? 'mongodb' : 'memory',
    knowledge_base_entries: knowledgeBase.length,
    retrieval_mode: activeRetrievalMode().mode,
    // Delivery is best-effort by design -- a webhook failure must not roll back
    // an approval that has already moved a balance. That makes "nobody is being
    // told" a silent condition unless it is counted, so it is counted here.
    notifications: notificationStore.status(),
  });
});

app.get('/leave-balance', requireApiKey, session.attachPrincipal,
  session.requireSelfOrApprover((req) => req.query.employee_id),
  asyncHandler(async (req, res) => {
  const employeeId = req.query.employee_id;
  if (!employeeId) {
    res.status(400).json({ error: 'employee_id is required' });
    return;
  }

  const usage = await readUsage(employeeId);
  if (!usage) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  res.json(balancePayload(employeeId, usage));
}));

app.post('/leave-application', requireApiKey, session.attachPrincipal,
  session.requireSelfOrApprover((req) => req.body.employee_id),
  asyncHandler(async (req, res) => {
  const employeeId = req.body.employee_id;
  const requestText = req.body.request_text || '';
  if (!employeeId || !requestText) {
    res.status(400).json({ error: 'employee_id and request_text are required' });
    return;
  }

  const usage = await readUsage(employeeId);
  if (!usage) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  const leaveType = determineLeaveType(requestText);
  const requestedDays = parseRequestedDays(requestText);
  const balance = balancePayload(employeeId, usage);
  const remaining = {
    casual_leave: balance.casual_leave_balance,
    combined_annual_sick_leave: balance.combined_annual_sick_leave_balance,
  };

  // Validate before doing anything. The old endpoint parsed no dates, checked no
  // balance and applied no entitlement cap, so it accepted "400 days of casual
  // leave" against a 4-day annual entitlement and issued a reference ID for it.
  const validation = validateRequest({ leaveType, requestedDays, remaining });
  if (!validation.ok) {
    counters.leave_applications_rejected_total += 1;
    res.status(422).json({
      error: validation.reason,
      leave_type: leaveType,
      requested_days: requestedDays == null ? 1 : requestedDays,
      request_id: req.requestId,
    });
    return;
  }

  const referenceId = `LMS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await commitUsage(employeeId, validation.pool, validation.days);

  if (mongoUsable()) {
    await LeaveApplication.create({
      employeeId,
      leaveType,
      requestText,
      referenceId,
      days: validation.days,
    });
  } else {
    fallbackLeaveApplications.push({
      employee_id: employeeId,
      leave_type: leaveType,
      days: validation.days,
      reference_id: referenceId,
      status: 'submitted',
      request_text: requestText,
      created_at: new Date().toISOString(),
    });
  }

  const updatedUsage = await readUsage(employeeId);
  const updatedBalance = balancePayload(employeeId, updatedUsage);
  const poolRemaining = validation.pool === 'casual_leave'
    ? updatedBalance.casual_leave_balance
    : updatedBalance.combined_annual_sick_leave_balance;

  counters.leave_applications_total += 1;

  // Plain text. The old message embedded `**Casual Leave**` markdown that the
  // Flutter client rendered into a plain Text widget, so the user read the
  // asterisks.
  const notes = validation.notes.length ? ` ${validation.notes.join(' ')}` : '';
  res.json({
    employee_id: employeeId,
    leave_type: leaveType,
    days: validation.days,
    reference_id: referenceId,
    status: 'submitted',
    remaining_after: poolRemaining,
    message: `Submitted ${validation.days} day(s) of ${leaveType} for approval. `
      + `You have ${poolRemaining} day(s) remaining.${notes}`,
  });
}));

app.post('/chat', requireApiKey, asyncHandler(async (req, res) => {
  const message = req.body.message || '';
  if (!message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  if (kbError !== null) {
    res.status(503).json({
      error: 'Policy knowledge base is unavailable',
      request_id: req.requestId,
    });
    return;
  }

  counters.chat_requests_total += 1;
  const retrieval = await retrieveContext(message);
  if (!retrieval.context) {
    counters.chat_no_policy_total += 1;
  }

  const generated = await generateAnswer(message, retrieval);
  res.json({
    answer: generated.answer,
    sources: retrieval.sources,
    retrieval_mode: retrieval.mode,
    generated_by: generated.generated_by,
    ...(generated.llm_status ? { llm_status: generated.llm_status } : {}),
  });
}));

/**
 * Approve or reject a submitted application.
 *
 * Rejecting restores the days to the pool they were taken from. Days are
 * deducted at submission time so a balance can never be spent twice by two
 * concurrent requests, which means a rejection has to give them back -- and that
 * invariant is the whole reason this endpoint exists rather than a status column
 * nobody writes to. Previously an application recorded as `submitted` and never
 * moved again.
 */
app.post('/leave-applications/:reference/decision', requireApiKey,
  asyncHandler(async (req, res) => {
    const reference = req.params.reference;
    const decision = String(req.body.decision || '').toLowerCase();
    const decidedBy = req.body.decided_by;

    if (!['approved', 'rejected'].includes(decision)) {
      res.status(400).json({
        error: "decision must be 'approved' or 'rejected'",
        request_id: req.requestId,
      });
      return;
    }
    if (!decidedBy) {
      res.status(400).json({
        error: 'decided_by is required',
        request_id: req.requestId,
      });
      return;
    }

    const application = await findApplication(reference);
    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }

    // Self-approval is the one authorisation rule that can be enforced without
    // an identity provider: the approver must not be the applicant.
    if (String(decidedBy) === String(application.employee_id)) {
      res.status(403).json({
        error: 'An application cannot be decided by the employee who filed it',
        request_id: req.requestId,
      });
      return;
    }

    if (application.status !== 'submitted') {
      res.status(409).json({
        error: `Application ${reference} is already ${application.status}`,
        request_id: req.requestId,
      });
      return;
    }

    let restored = null;
    if (decision === 'rejected') {
      const pool = POOL_FOR_TYPE[application.leave_type];
      await commitUsage(application.employee_id, pool, -application.days);
      const usage = await readUsage(application.employee_id);
      const balance = balancePayload(application.employee_id, usage);
      restored = pool === 'casual_leave'
        ? balance.casual_leave_balance
        : balance.combined_annual_sick_leave_balance;
    }

    await setApplicationStatus(reference, decision, decidedBy);
    addNotification({
      employeeId: application.employee_id,
      referenceId: reference,
      decision,
      leaveType: application.leave_type,
      days: application.days,
      decidedBy,
    });
    counters.leave_decisions_total += 1;

    res.json({
      reference_id: reference,
      employee_id: application.employee_id,
      leave_type: application.leave_type,
      days: application.days,
      status: decision,
      decided_by: decidedBy,
      ...(restored === null ? {} : { restored_balance: restored }),
      message: decision === 'approved'
        ? `Approved ${application.days} day(s) of ${application.leave_type}.`
        : `Rejected ${application.days} day(s) of ${application.leave_type}. `
          + `${application.days} day(s) returned to the balance.`,
    });
  }));

app.get('/leave-applications', requireApiKey, session.attachPrincipal,
  session.requireSelfOrApprover((req) => req.query.employee_id),
  asyncHandler(async (req, res) => {
  if (mongoUsable()) {
    const applications = await LeaveApplication.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ applications });
    return;
  }

  res.json({ applications: fallbackLeaveApplications.slice(-50).reverse() });
}));

// ---------------------------------------------------------------------------
// Intent classification
//
// Moved here from the Flutter client. All three intents require this service, so
// a client-side router was pure duplication -- and the client-side retriever it
// sat next to had already proved that two copies of a decision drift apart.
//
// The classifier is fitted on eval/intent_training.json and needs a query
// embedded at request time, so it is subject to the same RETRIEVAL_MODE gating as
// dense retrieval. With embeddings unavailable, the rules run and the response
// says so.
// ---------------------------------------------------------------------------
function loadIntentClassifier() {
  intentClassifier = null;
  if (!vectorStore) return;
  try {
    const training = JSON.parse(fs.readFileSync(INTENT_TRAINING_PATH, 'utf8'));
    const built = intentModule.buildClassifier(training.cases, vectorStore.queries);
    if (built.missing.length) {
      console.error(
        `${built.missing.length} intent training example(s) have no embedding; `
        + 'intent classification will use rules only. Run `npm run embed`.',
      );
      return;
    }
    intentClassifier = built;
  } catch (error) {
    console.error(`intent classifier unavailable, using rules: ${error.message}`);
  }
}

/** Classify a message, embedding it if the configured mode allows. */
async function classifyIntent(message) {
  const { mode } = activeRetrievalMode();
  if (mode === 'lexical' || !intentClassifier) {
    return intentModule.route(message, null, null);
  }
  try {
    const vector = vectorStore.queries[message]
      || await embeddings.embedUtterance(message);
    return intentModule.route(message, intentClassifier, vector);
  } catch (error) {
    counters.intent_embedding_failures_total += 1;
    console.error(`intent embedding unavailable, using rules: ${error.message}`);
    return intentModule.route(message, null, null);
  }
}

app.post('/intent', requireApiKey, asyncHandler(async (req, res) => {
  const message = req.body.message || '';
  if (!message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const result = await classifyIntent(message);
  counters.intent_requests_total += 1;
  counters[`intent_via_${result.method}_total`] =
    (counters[`intent_via_${result.method}_total`] || 0) + 1;

  res.json({
    intent: result.intent,
    method: result.method,
    confidence: result.confidence,
  });
}));

// ---------------------------------------------------------------------------
// Decision notifications
//
// A decision the applicant is never told about is not a workflow. Notifications
// are written when a decision is recorded and read back per employee, so the app
// can surface "your leave was rejected" rather than leaving the employee to
// notice their balance moved.
//
// Deliberately a table this service owns rather than email or push: those need
// credentials and an external dependency, and every other dependency here is
// optional by design. What matters is that the decision produces a durable
// record addressed to someone.
// ---------------------------------------------------------------------------
// Storage and delivery live in notifications.js. Two things changed there and
// both were open items: the array is now written through to a file, so a restart
// with no MongoDB configured no longer loses every decision anyone was told
// about -- which was the default path, not an edge case -- and an outbound
// webhook can now hand the notification to something that knows how to reach a
// person. That is a seam, not email or push, and it is described as one.
function addNotification({ employeeId, referenceId, decision, leaveType, days, decidedBy }) {
  notificationStore.add({
    id: `NTF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    employee_id: String(employeeId),
    reference_id: referenceId,
    decision,
    leave_type: leaveType,
    days,
    decided_by: String(decidedBy),
    read: false,
    created_at: new Date().toISOString(),
    message: decision === 'approved'
      ? `Your request for ${days} day(s) of ${leaveType} (${referenceId}) was approved.`
      : `Your request for ${days} day(s) of ${leaveType} (${referenceId}) was `
        + `rejected. ${days} day(s) have been returned to your balance.`,
  });
  counters.notifications_created_total += 1;
}

/**
 * Mint a session token for a demo employee.
 *
 * This endpoint is exactly as trustworthy as the demo identity behind it: it
 * will issue a token for any employee id it is asked for, because there is
 * nothing here to authenticate anyone against. It is the seam an identity
 * provider would replace, and it is named and documented as that rather than
 * dressed up as a login.
 *
 * What the token then does is real: every employee-scoped route checks the
 * request's subject against it, so 1001 cannot read 1002's balance by editing a
 * query string -- which, before this, it could.
 */
app.post('/session', requireApiKey, asyncHandler(async (req, res) => {
  if (!session.isEnforced()) {
    res.status(409).json({
      error: 'Session tokens are disabled. Set SESSION_SECRET to enable '
        + 'per-employee authorization; without it every endpoint accepts any '
        + 'employee_id, which /health reports as authorization: none.',
    });
    return;
  }
  const employeeId = req.body.employee_id;
  const role = req.body.role || 'employee';
  if (!employeeId) {
    res.status(400).json({ error: 'employee_id is required' });
    return;
  }
  if (!session.ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of ${session.ROLES.join(', ')}` });
    return;
  }
  res.json({
    token: session.issue(employeeId, role),
    employee_id: String(employeeId),
    role,
    expires_in: session.DEFAULT_TTL_SECONDS,
    caveat: 'This does not authenticate anyone. It signs the demo identity you '
      + 'asked for so that scoping can be enforced downstream.',
  });
}));

app.get('/notifications', requireApiKey, session.attachPrincipal,
  session.requireSelfOrApprover((req) => req.query.employee_id),
  asyncHandler(async (req, res) => {
  const employeeId = req.query.employee_id;
  if (!employeeId) {
    res.status(400).json({ error: 'employee_id is required' });
    return;
  }

  const unreadOnly = String(req.query.unread || '') === 'true';
  const notifications = notificationStore.forEmployee(employeeId, { unreadOnly });

  res.json({ notifications, unread: notifications.filter((n) => !n.read).length });
}));

app.post('/notifications/:id/ack', requireApiKey, asyncHandler(async (req, res) => {
  const notification = notificationStore.markRead(req.params.id);
  if (!notification) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }
  res.json({ id: notification.id, read: true });
}));

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    request_id: req.requestId,
  });
});

app.use((err, req, res, next) => {
  counters.errors_total += 1;
  console.error(err);
  res.status(500).json({
    error: 'Internal server error',
    request_id: req.requestId,
  });
});

if (require.main === module) {
  const config = llm.readConfig();
  if (config.usedLegacyKey) {
    console.log(
      'GEMINI_API_KEY is set but LLM_PROVIDER is not; treating it as '
      + 'LLM_PROVIDER=gemini. Prefer LLM_PROVIDER / LLM_API_KEY / LLM_MODEL.',
    );
  }
  console.log(
    `LLM: ${llm.isConfigured() ? config.provider : 'none (answers come straight '
      + 'from the knowledge base)'}`,
  );

  connectMongo().then(() => {
    app.listen(port, () => {
      console.log(`HR Backend API running at http://localhost:${port}`);
    });
  });
} else {
  connectMongo();
}

module.exports = app;
module.exports.determineLeaveType = determineLeaveType;
module.exports.retrieveContext = retrieveContext;
module.exports.loadKnowledgeBase = loadKnowledgeBase;
module.exports.activeRetrievalMode = activeRetrievalMode;
module.exports.configuredRetrievalMode = configuredRetrievalMode;
module.exports.classifyIntent = classifyIntent;

/**
 * Restore the seeded in-memory demo data.
 *
 * Exported for tests only. Without it the fallback usage store accumulates
 * across cases in a single process, so tests pass or fail depending on the order
 * they happen to run in -- which is its own kind of test that cannot be trusted.
 */
module.exports.__resetDemoData = () => {
  fallbackLeaveApplications.length = 0;
  notificationStore.__reset(process.env.NOTIFICATIONS_PATH);
  for (const key of Object.keys(fallbackLeaveUsage)) delete fallbackLeaveUsage[key];
  Object.assign(fallbackLeaveUsage, SEEDED_LEAVE_USAGE());
};
