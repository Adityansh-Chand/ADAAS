'use strict';

/**
 * Embedding and reranking, as a service the API talks to over HTTP.
 *
 *   node model-service/server.js          # listens on MODEL_SERVICE_PORT, default 3100
 *
 * WHY THIS IS A SEPARATE PROCESS
 *
 * The API's default retrieval mode has been `lexical` -- at 0.1111 top-1 on
 * paraphrases, the worst of the four -- for one reason, and it is not a technical
 * preference. `@huggingface/transformers` carries transitive high-severity
 * advisories (adm-zip and sharp, via onnxruntime-node) with no upstream fix. The
 * Dockerfile installs with `--omit=dev`, which keeps them out of the shipped
 * image, and the cost is that the shipped image then cannot embed anything.
 *
 * So the README has carried "the default retrieval mode is still the weakest one"
 * as an open item, with the honest note that waiting for an upstream fix is not a
 * plan. This is the other answer: the models move behind a process boundary. The
 * API image's dependency tree no longer contains the package at all, and the one
 * image that does contain it exposes two endpoints, holds no HR data, needs no
 * database, and can be given no network egress.
 *
 * That is a smaller claim than "the advisories are fixed" and a true one. The
 * vulnerable code still exists, in a container whose entire job is to turn text
 * into numbers.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No authentication, no rate limiting, no HR data. It is meant to sit on an
 * internal network, and a deployment that exposes it publicly has made a
 * different mistake than this file can prevent. That is stated here rather than
 * implied by omission.
 *
 * It also does not cache. The API already ships precomputed vectors for the whole
 * corpus and every eval query, so the traffic that reaches this service is live
 * user queries, which are not repeats often enough for a cache to earn its
 * invalidation bugs.
 */

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.MODEL_SERVICE_PORT || 3100);

// Kept identical to hr-backend/embeddings.js and hr-backend/rerank.js. Two
// processes that disagree about the model or the prefix would produce vectors
// that do not compare with the committed ones, and the failure would look like
// bad retrieval rather than a mismatch, so /health reports both and the API
// checks them on startup.
const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
const RERANK_MODEL = 'mixedbread-ai/mxbai-rerank-xsmall-v1';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let transformers = null;
let embedPipeline = null;
let reranker = null;
let loadError = null;

async function tf() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = process.env.MODEL_CACHE_DIR
      || path.resolve(__dirname, '.model-cache');
  }
  return transformers;
}

async function getEmbedder() {
  if (!embedPipeline) {
    const t = await tf();
    embedPipeline = await t.pipeline('feature-extraction', EMBEDDING_MODEL, {
      dtype: 'fp32',
    });
  }
  return embedPipeline;
}

async function getReranker() {
  if (!reranker) {
    const t = await tf();
    const [tokenizer, model] = await Promise.all([
      t.AutoTokenizer.from_pretrained(RERANK_MODEL),
      t.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
        dtype: 'fp32',
      }),
    ]);
    reranker = { tokenizer, model };
  }
  return reranker;
}

app.get('/health', (req, res) => {
  res.json({
    status: loadError ? 'degraded' : 'running',
    embedding_model: EMBEDDING_MODEL,
    rerank_model: RERANK_MODEL,
    query_prefix: QUERY_PREFIX,
    loaded: { embedder: Boolean(embedPipeline), reranker: Boolean(reranker) },
    error: loadError || undefined,
  });
});

/**
 * POST /embed { texts: string[], kind: 'query' | 'passage' }
 *
 * `kind` rather than a boolean, because bge is asymmetric and the caller has to
 * say which side it is on. Getting it wrong is silent -- the vectors come back
 * the right shape and retrieve slightly worse -- so the parameter is required
 * and an unknown value is a 400 rather than a default.
 */
app.post('/embed', async (req, res) => {
  const { texts, kind } = req.body || {};
  if (!Array.isArray(texts) || texts.length === 0) {
    res.status(400).json({ error: 'texts must be a non-empty array' });
    return;
  }
  if (kind !== 'query' && kind !== 'passage') {
    res.status(400).json({ error: "kind must be 'query' or 'passage'" });
    return;
  }
  try {
    const pipe = await getEmbedder();
    const prepared = kind === 'query' ? texts.map((t) => QUERY_PREFIX + t) : texts;
    const out = await pipe(prepared, { pooling: 'mean', normalize: true });
    res.json({ model: EMBEDDING_MODEL, vectors: out.tolist() });
  } catch (error) {
    loadError = error.message;
    res.status(503).json({ error: `embedding unavailable: ${error.message}` });
  }
});

/** POST /rerank { query: string, passages: string[] } -> raw logits, in order. */
app.post('/rerank', async (req, res) => {
  const { query, passages } = req.body || {};
  if (typeof query !== 'string' || !query.trim()) {
    res.status(400).json({ error: 'query is required' });
    return;
  }
  if (!Array.isArray(passages) || passages.length === 0) {
    res.status(400).json({ error: 'passages must be a non-empty array' });
    return;
  }
  try {
    const { tokenizer, model } = await getReranker();
    const inputs = tokenizer(passages.map(() => query), {
      text_pair: passages,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    res.json({ model: RERANK_MODEL, scores: logits.tolist().map((r) => r[0]) });
  } catch (error) {
    loadError = error.message;
    res.status(503).json({ error: `reranking unavailable: ${error.message}` });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`model service on http://localhost:${PORT}`);
    console.log(`  embedding ${EMBEDDING_MODEL}`);
    console.log(`  rerank    ${RERANK_MODEL}`);
  });
}

module.exports = app;
module.exports.EMBEDDING_MODEL = EMBEDDING_MODEL;
module.exports.RERANK_MODEL = RERANK_MODEL;
module.exports.QUERY_PREFIX = QUERY_PREFIX;
