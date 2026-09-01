'use strict';

/**
 * Where embeddings and rerank scores come from at request time.
 *
 * Three sources, tried in this order, and the one in use is reported by
 * `GET /health` rather than inferred:
 *
 *   service   MODEL_SERVICE_URL is set -- HTTP to model-service/, which is the
 *             only image carrying @huggingface/transformers
 *   local     the optional devDependency is installed in this process
 *   none      neither, so dense retrieval and reranking are unavailable and the
 *             service says so instead of pretending
 *
 * WHY THE SERVICE PATH EXISTS
 *
 * The default retrieval mode has been `lexical` -- 0.1111 top-1 on paraphrases,
 * the worst of the four -- because the model package carries transitive
 * high-severity advisories with no upstream fix, so the production image installs
 * with `--omit=dev` and cannot embed. Moving the models behind a process boundary
 * is what makes `RETRIEVAL_MODE=reranked` deployable rather than a local-only
 * setting, and it is why this indirection exists at all.
 *
 * WHY THE LOCAL PATH STAYS
 *
 * Every eval, bakeoff and verify script runs in-process, and a developer on a
 * laptop should not have to start a second service to run `npm run embed`. The
 * local path is also what CI uses to re-derive the committed vectors. Deleting it
 * would trade a real deployment problem for a real development one.
 *
 * FAILING OVER IS DELIBERATELY NOT AUTOMATIC
 *
 * If MODEL_SERVICE_URL is set and the service is unreachable, this throws rather
 * than silently using a local model. Two sources that can substitute for each
 * other without saying so is how a deployment ends up serving vectors from a
 * different model than it reports -- and the committed vectors are verified
 * against one specific model, so a silent swap would be invisible and wrong.
 */

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const RERANK_MODEL_ID = 'mixedbread-ai/mxbai-rerank-xsmall-v1';

// A live query is one forward pass. If it has not answered by now the request it
// belongs to has already failed for the user, and holding the connection open
// only makes the failure slower.
const DEFAULT_TIMEOUT_MS = Number(process.env.MODEL_SERVICE_TIMEOUT_MS || 8000);

class ModelSourceUnavailable extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ModelSourceUnavailable';
    this.cause = cause;
  }
}

function serviceUrl() {
  const url = (process.env.MODEL_SERVICE_URL || '').trim();
  return url ? url.replace(/\/+$/, '') : null;
}

function hasLocalPackage() {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

/** 'service' | 'local' | 'none' -- what /health reports. */
function activeSource() {
  if (serviceUrl()) return 'service';
  if (hasLocalPackage()) return 'local';
  return 'none';
}

async function post(pathname, body) {
  const base = serviceUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ModelSourceUnavailable(
        `model service ${pathname} returned ${response.status}: ${detail.slice(0, 200)}`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ModelSourceUnavailable) throw error;
    throw new ModelSourceUnavailable(
      `model service at ${base} is unreachable: ${error.message}. `
      + 'MODEL_SERVICE_URL is set, so no local fallback is attempted -- two '
      + 'sources substituting for each other silently is how a deployment ends '
      + 'up serving vectors from a model it is not reporting.',
      error,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirm the service is running the models this API's committed vectors were
 * built with. Called once at startup, not per request.
 *
 * A mismatch here is the failure worth catching early: the vectors in
 * eval/embeddings.json are verified against one specific model, and a service
 * quietly upgraded to another would produce cosines that are all slightly wrong
 * and retrieval that is merely worse -- which looks like a bad day rather than a
 * misconfiguration.
 */
async function checkService() {
  const base = serviceUrl();
  if (!base) return { ok: true, source: activeSource() };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const response = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timer);
    const health = await response.json();
    const mismatch = [];
    if (health.embedding_model !== MODEL_ID) {
      mismatch.push(`embedding ${health.embedding_model} != ${MODEL_ID}`);
    }
    if (health.rerank_model !== RERANK_MODEL_ID) {
      mismatch.push(`rerank ${health.rerank_model} != ${RERANK_MODEL_ID}`);
    }
    return mismatch.length
      ? { ok: false, source: 'service', reason: `model mismatch: ${mismatch.join('; ')}` }
      : { ok: true, source: 'service', models: health };
  } catch (error) {
    return { ok: false, source: 'service', reason: `unreachable: ${error.message}` };
  }
}

/** Embed as queries (bge's instruction prefix is applied on the service side). */
async function embedQueries(texts) {
  const { vectors } = await post('/embed', { texts, kind: 'query' });
  return vectors;
}

async function embedPassages(texts) {
  const { vectors } = await post('/embed', { texts, kind: 'passage' });
  return vectors;
}

/** Raw cross-encoder logits for one query against many passages, in order. */
async function rerankScores(query, passages) {
  const { scores } = await post('/rerank', { query, passages });
  return scores;
}

module.exports = {
  MODEL_ID,
  RERANK_MODEL_ID,
  ModelSourceUnavailable,
  serviceUrl,
  hasLocalPackage,
  activeSource,
  checkService,
  embedQueries,
  embedPassages,
  rerankScores,
};
