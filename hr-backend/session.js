'use strict';

/**
 * Who is this request acting as, and are they allowed to?
 *
 * WHAT THIS IS, STATED BEFORE WHAT IT DOES
 *
 * This is NOT an identity provider. It does not verify that anyone is who they
 * say they are -- there is no password, no directory, no SSO, and `/session`
 * will mint a token for any employee id a caller asks for. The README's open
 * item about identity is not closed by this file and still says so.
 *
 * What it does close is a different and previously unaddressed gap: even taking
 * the demo identity at face value, nothing enforced it. `HR_EMPLOYEE_ID` chose
 * which employee the app displayed, and then every endpoint accepted whatever
 * `employee_id` the request carried. Employee 1001 could read 1002's leave
 * balance by editing a query string, and could approve their own application by
 * naming someone else as the approver. Those are authorisation bugs, and they do
 * not need an identity provider to fix.
 *
 * So: a signed token carries a subject and a role, and endpoints check the
 * request against it. The subject is unverified; the scoping is enforced.
 *
 * WHY IT IS OPT-IN
 *
 * Enabled by setting SESSION_SECRET, in the same way API_KEY enables the API key
 * check. With it unset the service behaves exactly as before, which keeps the
 * zero-configuration demo path working -- the property the whole project is built
 * around. `GET /health` reports which of the two it is in, so "unauthenticated"
 * is a visible state rather than an assumption.
 *
 * That is a real limitation and not a hidden one: a deployment that forgets the
 * variable is unprotected. The alternative -- making it mandatory -- would mean a
 * fresh clone cannot run without generating a secret, and would trade a
 * documented weakness for an undocumented barrier.
 *
 * WHY HMAC AND NOT A JWT LIBRARY
 *
 * The token needs to carry three fields and survive a round trip. A dependency
 * for that is a dependency to audit, and JWT's algorithm field is a well-known
 * footgun -- `alg: none` and RS256/HS256 confusion are both real, repeated
 * vulnerabilities. A fixed HMAC-SHA256 over a fixed payload shape has no
 * algorithm to negotiate and no confusion to have.
 */

const crypto = require('crypto');

const oidc = require('./oidc');

// Long enough that expiry is not a demo annoyance, short enough that a leaked
// token is not permanent.
const DEFAULT_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 12 * 3600);

const ROLES = ['employee', 'approver'];

function secret() {
  return (process.env.SESSION_SECRET || '').trim() || null;
}

/** Is authorisation being enforced at all? Reported by /health. */
function isEnforced() {
  return Boolean(secret()) || oidc.isConfigured();
}

/**
 * Which of the two is establishing identity, reported by /health.
 *
 *   oidc    an ID token from a configured provider, signature and claims verified
 *   demo    a token this service minted for whatever employee id it was asked for
 *   none    nothing is enforced
 *
 * Both can be on at once, and that is a deliberate deployment shape rather than an
 * oversight: an operator turning on OIDC keeps the demo path working until the
 * client is migrated. It is also a real weakening -- a demo token still passes --
 * so it is named in /health rather than left to be discovered.
 */
function mode() {
  if (oidc.isConfigured() && secret()) return 'oidc+demo';
  if (oidc.isConfigured()) return 'oidc';
  if (secret()) return 'demo';
  return 'none';
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

function issue(employeeId, role = 'employee', ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!isEnforced()) throw new Error('SESSION_SECRET is not set');
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  const payload = {
    sub: String(employeeId),
    role,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * Verify and decode. Returns null for anything that is not a valid, unexpired
 * token -- the caller turns that into a 401, and no distinction is made between
 * "malformed", "bad signature" and "expired", because telling an attacker which
 * of the three it was is free information.
 */
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, provided] = token.split('.');
  if (!body || !provided) return null;

  const expected = sign(body);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== 'string') return null;
  if (!ROLES.includes(payload.role)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

/**
 * Express middleware: attach `req.principal` when a valid token is present.
 *
 * With SESSION_SECRET unset this attaches nothing and lets everything through,
 * which is the documented demo mode.
 */
async function attachPrincipal(req, res, next) {
  if (!isEnforced()) { next(); return; }
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({
      error: 'A bearer token is required',
      request_id: req.requestId,
    });
    return;
  }

  // The demo token is tried first and is cheap: it is a local HMAC, so a token
  // this service minted is recognised without a network call. An OIDC token
  // cannot pass that check -- different shape, different signature -- so there is
  // no ambiguity about which verifier accepted what, and `principal.via` records
  // it either way.
  const demo = secret() ? verify(token) : null;
  if (demo) {
    req.principal = { ...demo, via: 'demo' };
    next();
    return;
  }

  if (oidc.isConfigured()) {
    try {
      const { claims, employeeId } = await oidc.verifyIdToken(token);
      req.principal = {
        sub: employeeId,
        // Role comes from the provider when it sends one, and defaults to
        // employee. Defaulting to approver would let any authenticated person act
        // for anyone else, which is the failure this whole layer exists to stop.
        role: ROLES.includes(claims[process.env.OIDC_ROLE_CLAIM || 'adaas_role'])
          ? claims[process.env.OIDC_ROLE_CLAIM || 'adaas_role']
          : 'employee',
        via: 'oidc',
        claims,
      };
      next();
      return;
    } catch (error) {
      // The reason is logged, not returned. Telling a caller whether the
      // signature, the audience or the expiry failed is free reconnaissance.
      console.error(`OIDC rejected a token: ${error.message}`);
    }
  }

  res.status(401).json({
    error: 'A valid token is required',
    request_id: req.requestId,
  });
}

/**
 * The check that was missing: the employee this request is about must be the
 * employee the caller is.
 *
 * `subjectOf` pulls the employee id out of wherever the route puts it -- query
 * string, body, or a looked-up record -- so one rule covers every shape.
 * Approvers are exempt, because approving someone else's leave is their whole
 * function; that exemption is the reason `role` exists at all.
 */
function requireSelfOrApprover(subjectOf) {
  return (req, res, next) => {
    if (!isEnforced()) { next(); return; }
    const subject = String(subjectOf(req) ?? '');
    if (!subject) { next(); return; }
    if (req.principal.role === 'approver' || req.principal.sub === subject) {
      next();
      return;
    }
    res.status(403).json({
      error: `Not permitted to act for employee ${subject}`,
      request_id: req.requestId,
    });
  };
}

module.exports = {
  ROLES,
  mode,
  DEFAULT_TTL_SECONDS,
  isEnforced,
  issue,
  verify,
  attachPrincipal,
  requireSelfOrApprover,
};
