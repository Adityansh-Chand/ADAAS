'use strict';

/**
 * A minimal SMTP client, so a decision can actually reach a person.
 *
 * WHY NOT nodemailer
 *
 * It would be the obvious choice and it is a good library. It is not used here
 * for the reason the model service exists: this is the image that serves employee
 * leave records, and the previous round of work was spent taking a dependency
 * *out* of it because of unfixable transitive advisories. Adding a production
 * dependency back for one outbound message a day is the wrong trade when the
 * protocol needed is a hundred lines of it.
 *
 * WHAT IS IMPLEMENTED
 *
 * EHLO, optional STARTTLS upgrade, AUTH PLAIN or LOGIN, one MAIL FROM, one RCPT
 * TO, DATA. That is the whole path for "send one short text email to one
 * recipient through an authenticated relay", which is what this needs.
 *
 * WHAT IS NOT, STATED RATHER THAN DISCOVERED
 *
 *   - no DKIM signing, no SPF alignment help. Deliverability is the relay's job
 *     and this will not get mail into an inbox that the relay cannot.
 *   - one recipient per send. Multiple RCPT TO commands are trivial to add; the
 *     partial-failure semantics are not, and pretending otherwise is how a
 *     "delivered" count starts lying.
 *   - no attachments, no HTML alternative, no connection reuse.
 *   - no retry. Retrying a send from inside a request handler turns a slow relay
 *     into a slow API; notifications.js records the failure and moves on.
 *
 * THE TWO THINGS HAND-WRITTEN SMTP GETS WRONG
 *
 * Line endings and dot-stuffing, both handled below and both worth naming because
 * they fail in ways that look like something else. Bare LF instead of CRLF is
 * accepted by permissive relays and rejected by strict ones, so it works until it
 * does not. And a body line consisting of a single "." terminates DATA early --
 * the message is truncated and the remainder is interpreted as SMTP commands,
 * which is a message-splitting bug with a security flavour.
 */

const net = require('net');
const tls = require('tls');

const CRLF = '\r\n';

function config(env = process.env) {
  const host = (env.SMTP_HOST || '').trim();
  if (!host) return null;
  return {
    host,
    port: Number(env.SMTP_PORT || 587),
    // Implicit TLS (port 465) versus STARTTLS on a plaintext port (587). Both
    // exist in the wild; the variable says which rather than guessing from the
    // port, because guessing is wrong for anyone with a non-standard setup.
    secure: String(env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: env.SMTP_USER || null,
    pass: env.SMTP_PASS || null,
    from: env.SMTP_FROM || env.SMTP_USER || 'adaas@localhost',
    timeoutMs: Number(env.SMTP_TIMEOUT_MS || 5000),
  };
}

function isConfigured(env = process.env) {
  return Boolean(config(env));
}

/** A tiny line-oriented protocol driver over a socket. */
function session(socket, timeoutMs) {
  let buffer = '';
  const waiters = [];

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    // An SMTP reply is one or more lines; the last has a space after the code
    // rather than a hyphen. Anything else is a continuation and is not a
    // complete reply yet.
    let match = /^(\d{3}) [^\r\n]*\r\n/m.exec(buffer);
    while (match) {
      const end = buffer.indexOf(match[0]) + match[0].length;
      const reply = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ code: Number(match[1]), text: reply.trim() });
      match = /^(\d{3}) [^\r\n]*\r\n/m.exec(buffer);
    }
  });

  const expect = () => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SMTP timed out after ${timeoutMs}ms`)), timeoutMs,
    );
    waiters.push({ resolve: (r) => { clearTimeout(timer); resolve(r); } });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
  });

  const send = async (line, expected) => {
    socket.write(line + CRLF);
    const reply = await expect();
    if (expected && !expected.includes(reply.code)) {
      throw new Error(`SMTP ${line.split(' ')[0]} got ${reply.text}`);
    }
    return reply;
  };

  return { expect, send, raw: (data) => socket.write(data) };
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    const timer = setTimeout(
      () => { socket.destroy(); reject(new Error('SMTP connect timed out')); },
      cfg.timeoutMs,
    );
    socket.once(cfg.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Build the message.
 *
 * Base64 body with an explicit UTF-8 charset, rather than trusting 8BITMIME.
 * A policy name with a non-ASCII character in it would otherwise arrive mangled
 * through a relay that only speaks 7-bit, and the failure would be invisible from
 * this side.
 */
function buildMessage({ from, to, subject, text }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    `Date: ${new Date().toUTCString()}`,
  ];
  const body = Buffer.from(text, 'utf8').toString('base64')
    .replace(/(.{76})/g, `$1${CRLF}`);
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/** Escape a leading dot on any line -- see the note at the top of this file. */
function dotStuff(message) {
  return message.split(CRLF).map((l) => (l.startsWith('.') ? `.${l}` : l)).join(CRLF);
}

async function send({ to, subject, text }, env = process.env) {
  const cfg = config(env);
  if (!cfg) throw new Error('SMTP_HOST is not set');

  const socket = await connect(cfg);
  const s = session(socket, cfg.timeoutMs);
  try {
    await s.expect();
    await s.send(`EHLO ${cfg.host}`, [250]);

    if (!cfg.secure && String(env.SMTP_STARTTLS || 'true').toLowerCase() === 'true') {
      // Best effort: a relay that does not offer STARTTLS is not a reason to fail
      // a notification, but credentials must never cross a plaintext link, so
      // AUTH below is skipped if the upgrade did not happen.
      const reply = await s.send('STARTTLS');
      if (reply.code === 220) {
        const upgraded = tls.connect({ socket, servername: cfg.host });
        await new Promise((resolve, reject) => {
          upgraded.once('secureConnect', resolve);
          upgraded.once('error', reject);
        });
        return await continueOn(upgraded, cfg, { to, subject, text }, true);
      }
    }
    return await finish(s, cfg, { to, subject, text }, cfg.secure, socket);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function continueOn(socket, cfg, message, encrypted) {
  const s = session(socket, cfg.timeoutMs);
  await s.send(`EHLO ${cfg.host}`, [250]);
  return finish(s, cfg, message, encrypted, socket);
}

async function finish(s, cfg, { to, subject, text }, encrypted, socket) {
  if (cfg.user && cfg.pass) {
    if (!encrypted) {
      throw new Error(
        'refusing to send SMTP credentials over an unencrypted connection; '
        + 'set SMTP_SECURE=true, or use a relay that offers STARTTLS, or unset '
        + 'SMTP_USER to relay unauthenticated',
      );
    }
    const token = Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64');
    await s.send(`AUTH PLAIN ${token}`, [235]);
  }

  await s.send(`MAIL FROM:<${cfg.from}>`, [250]);
  await s.send(`RCPT TO:<${to}>`, [250, 251]);
  await s.send('DATA', [354]);
  s.raw(dotStuff(buildMessage({ from: cfg.from, to, subject, text })) + CRLF + '.' + CRLF);
  const stored = await s.expect();
  if (stored.code !== 250) throw new Error(`SMTP DATA got ${stored.text}`);
  await s.send('QUIT').catch(() => {});
  socket.end();
  return { ok: true, response: stored.text };
}

module.exports = { config, isConfigured, buildMessage, dotStuff, send };
