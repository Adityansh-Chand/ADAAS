'use strict';

/**
 * Notification storage and delivery.
 *
 * TWO GAPS THIS CLOSES, AND ONE IT DOES NOT
 *
 * The README carried both as open items. Notifications lived in a module-level
 * array, so with no MongoDB configured a restart lost every decision anyone had
 * been told about -- and since the in-memory path is the default, that is the
 * path most people ran. And there was no delivery of any kind: a decision was
 * recorded in a table and nobody was informed unless they happened to open the
 * app and look.
 *
 * Storage is now durable by default: the same array, written through to a JSON
 * file. Delivery is now possible: an outbound webhook, when one is configured.
 *
 * What this is NOT is email or push. A webhook is a seam -- it hands the
 * notification to something else that knows how to reach a person, and that
 * something else does not exist here. Calling it "delivery" without saying so
 * would be the kind of overstatement this project spends its effort avoiding.
 *
 * WHY A FILE RATHER THAN sqlite
 *
 * The volume is one row per leave decision. A file that is read once at startup
 * and appended to is enough for that, adds no dependency, and can be inspected
 * with `cat` when something goes wrong. If this ever needs querying it should
 * move to Mongo, which the service already speaks when it is configured.
 *
 * WHY DELIVERY CANNOT FAIL A DECISION
 *
 * The decision is the durable fact; telling someone about it is a consequence of
 * it. If the webhook is slow or down, the approval has still happened and the
 * balance has still moved, so a delivery failure is recorded and the request
 * still succeeds. The alternative -- rolling back an approval because a
 * notification did not send -- would be a worse system, and the failure count is
 * exposed in /metrics so "nobody is being told" is visible rather than silent.
 */

const fs = require('fs');
const path = require('path');

const smtp = require('./smtp');

const DEFAULT_STORE_PATH = process.env.NOTIFICATIONS_PATH
  || path.resolve(__dirname, '.data', 'notifications.json');

// A notification is small and the webhook is a courtesy, not a dependency. Two
// seconds is long enough for a healthy endpoint and short enough that a dead one
// does not become the API's latency.
const WEBHOOK_TIMEOUT_MS = Number(process.env.NOTIFY_WEBHOOK_TIMEOUT_MS || 2000);

let storePath = DEFAULT_STORE_PATH;
let notifications = [];
let loaded = false;
let writeError = null;
const counters = {
  delivered: 0, delivery_failures: 0, persist_failures: 0,
  emailed: 0, email_failures: 0,
};

function webhookUrl() {
  return (process.env.NOTIFY_WEBHOOK_URL || '').trim() || null;
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      notifications = Array.isArray(parsed) ? parsed : [];
    }
  } catch (error) {
    // A corrupt store must not stop the service booting. It is reported and
    // started fresh, because the alternative -- refusing to serve leave balances
    // because a notification file has a stray brace -- is worse than losing
    // notifications that were already only a convenience.
    writeError = `could not read ${storePath}: ${error.message}`;
    console.error(writeError);
    notifications = [];
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    // Written whole and renamed into place, so a crash mid-write leaves the
    // previous file rather than a truncated one.
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(notifications, null, 2)}\n`);
    fs.renameSync(tmp, storePath);
    writeError = null;
  } catch (error) {
    counters.persist_failures += 1;
    writeError = `could not write ${storePath}: ${error.message}`;
    console.error(writeError);
  }
}

/**
 * Hand the notification to whatever knows how to reach a person.
 *
 * Deliberately fire-and-forget from the caller's point of view: it returns a
 * promise so tests can await it, and `add` does not.
 */
/**
 * Email, when a relay is configured and the notification names a recipient.
 *
 * Recipient resolution is deliberately explicit: `NOTIFY_EMAIL_TO` is a single
 * address every notification goes to -- an HR mailbox -- because this service has
 * no directory and inventing an address from an employee id would be a guess that
 * silently mails the wrong person. A real deployment routes per-employee through
 * the identity provider's directory, which is the same seam OIDC opened.
 */
async function deliverEmail(notification) {
  const to = (process.env.NOTIFY_EMAIL_TO || '').trim();
  if (!to || !smtp.isConfigured()) return { attempted: false };
  try {
    await smtp.send({
      to,
      subject: `Leave ${notification.decision}: ${notification.reference_id}`,
      text: `${notification.message}

`
        + `Employee: ${notification.employee_id}
`
        + `Reference: ${notification.reference_id}
`
        + `Decided by: ${notification.decided_by}
`,
    });
    counters.emailed += 1;
    return { attempted: true, ok: true };
  } catch (error) {
    counters.email_failures += 1;
    console.error(`notification ${notification.id} not emailed: ${error.message}`);
    return { attempted: true, ok: false, error: error.message };
  }
}

async function deliver(notification) {
  const url = webhookUrl();
  const email = await deliverEmail(notification);
  if (!url) return email.attempted ? { attempted: true, email } : { attempted: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`webhook returned ${response.status}`);
    counters.delivered += 1;
    return { attempted: true, ok: true };
  } catch (error) {
    counters.delivery_failures += 1;
    console.error(`notification ${notification.id} not delivered: ${error.message}`);
    return { attempted: true, ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function add(notification) {
  load();
  notifications.push(notification);
  persist();
  // Not awaited: the decision is the durable fact and delivery is a consequence
  // of it. A slow webhook must not become the approver's latency.
  const delivery = deliver(notification);
  return { notification, delivery };
}

function forEmployee(employeeId, { unreadOnly = false, limit = 50 } = {}) {
  load();
  return notifications
    .filter((n) => n.employee_id === String(employeeId))
    .filter((n) => !unreadOnly || !n.read)
    .slice(-limit)
    .reverse();
}

function markRead(id) {
  load();
  const found = notifications.find((n) => n.id === id);
  if (!found) return null;
  found.read = true;
  persist();
  return found;
}

function all() {
  load();
  return notifications;
}

/** Test seam: point at a scratch file and start empty. */
function __reset(nextPath) {
  storePath = nextPath || DEFAULT_STORE_PATH;
  notifications = [];
  loaded = true;
  writeError = null;
  counters.delivered = 0;
  counters.delivery_failures = 0;
  counters.persist_failures = 0;
  counters.emailed = 0;
  counters.email_failures = 0;
}

function status() {
  load();
  return {
    stored: notifications.length,
    path: storePath,
    webhook: webhookUrl() ? 'configured' : 'none',
    email: smtp.isConfigured()
      ? (process.env.NOTIFY_EMAIL_TO ? 'configured' : 'relay set, NOTIFY_EMAIL_TO missing')
      : 'none',
    error: writeError || undefined,
    ...counters,
  };
}

module.exports = {
  add, forEmployee, markRead, all, status, deliver, __reset, counters,
};
