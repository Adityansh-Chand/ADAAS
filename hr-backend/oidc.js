'use strict';

/**
 * Verifying an ID token from a real identity provider.
 *
 * WHAT THIS CHANGES
 *
 * `session.js` enforces per-employee scoping, and it does that well: employee
 * 1001 cannot read 1002's balance by editing a query string. What it never did is
 * establish that the caller IS 1001 — `/session` mints a token for any employee id
 * it is handed, because there was nothing to authenticate against. The README has
 * carried "no identity provider" as an open item on exactly that basis.
 *
 * This is the missing half. When `OIDC_ISSUER` and `OIDC_AUDIENCE` are set, the
 * service accepts an ID token issued by that provider, verifies it properly, and
 * derives the employee id from a claim. The demo minting path stays available and
 * stays clearly labelled, so a fresh clone still runs with no configuration.
 *
 * WHAT IS VERIFIED, AND WHY EACH CHECK IS HERE
 *
 * Every one of these has been the subject of a real, repeated vulnerability class,
 * so none is optional and none is inferred from another:
 *
 *   signature      RS256 over the provider's published JWKS. The algorithm is
 *                  pinned rather than read from the token header -- `alg: none`
 *                  and HS256/RS256 confusion are the two classic JWT forgeries,
 *                  and both work by getting the verifier to trust the attacker's
 *                  choice of algorithm.
 *   kid            the key is selected by the header's `kid` from the fetched
 *                  set. A token naming an unknown key is rejected rather than
 *                  tried against every key.
 *   iss            must equal the configured issuer exactly. Without this, a
 *                  token from any provider whose keys we happen to have fetched
 *                  would pass.
 *   aud            must contain the configured audience. This is what stops a
 *                  token minted for a different application at the same provider
 *                  from working here -- a real and common cross-application
 *                  confusion.
 *   exp / nbf      with a small clock skew allowance, because provider and
 *                  service clocks differ by seconds and a zero allowance rejects
 *                  valid tokens intermittently, which is worse than a 60-second
 *                  window.
 *
 * WHAT IS NOT DONE, STATED RATHER THAN IMPLIED
 *
 * No authorization-code flow, no PKCE, no refresh handling, no session cookie.
 * This verifies a token the client already obtained; obtaining it is the client's
 * job and the Flutter app does not do it. So this closes "the backend cannot
 * verify anyone" and does not close "the app logs people in".
 *
 * The employee id comes from a configurable claim (`OIDC_EMPLOYEE_CLAIM`,
 * defaulting to `sub`). Mapping a directory identity onto an HR employee number is
 * a deployment concern and there is no correct universal answer, so it is a
 * setting rather than a guess.
 */

const crypto = require('crypto');

// Providers rotate signing keys, and re-fetching JWKS on every request would make
// the provider a hard dependency of every call. Cached, with a refresh when an
// unknown `kid` appears -- which is exactly what a rotation looks like from here.
const JWKS_TTL_MS = Number(process.env.OIDC_JWKS_TTL_MS || 10 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.OIDC_TIMEOUT_MS || 5000);
const CLOCK_SKEW_SECONDS = Number(process.env.OIDC_CLOCK_SKEW_SECONDS || 60);

let cache = { keys: null, fetchedAt: 0, jwksUri: null };

function issuer() {
  return (process.env.OIDC_ISSUER || '').trim().replace(/\/+$/, '') || null;
}

function audience() {
  return (process.env.OIDC_AUDIENCE || '').trim() || null;
}

function employeeClaim() {
  return (process.env.OIDC_EMPLOYEE_CLAIM || 'sub').trim();
}

/** Both are required: an issuer with no audience check is not a working verifier. */
function isConfigured() {
  return Boolean(issuer() && audience());
}

function b64urlToBuffer(value) {
  return Buffer.from(value, 'base64url');
}

