const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');

const LeaveApplication = require('./models/LeaveApplication');
const LeaveBalance = require('./models/LeaveBalance');

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
  leave_applications_total: 0,
};
const fallbackLeaveApplications = [];

const fallbackLeaveBalances = {
  '1001': {
    employeeId: '1001',
    casual_leave_balance: 5,
    sick_leave_balance: 8,
    annual_leave_balance: 12,
  },
};

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

  if (req.header('x-api-key') !== expectedApiKey) {
    res.status(401).json({ error: 'Invalid or missing API key', request_id: req.requestId });
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

function loadKnowledgeBase() {
  const file = path.resolve(__dirname, '..', 'assets', 'hr_knowledge_base.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function retrieveContext(message) {
  const lower = message.toLowerCase();
  const matches = loadKnowledgeBase()
    .map((entry) => {
      const keywordHits = entry.keywords.filter((keyword) =>
        lower.includes(String(keyword).toLowerCase())
      ).length;
      const categoryBoost = lower.includes(String(entry.category).toLowerCase()) ? 2 : 0;
      return {
        entry,
        score: keywordHits + categoryBoost,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry);

  return {
    sources: matches.map((entry) => entry.source),
    primaryAnswer: matches[0]?.answer || '',
    context: matches
      .map((entry) => `Source: ${entry.source}\nPolicy Details: ${entry.answer}`)
      .join('\n\n'),
  };
}

async function generateAnswer(message, retrieval) {
  if (!retrieval.context) {
    return "I couldn't find a matching company policy for that question.";
  }

  if (!process.env.GEMINI_API_KEY) {
    return `${retrieval.primaryAnswer}\n\nSource: ${retrieval.sources[0]}`;
  }

  const prompt = [
    'You are ADAAS, a corporate HR assistant.',
    'Answer only from the provided context and cite the source.',
    `Context:\n${retrieval.context}`,
    `Question: ${message}`,
  ].join('\n\n');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    }),
  });
  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    `${retrieval.primaryAnswer}\n\nSource: ${retrieval.sources[0]}`;
}

function determineLeaveType(requestText) {
  const lower = requestText.toLowerCase();
  if (lower.includes('sick')) return 'Sick Leave';
  if (lower.includes('annual') || lower.includes('earned')) return 'Annual Leave';
  return 'Casual Leave';
}

async function findLeaveBalance(employeeId) {
  if (mongoReady && mongoose.connection.readyState === 1) {
    const data = await LeaveBalance.findOne({ employeeId });
    if (data) return data;
  }

  return fallbackLeaveBalances[employeeId] || null;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    dataSource: mongoReady ? 'mongodb' : 'memory',
  });
});

app.get('/metrics', (req, res) => {
  res.json({
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    counters,
    dataSource: mongoReady ? 'mongodb' : 'memory',
  });
});

app.get('/leave-balance', requireApiKey, asyncHandler(async (req, res) => {
  const employeeId = req.query.employee_id;
  if (!employeeId) {
    res.status(400).json({ error: 'employee_id is required' });
    return;
  }

  const data = await findLeaveBalance(employeeId);
  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: 'Employee not found' });
  }
}));

app.post('/leave-application', requireApiKey, asyncHandler(async (req, res) => {
  const employeeId = req.body.employee_id;
  const requestText = req.body.request_text || '';
  if (!employeeId || !requestText) {
    res.status(400).json({ error: 'employee_id and request_text are required' });
    return;
  }

  const leaveType = determineLeaveType(requestText);
  const referenceId = `LMS-${Date.now().toString().slice(-6)}`;
  const application = {
    employee_id: employeeId,
    leave_type: leaveType,
    reference_id: referenceId,
    status: 'submitted',
    message: `Success! Your request for **${leaveType}** has been submitted for approval.`,
  };

  if (mongoReady && mongoose.connection.readyState === 1) {
    await LeaveApplication.create({
      employeeId,
      leaveType,
      requestText,
      referenceId,
    });
  } else {
    fallbackLeaveApplications.push({ ...application, request_text: requestText, created_at: new Date().toISOString() });
  }

  counters.leave_applications_total += 1;
  res.json(application);
}));

app.post('/chat', requireApiKey, asyncHandler(async (req, res) => {
  const message = req.body.message || '';
  if (!message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  counters.chat_requests_total += 1;
  const retrieval = retrieveContext(message);
  const answer = await generateAnswer(message, retrieval);
  res.json({ answer, sources: retrieval.sources });
}));

app.get('/leave-applications', requireApiKey, asyncHandler(async (req, res) => {
  if (mongoReady && mongoose.connection.readyState === 1) {
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
