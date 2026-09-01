'use strict';

/**
 * Reading secrets from files as well as from the environment.
 *
 * WHY
 *
 * Every secret this service takes -- `API_KEY`, `SESSION_SECRET`, `LLM_API_KEY`,
 * `MONGODB_URI` -- was readable only from an environment variable, and the README
 * carried "managed secrets" as an open item on that basis. An environment
 * variable is a poor place for a secret in a container: it is visible in
 * `docker inspect`, in `/proc/<pid>/environ` to anything in the same namespace,
 * in a crash dump, and it is inherited by every child process.
 *
 * Both Docker secrets and Kubernetes secret volumes solve this the same way, by
 * mounting the value as a file. The convention for consuming them -- `FOO_FILE`
 * pointing at a path, taking precedence over `FOO` -- is the one Postgres, MySQL
 * and most official images use, so this is deliberately not a new idea. It is the
 * one an operator already knows.
 *
 * WHAT THIS IS NOT
 *
 * Not a secrets manager. There is no Vault client, no KMS, no rotation, no
 * auditing. This is the consumption end: it lets a platform that already manages
 * secrets deliver them without putting them in the environment. Saying "managed
 * secrets, done" on the strength of it would be an overstatement, and the README
 * says which half is closed.
 */

const fs = require('fs');

const SECRET_NAMES = [
  'API_KEY',
  'SESSION_SECRET',
  'LLM_API_KEY',
  'MONGODB_URI',
  'OIDC_AUDIENCE',
];

/**
 * Read one secret. `NAME_FILE` wins over `NAME`.
 *
 * Precedence rather than fallback, and that direction matters: if both are set,
 * the file is the deliberate configuration and the variable is usually left over
 * from a compose file nobody updated. Preferring the environment would make the
 * mounted secret silently ineffective, which is the worst of the four outcomes.
 *
 * A `NAME_FILE` that cannot be read throws. Falling back to the environment there
 * would mean a broken secret mount degrades to whatever stale value happens to be
 * around, and the service would come up looking healthy with the wrong credential.
 */
function read(name, env = process.env) {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      // Trailing newlines are near-universal in mounted secret files -- `echo` adds
      // one, and so do most editors. A newline inside an API key produces a 401
      // that looks like a wrong key rather than a formatting problem, which is an
      // afternoon nobody should spend.
      return fs.readFileSync(file, 'utf8').trim();
    } catch (error) {
      throw new Error(
        `${name}_FILE is set to ${file} but it could not be read: ${error.message}. `
        + 'Refusing to fall back to the environment -- a broken secret mount must '
        + 'not silently degrade to a stale value.',
      );
    }
  }
  return env[name];
}

/**
 * Resolve every known secret into the environment once, at startup.
 *
 * Done by mutation rather than by threading a config object through, because the
 * modules that consume these read `process.env` directly and at call time, and
 * rewriting all of them to take injected config would be a large change for no
 * behavioural gain. The mutation happens once, before anything reads them.
 */
function resolveAll(env = process.env) {
  const resolved = [];
  for (const name of SECRET_NAMES) {
    if (!env[`${name}_FILE`]) continue;
    env[name] = read(name, env);
    resolved.push(name);
  }
  return resolved;
}

/** What /health can say without saying anything. */
function status(env = process.env) {
  return {
    from_file: SECRET_NAMES.filter((n) => env[`${n}_FILE`]),
    from_environment: SECRET_NAMES.filter((n) => !env[`${n}_FILE`] && env[n]),
    // Never the values, and never a hash of them either -- a hash of a
    // low-entropy secret is a crackable secret.
    unset: SECRET_NAMES.filter((n) => !env[`${n}_FILE`] && !env[n]),
  };
}

module.exports = { SECRET_NAMES, read, resolveAll, status };