function decodeSegment(segment) {
  return JSON.parse(b64urlToBuffer(segment).toString('utf8'));
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discovery, then JWKS. The discovery document is what makes `OIDC_ISSUER` the
 * only URL an operator has to supply, and it is also where the issuer's own idea
 * of its name comes from -- checked against the configured one, because a
 * discovery document that names a different issuer is either a misconfiguration
 * or a redirect somewhere unintended.
 */
async function fetchKeys({ force = false } = {}) {
  const iss = issuer();
  if (!iss) throw new Error('OIDC_ISSUER is not set');

  const fresh = cache.keys && (Date.now() - cache.fetchedAt) < JWKS_TTL_MS;
  if (fresh && !force) return cache.keys;

  const discovery = await getJson(`${iss}/.well-known/openid-configuration`);
  if (discovery.issuer && discovery.issuer.replace(/\/+$/, '') !== iss) {
    throw new Error(
      `discovery document names issuer ${discovery.issuer}, expected ${iss}`,
    );
  }
  if (!discovery.jwks_uri) throw new Error('discovery document has no jwks_uri');

  const jwks = await getJson(discovery.jwks_uri);
  if (!Array.isArray(jwks.keys)) throw new Error('JWKS has no keys array');

  cache = { keys: jwks.keys, fetchedAt: Date.now(), jwksUri: discovery.jwks_uri };
  return cache.keys;
}

function keyFor(keys, kid) {
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  if (jwk.kty !== 'RSA') return null;
  // Node imports a JWK directly, so there is no hand-rolled DER assembly here --
  // which is a place implementations get subtly wrong and never notice, because
  // a wrong key fails closed and looks like a bad token.
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verify an ID token. Returns the claims, or throws with a reason.
 *
 * Throws rather than returning null because, unlike the demo token in session.js,
 * the failure reasons here are operationally distinct: an expired token means try
 * again, an audience mismatch means the client is configured for a different
 * application, and an unreachable provider means something is down. Those need
 * different responses from whoever is on call, and collapsing them loses that.
 * The API surface still returns 401 for all of them.
 */
async function verifyIdToken(token) {
  if (!isConfigured()) throw new Error('OIDC is not configured');
  if (typeof token !== 'string') throw new Error('token must be a string');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWS compact serialization');
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeSegment(headerB64);
  // Pinned, not read. Accepting the token's own `alg` is how `alg: none` and
  // HS256-with-the-public-key-as-secret both work.
  if (header.alg !== 'RS256') {
    throw new Error(`unsupported alg ${header.alg}; only RS256 is accepted`);
  }
  if (!header.kid) throw new Error('token header has no kid');

  let keys = await fetchKeys();
  let key = keyFor(keys, header.kid);
  if (!key) {
    // An unknown kid is what a key rotation looks like from here, so refetch once
    // before rejecting. Once, not in a loop: a token naming a kid that will never
    // exist must not turn into unbounded requests to the provider.
    keys = await fetchKeys({ force: true });
    key = keyFor(keys, header.kid);
  }
  if (!key) throw new Error(`no RSA key with kid ${header.kid}`);

  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    key,
    b64urlToBuffer(signatureB64),
  );
  if (!verified) throw new Error('signature does not verify');

  const claims = decodeSegment(payloadB64);
  const now = Math.floor(Date.now() / 1000);

  if (claims.iss !== issuer()) {
    throw new Error(`iss ${claims.iss} does not match ${issuer()}`);
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience())) {
    throw new Error(`aud ${JSON.stringify(claims.aud)} does not include ${audience()}`);
  }
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw new Error('token is expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    throw new Error('token is not yet valid');
  }

  const employeeId = claims[employeeClaim()];
  if (employeeId === undefined || employeeId === null || `${employeeId}` === '') {
    throw new Error(
      `token has no ${employeeClaim()} claim to use as the employee id; `
      + 'set OIDC_EMPLOYEE_CLAIM to the claim your provider puts it in',
    );
  }

  return { claims, employeeId: String(employeeId) };
}

/** Test seam, and useful after a deliberate rotation. */
function __clearCache() {
  cache = { keys: null, fetchedAt: 0, jwksUri: null };
}

function status() {
  return {
    configured: isConfigured(),
    issuer: issuer() || undefined,
    audience: audience() || undefined,
    employee_claim: isConfigured() ? employeeClaim() : undefined,
    keys_cached: cache.keys ? cache.keys.length : 0,
  };
}

module.exports = {
  isConfigured,
  issuer,
  audience,
  employeeClaim,
  verifyIdToken,
  fetchKeys,
  status,
  __clearCache,
  CLOCK_SKEW_SECONDS,
};
