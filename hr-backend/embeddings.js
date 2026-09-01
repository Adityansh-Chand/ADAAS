'use strict';

/**
 * Sentence embeddings, computed locally.
 *
 * Model: BAAI/bge-small-en-v1.5 (via the Xenova ONNX export), 384 dimensions,
 * mean-pooled and L2-normalised. Runs on a laptop with no API key, no account
 * and no billing, which is the constraint every dependency here is held to.
 *
 * It replaced all-MiniLM-L6-v2, which was chosen as the floor of that constraint
 * rather than the best thing satisfying it. `npm run bakeoff` measured five
 * bi-encoders on the Set B dev half and this one won on both top-1 and MRR.
 * bge-base-en-v1.5 -- 768 dimensions and roughly four times the download -- tied
 * on top-1 and scored marginally *worse* on MRR, so the larger model is not
 * being declined for cost reasons; it simply did not help.
 *
 * BGE IS ASYMMETRIC. It was trained with an instruction prefix on the query side
 * and none on the passage side, and it loses accuracy if fed bare text on both.
 * That is why `embedQuery` and `embedPassage` are separate functions instead of
 * one `embed` with a comment asking callers to remember. Getting this wrong is
 * silent: the vectors still have 384 dimensions and cosine still returns a
 * plausible number.
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

const modelClient = require('./model_client');

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DIMENSIONS = 384;

// The instruction BGE was trained to see on the query side. Passages get no
// prefix. This exact string is part of the model contract, not a stylistic
// choice -- changing its wording changes every query vector.
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

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
async function embed(texts, { batchSize = BATCH_SIZE, kind = 'passage' } = {}) {
  // The service path, when one is configured. Checked here rather than at the
  // call sites so every caller -- live queries, the build scripts, the eval --
  // goes through the same decision, and so `MODEL_SERVICE_URL` cannot be honoured
  // by some paths and ignored by others.
  //
  // Rounded identically to the local path: the committed vectors are compared to
  // one unit of stored precision, and a service returning full-precision floats
  // would fail `npm run embed:verify` for a reason that is not drift.
  if (modelClient.serviceUrl()) {
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const vectors = kind === 'query'
        ? await modelClient.embedQueries(batch)
        : await modelClient.embedPassages(batch);
      for (const vector of vectors) {
        if (vector.length !== DIMENSIONS) {
          throw new Error(`expected ${DIMENSIONS} dims, got ${vector.length}`);
        }
        out.push(round(vector));
      }
    }
    return out;
  }

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

/**
 * Embed passages -- corpus documents. No prefix.
 *
 * Named for the role rather than taking a flag, so a call site cannot be read as
 * correct while silently using the wrong side of an asymmetric model.
 */
async function embedPassages(texts, options) {
  return embed(texts, options);
}

/** Embed queries -- what a user typed. Prefixed, per the model contract above. */
async function embedQueries(texts, options) {
  // The service applies the prefix itself, so sending prefixed text would apply
  // it twice. One place owns the prefix per path, and which one is explicit.
  if (modelClient.serviceUrl()) {
    return embed(texts, { ...options, kind: 'query' });
  }
  return embed(texts.map((t) => QUERY_PREFIX + t), options);
}

async function embedQuery(text) {
  return (await embedQueries([text]))[0];
}

async function embedPassage(text) {
  return (await embedPassages([text]))[0];
}

/**
 * Embed utterances for comparison against other utterances -- the intent
 * classifier's k-NN vote, where both sides are things a person might type.
 *
 * PREFIXED, on both sides, and this was written the other way round first.
 *
 * The reasoning for leaving the prefix off was that intent classification is a
 * symmetric comparison, the prefix exists to make a short question look like
 * something that retrieves a long document, and applying it to both sides
 * describes neither. That argument is tidy and it is wrong. Measured on the two
 * intent sets that are not held out -- the fitted set and the already-compromised
 * held_out_2, chosen so held_out_3 stayed clean:
 *
 *   MiniLM, no prefix             0.7292 / 0.8750
 *   bge-small, no prefix          0.6667 / 0.8750
 *   bge-small, prefix both sides  0.7083 / 0.9583
 *
 * Prefixing both sides is still symmetric -- it moves both into the same region
 * of the space, the region where this model discriminates most sharply, and being
 * a question rather than a document is exactly what both sides have in common.
 * The a-priori argument mistook "the same instruction on both sides" for
 * "the asymmetric encoding applied wrongly".
 *
 * Kept as its own named function rather than folded into `embedQueries` so the
 * intent call sites still say what they are doing, and so this note has somewhere
 * to live.
 */
async function embedUtterances(texts, options) {
  return embedQueries(texts, options);
}

async function embedUtterance(text) {
  return (await embedUtterances([text]))[0];
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
  QUERY_PREFIX,
  EmbeddingsUnavailable,
  embedPassages,
  embedQueries,
  embedPassage,
  embedQuery,
  embedUtterances,
  embedUtterance,
  cosine,
  isAvailable,
};
