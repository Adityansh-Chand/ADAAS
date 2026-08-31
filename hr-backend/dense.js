'use strict';

/**
 * Dense and hybrid retrieval over the HR policy corpus.
 *
 * Dense scoring is cosine similarity between a query vector and the precomputed
 * policy vectors in eval/embeddings.json. Hybrid combines the lexical and dense
 * rankings with reciprocal rank fusion.
 *
 * Reciprocal rank fusion rather than score addition, because the two scorers are
 * not on a comparable scale: lexical scores are unbounded IDF sums divided by a
 * length norm, dense scores are cosines in [-1, 1]. Fusing ranks avoids having
 * to invent a normalisation, and it is what the enterprise RAG work in this
 * portfolio used for the same reason.
 */

const fs = require('fs');
const path = require('path');

const embeddings = require('./embeddings');

const DEFAULT_EMBEDDINGS_PATH = path.resolve(
  __dirname, '..', 'eval', 'embeddings.json',
);

// Standard RRF constant. Damps the influence of top ranks so a single
// confidently-wrong retriever cannot dominate the fusion.
const RRF_K = 60;

// Cosine below this is treated as no match.
//
// Chosen by measuring the gap rather than by maximising recall. Six deliberately
// out-of-scope queries (Kubernetes, restaurants, capital cities, gibberish)
// scored at most 0.0899 against their best-matching policy; three in-scope
// paraphrases scored at least 0.1636. 0.12 sits in that gap with margin on both
// sides, so the service can still honestly answer "no matching policy" instead
// of always returning its closest guess.
//
// It is a small sample -- 6 out-of-scope and 3 in-scope probes -- so treat the
// gap as indicative, not established. Raising this to 0.20 cost 0.0556 of dev
// recall@5 and 2 more empty results for no gain in top-1; lowering it to 0 makes
// the service incapable of saying it found nothing.
const DEFAULT_MIN_COSINE = 0.12;

function loadVectors(file = DEFAULT_EMBEDDINGS_PATH) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data.policies || !data.queries) return null;
  return data;
}

/**
 * Dense retrieval.
 *
 * `queryVector` may be supplied directly. Otherwise the query is looked up in
 * the precomputed query table, and failing that embedded live -- which needs the
 * optional model package. Scoring the eval sets never takes the live path, so
 * the eval is deterministic and needs no model.
 */
async function denseRetrieve(query, store, kbById, {
  topK = 5,
  minCosine = DEFAULT_MIN_COSINE,
  queryVector = null,
  allowLiveEmbedding = true,
} = {}) {
  let vector = queryVector || store.queries[query];

  if (!vector) {
    if (!allowLiveEmbedding) return null;
    vector = await embeddings.embedOne(query);
  }

  const scored = [];
  for (const [id, policyVector] of Object.entries(store.policies)) {
    const entry = kbById.get(id);
    if (!entry) continue;
    const score = embeddings.cosine(vector, policyVector);
    if (score >= minCosine) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return scored.slice(0, topK);
}

/**
 * Reciprocal rank fusion of two ranked lists.
 *
 * A policy retrieved by only one side still scores, which is the point: the two
 * methods fail on different queries.
 */
function fuse(lexicalRanked, denseRanked, {
  topK = 5,
  lexicalWeight = 1.0,
  denseWeight = 1.0,
  rrfK = RRF_K,
} = {}) {
  const fused = new Map();
  const entries = new Map();

  const contribute = (ranked, weight) => {
    if (!ranked || weight === 0) return;
    ranked.forEach((item, rank) => {
      const id = item.entry.id;
      entries.set(id, item.entry);
      fused.set(id, (fused.get(id) || 0) + weight / (rrfK + rank + 1));
    });
  };

  contribute(lexicalRanked, lexicalWeight);
  contribute(denseRanked, denseWeight);

  return [...fused.entries()]
    .map(([id, score]) => ({ entry: entries.get(id), score }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, topK);
}

module.exports = {
  DEFAULT_EMBEDDINGS_PATH,
  DEFAULT_MIN_COSINE,
  RRF_K,
  loadVectors,
  denseRetrieve,
  fuse,
};
