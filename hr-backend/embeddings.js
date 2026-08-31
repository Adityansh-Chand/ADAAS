'use strict';

/**
 * Sentence embeddings, computed locally.
 *
 * Model: sentence-transformers/all-MiniLM-L6-v2 (via the Xenova ONNX export),
 * 384 dimensions, mean-pooled and L2-normalised. Chosen because it runs on a
 * laptop with no API key, no account and no billing, which is the same
 * constraint every other dependency in this repository is held to.
 *
 * `@huggingface/transformers` is a devDependency, not a dependency, and is
 * loaded lazily. Two reasons:
 *
 *   1. It pulls in onnxruntime-node, which depends on a version of adm-zip with
 *      a high-severity advisory and no fix available, plus sharp. The Dockerfile
 *      installs with `--omit=dev`, so none of that reaches the running image.
 *      `npm audit --omit=dev` reports zero vulnerabilities.
 *   2. Corpus vectors are precomputed and committed, so scoring retrieval needs
 *      no model at all. Only embedding a *new* query at runtime does.
 *
 * A deployment that wants dense retrieval live installs the package and sets
 * RETRIEVAL_MODE. Everything else keeps working without it.
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;

// Rounded before storage so committed vectors are byte-stable across platforms.
// ONNX accumulates floating point differently on different CPUs, and without
// this the `--verify` check fails on a machine that is behaving correctly.
const STORED_PRECISION = 6;

// Fixed rather than a caller default: texts are padded to the longest item in
// their batch, so the batch size measurably changes the vectors it produces.
const BATCH_SIZE = 16;

let extractorPromise = null;

class EmbeddingsUnavailable extends Error {
  constructor(cause) {
    super(
      'Sentence embeddings require the optional @huggingface/transformers '
      + 'package, which is a devDependency and is not installed in production '
      + 'images. Run `npm install` (without --omit=dev) in hr-backend, or leave '
      + 'RETRIEVAL_MODE unset to use lexical retrieval.',
    );
    this.name = 'EmbeddingsUnavailable';
    this.cause = cause;
  }
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      let transformers;
      try {
        transformers = await import('@huggingface/transformers');
      } catch (error) {
        throw new EmbeddingsUnavailable(error);
      }
      // Explicit cache directory. transformers.js otherwise caches ~87 MB into
      // node_modules/@huggingface/transformers/.cache, which no CI cache action
      // will pick up, so the model would be re-downloaded on every run. HF_HOME
      // is not honoured by this library -- verified, not assumed.
      transformers.env.cacheDir = process.env.MODEL_CACHE_DIR
        || require('path').resolve(__dirname, '.model-cache');

      // Deterministic settings: fp32 rather than quantised, so the committed
      // vectors are reproducible.
      return transformers.pipeline('feature-extraction', MODEL_ID, {
        dtype: 'fp32',
      });
    })();
  }
  return extractorPromise;
}

function round(vector) {
  const factor = 10 ** STORED_PRECISION;
  return Array.from(vector, (v) => Math.round(v * factor) / factor);
}

/**
 * Embed an array of strings. Returns an array of normalised 384-dim vectors,
 * rounded to STORED_PRECISION so the result is stable enough to commit.
 */
async function embed(texts, { batchSize = BATCH_SIZE } = {}) {
  const extractor = await getExtractor();
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const result = await extractor(batch, { pooling: 'mean', normalize: true });
    for (const vector of result.tolist()) {
      if (vector.length !== DIMENSIONS) {
        throw new Error(`expected ${DIMENSIONS} dims, got ${vector.length}`);
      }
      out.push(round(vector));
    }
  }
  return out;
}

async function embedOne(text) {
  return (await embed([text]))[0];
}

/** Both vectors are already L2-normalised, so cosine is a dot product. */
function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** Is the optional package present? Does not load the model. */
function isAvailable() {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MODEL_ID,
  DIMENSIONS,
  STORED_PRECISION,
  BATCH_SIZE,
  EmbeddingsUnavailable,
  embed,
  embedOne,
  cosine,
  isAvailable,
};
