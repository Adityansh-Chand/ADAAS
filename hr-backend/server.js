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
const {
  ENTITLEMENTS,
  determineLeaveType,
  parseRequestedDays,
  validateRequest,
} = require('./leave_rules');

dotenv.config();

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
const KB_PATH = process.env.KB_PATH
  ? path.resolve(process.env.KB_PATH)
  : path.resolve(__dirname, '..', 'assets', 'hr_knowledge_base.json');
let knowledgeBase = [];
let retrievalIndex = null;
let kbError = null;

function loadKnowledgeBase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('knowledge base is empty');
    }
    knowledgeBase = parsed;
    retrievalIndex = buildIndex(knowledgeBase);
    kbError = null;
  } catch (err) {
    knowledgeBase = [];
    retrievalIndex = null;
    kbError = err.message;
    console.error(`Failed to load knowledge base from ${KB_PATH}: ${err.message}`);
  }
  return kbError === null;
}

loadKnowledgeBase();

// ---------------------------------------------------------------------------
// In-memory demo data
//
// Seeded as days *used* against the entitlements in leave_rules.js, which are
// transcribed from the policy corpus. Storing "used" rather than "remaining"
// means the numbers cannot drift out of agreement with the policy text.
// ---------------------------------------------------------------------------
const fallbackLeaveApplications = [];
const SEEDED_LEAVE_USAGE = () => ({
  '1001': { casual_leave: 1, combined_annual_sick_leave: 3 },
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

function retrieveContext(message) {
  if (!retrievalIndex) {
    return { sources: [], primaryAnswer: '', context: '', matches: [] };
  }

  const ranked = retrieve(message, retrievalIndex, { topK: 5 });

  return {
    matches: ranked,
    sources: ranked.map((item) => item.entry.source),
    primaryAnswer: ranked[0]?.entry.answer || '',
    context: ranked
      .map((item) => `Source: ${item.entry.source}\nPolicy Details: ${item.entry.answer}`)
      .join('\n\n'),
  };
}

function groundedAnswer(retrieval) {
  return `${retrieval.primaryAnswer}\n\nSource: ${retrieval.sources[0]}`;
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

async function commitUsage(employeeId, pool, days) {
  if (mongoUsable()) {
    const field = pool === 'casual_leave'
      ? 'casualLeaveUsed'
      : 'combinedAnnualSickLeaveUsed';
    await LeaveBalance.updateOne(
      { employeeId },
      { $inc: { [field]: days } },
      { upsert: true },
    );
    return;
  }

  const usage = fallbackLeaveUsage[employeeId];
  usage[pool] = (usage[pool] || 0) + days;
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
  };
  res.status(ready ? 200 : 503).json(body);
});

app.get('/metrics', (req, res) => {
  res.json({
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    counters,
    dataSource: mongoUsable() ? 'mongodb' : 'memory',
    knowledge_base_entries: knowledgeBase.length,
  });
});

app.get('/leave-balance', requireApiKey, asyncHandler(async (req, res) => {
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

app.post('/leave-application', requireApiKey, asyncHandler(async (req, res) => {
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
  const retrieval = retrieveContext(message);
  if (!retrieval.context) {
    counters.chat_no_policy_total += 1;
  }

  const generated = await generateAnswer(message, retrieval);
  res.json({
    answer: generated.answer,
    sources: retrieval.sources,
    generated_by: generated.generated_by,
    ...(generated.llm_status ? { llm_status: generated.llm_status } : {}),
  });
}));

app.get('/leave-applications', requireApiKey, asyncHandler(async (req, res) => {
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

/**
 * Restore the seeded in-memory demo data.
 *
 * Exported for tests only. Without it the fallback usage store accumulates
 * across cases in a single process, so tests pass or fail depending on the order
 * they happen to run in -- which is its own kind of test that cannot be trusted.
 */
module.exports.__resetDemoData = () => {
  fallbackLeaveApplications.length = 0;
  for (const key of Object.keys(fallbackLeaveUsage)) delete fallbackLeaveUsage[key];
  Object.assign(fallbackLeaveUsage, SEEDED_LEAVE_USAGE());
};
