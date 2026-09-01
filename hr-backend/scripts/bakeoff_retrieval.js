'use strict';

/**
 * Model selection for dense retrieval and reranking.
 *
 *   npm run bakeoff              both stages
 *   npm run bakeoff -- --stage=biencoder
 *   npm run bakeoff -- --stage=reranker
 *
 * WHY THIS EXISTS SEPARATELY FROM `npm run eval`
 *
 * Choosing a model by looking at a score is fitting to that score. If the choice
 * were made against the numbers `npm run eval` reports, those numbers would stop
 * being held out the moment the choice was made -- the same mistake that burned
 * held-out intent set 1 earlier in this project.
 *
 * So this script only ever reads the DEV half of Set B. It refuses to construct
 * the report half at all; see `devHalfOnly`. The report half is scored exactly
 * once, by `npm run eval`, after the winners are committed.
 *
 * WHAT IS BEING SELECTED, AND WHY THESE CANDIDATES
 *
 * `all-MiniLM-L6-v2` was the floor, not the target -- it was picked because it
 * runs without an API key, which every candidate here also does. The candidates
 * are the stronger freely-available retrieval bi-encoders in the same size class
 * (plus one deliberately larger, to price the step up), and the standard
 * ms-marco cross-encoders plus two newer rerankers.
 *
 * Instruction-tuned encoders are not interchangeable with plain ones: bge and e5
 * were trained with asymmetric query/passage prefixes and lose accuracy without
 * them. Each candidate therefore carries its own prefixes rather than being fed
 * bare text, because a benchmark that misuses a model measures the misuse.
 */

const fs = require('fs');
const path = require('path');

// For MODEL_ID only -- the id of the encoder production ships with, so a
// later-stage-only run benchmarks against what is actually deployed. Requiring
// this does not load a model; embeddings.js is lazy.
const embeddings = require('../embeddings');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const QUERIES_PATH = path.join(ROOT, 'eval', 'policy_queries.json');
const OUT_PATH = path.join(ROOT, 'eval', 'bakeoff.json');

const TOP_K = 5;

// Candidates the reranker sees. Larger than TOP_K on purpose: reranking can only
// reorder what retrieval handed it, so a pool of 5 caps the achievable top-1 at
// the retriever's own recall@5. 10 of 26 documents is a pool a cross-encoder can
// still score in well under a second.
const RERANK_POOL = 10;

const BI_ENCODERS = [
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    note: 'incumbent',
    queryPrefix: '',
    passagePrefix: '',
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    note: 'BAAI, asymmetric prefixes',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    passagePrefix: '',
  },
  {
    id: 'Xenova/gte-small',
    note: 'Alibaba GTE, symmetric',
    queryPrefix: '',
    passagePrefix: '',
  },
  {
    id: 'Xenova/e5-small-v2',
    note: 'Microsoft E5, asymmetric prefixes',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
  },
  {
    id: 'Xenova/bge-base-en-v1.5',
    note: '768-dim, ~4x the download',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    passagePrefix: '',
  },
];

// WHY THE SECOND ROUND ADDED RERANKERS AND NO BI-ENCODERS
//
// The first round's bi-encoder table answers that question by itself: all five
// candidates scored recall@5 1.0000 on the dev half. Every one of them already
// puts the right policy in the top five for every query, so the gold document is
// never missing from the pool -- it is only in the wrong position within it. A
// better bi-encoder has nothing left to win on this corpus, and the entire
// remaining headroom, top-1 0.7778 to a ceiling of 1.0000, sits in the stage
// that orders the pool. Round two therefore spends its download budget on
// cross-encoders and on how their scores are combined, and adds no encoders.
const RERANKERS = [
  { id: 'Xenova/ms-marco-MiniLM-L-6-v2', note: 'ms-marco cross-encoder, 6 layers' },
  { id: 'Xenova/ms-marco-MiniLM-L-12-v2', note: 'ms-marco cross-encoder, 12 layers' },
  { id: 'jinaai/jina-reranker-v1-tiny-en', note: 'Jina v1 tiny' },
  { id: 'jinaai/jina-reranker-v1-turbo-en', note: 'Jina v1 turbo, 6x tiny' },
  { id: 'mixedbread-ai/mxbai-rerank-xsmall-v1', note: 'mixedbread xsmall, incumbent' },
  { id: 'mixedbread-ai/mxbai-rerank-base-v1', note: 'mixedbread base, same family' },
  { id: 'Xenova/bge-reranker-base', note: 'BAAI, pairs with the bge retriever' },
  { id: 'Alibaba-NLP/gte-multilingual-reranker-base', note: 'Alibaba GTE' },
];

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The dev half, and only the dev half.
 *
 * `npm run eval` splits Set B by index parity into dev and report. This returns
 * the dev side and discards the other, so nothing downstream can accidentally
 * read a report-half case.
 */
function devHalfOnly(cases) {
  return cases.filter((_, i) => i % 2 === 0);
}

function policyText(entry) {
  return [
    entry.question || '',
    entry.category || '',
    (entry.keywords || []).join(', '),
    entry.answer || '',
  ].filter(Boolean).join('. ');
}

/**
 * Passage text handed to a cross-encoder in the ablation: no question field.
 *
 * Stage 2 does NOT use this, and that is a correction rather than a preference.
 * It used to, which meant every reranker was ranked on passage text that stage 3
 * then went on to show was the worse of the two options, and that rerank.js does
 * not send. The consequence was not cosmetic: measured on answer-only text the
 * mixedbread base model beat xsmall (MRR 0.9352 to 0.9167) and would have been
 * selected, at 704 MB of ONNX weights against 271 MB. Measured on the text
 * production actually sends, xsmall wins (0.9444 to 0.9352) and the larger
 * download buys nothing.
 *
 * A selection stage must score candidates in the configuration they will be
 * deployed in. This is kept only so the ablation can still isolate the effect of
 * the question field.
 */
function rerankPassageAnswerOnly(entry) {
  return [entry.category || '', entry.answer || ''].filter(Boolean).join('. ');
}

/** The passage text rerank.js sends in production. What stage 2 scores. */
function rerankPassage(entry) {
  return [entry.question || '', entry.category || '', entry.answer || '']
    .filter(Boolean).join('. ');
}

let transformers = null;
async function tf() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = process.env.MODEL_CACHE_DIR
      || path.resolve(__dirname, '..', '.model-cache');
  }
  return transformers;
}

async function embedAll(modelId, texts, batchSize = 16) {
  const t = await tf();
  const pipe = await t.pipeline('feature-extraction', modelId, { dtype: 'fp32' });
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const result = await pipe(texts.slice(i, i + batchSize), {
      pooling: 'mean',
      normalize: true,
    });
    out.push(...result.tolist());
  }
  return out;
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * top-1, recall@k and MRR. Same definitions as `npm run eval`, reimplemented
 * here rather than imported because that module also builds the report half.
 */
function score(cases, rank) {
  let top1 = 0;
  let inTopK = 0;
  let rrTotal = 0;
  for (const c of cases) {
    const ranked = rank(c) || [];
    const r = ranked.findIndex((x) => x.entry.id === c.id);
    if (r === 0) top1 += 1;
    if (r >= 0) { inTopK += 1; rrTotal += 1 / (r + 1); }
  }
  const n = cases.length;
  return { n, top1: top1 / n, recallAtK: inTopK / n, mrr: rrTotal / n };
}

const fmt = (v) => v.toFixed(4);

async function stageBiEncoder(kb, cases) {
  console.log('');
  console.log('STAGE 1 -- bi-encoder');
  console.log(`  Set B dev half only, n=${cases.length}, corpus ${kb.length}, top-k ${TOP_K}`);
  console.log('');
  console.log(`  ${'model'.padEnd(38)} ${'dim'.padEnd(4)} top-1     recall@5  MRR`);

  const rows = [];
  for (const cand of BI_ENCODERS) {
    const policyVectors = await embedAll(
      cand.id, kb.map((e) => cand.passagePrefix + policyText(e)),
    );
    const queryVectors = await embedAll(
      cand.id, cases.map((c) => cand.queryPrefix + c.q),
    );
    const byQuery = new Map(cases.map((c, i) => [c.q, queryVectors[i]]));

    // No minimum-cosine floor in this stage. The floor is calibrated per model
    // (their scores are not on a shared scale), and applying the incumbent's
    // 0.12 to a different model would measure the mismatch, not the model.
    const rank = (c) => kb
      .map((entry, i) => ({ entry, score: cosine(byQuery.get(c.q), policyVectors[i]) }))
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, TOP_K);

    const s = score(cases, rank);
    const dim = policyVectors[0].length;
    rows.push({ ...cand, dim, ...s });
    console.log(
      `  ${cand.id.padEnd(38)} ${String(dim).padEnd(4)} `
      + `${fmt(s.top1)}    ${fmt(s.recallAtK)}    ${fmt(s.mrr)}   ${cand.note}`,
    );
  }
  return rows;
}

async function stageReranker(kb, cases, winner) {
  const t = await tf();
  console.log('');
  console.log('STAGE 2 -- cross-encoder reranker');
  console.log(`  retriever: ${winner.id}   candidate pool: ${RERANK_POOL}`);
  console.log('');

  const policyVectors = await embedAll(
    winner.id, kb.map((e) => (winner.passagePrefix || '') + policyText(e)),
  );
  const queryVectors = await embedAll(
    winner.id, cases.map((c) => (winner.queryPrefix || '') + c.q),
  );
  const byQuery = new Map(cases.map((c, i) => [c.q, queryVectors[i]]));

  const pool = (c) => kb
    .map((entry, i) => ({ entry, score: cosine(byQuery.get(c.q), policyVectors[i]) }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, RERANK_POOL);

  const baseline = score(cases, (c) => pool(c).slice(0, TOP_K));
  console.log(`  ${'no reranking (baseline)'.padEnd(40)} `
    + `top-1 ${fmt(baseline.top1)}  recall@5 ${fmt(baseline.recallAtK)}  `
    + `MRR ${fmt(baseline.mrr)}`);

  const rows = [{ id: '(none)', note: 'baseline', ...baseline }];
  for (const cand of RERANKERS) {
    // A candidate with no usable ONNX export is a fact about the candidate, not
    // a reason to abandon the comparison. Recorded and skipped, so the table
    // shows what was attempted rather than only what happened to work.
    let tok;
    let model;
    try {
      tok = await t.AutoTokenizer.from_pretrained(cand.id);
      model = await t.AutoModelForSequenceClassification.from_pretrained(
        cand.id, { dtype: 'fp32' },
      );
    } catch (error) {
      rows.push({ ...cand, unavailable: String(error.message).slice(0, 200) });
      console.log(`  ${cand.id.padEnd(40)} unavailable -- `
        + `${String(error.message).slice(0, 90)}`);
      continue;
    }

    const reranked = new Map();
    for (const c of cases) {
      const candidates = pool(c);
      const inputs = tok(
        candidates.map(() => c.q),
        {
          text_pair: candidates.map((x) => rerankPassage(x.entry)),
          padding: true,
          truncation: true,
        },
      );
      const { logits } = await model(inputs);
      const scores = logits.tolist().map((r) => r[0]);
      reranked.set(c.q, candidates
        .map((x, i) => ({ entry: x.entry, score: scores[i] }))
        .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
        .slice(0, TOP_K));
    }

    const s = score(cases, (c) => reranked.get(c.q));
    rows.push({ ...cand, ...s });
    console.log(
      `  ${cand.id.padEnd(40)} top-1 ${fmt(s.top1)}  `
      + `recall@5 ${fmt(s.recallAtK)}  MRR ${fmt(s.mrr)}   ${cand.note}`,
    );
  }
  return rows;
}

/**
 * Two design choices the reranker stage fixed by assumption, measured instead.
 *
 * Pool size: a cross-encoder can only reorder what it is given, so a pool of 10
 * caps top-1 at the retriever's recall@10. This corpus has 26 documents, which
 * is small enough to rerank in full -- removing the retriever's recall ceiling
 * from the result entirely. Worth knowing whether that helps or whether the
 * extra 16 distractors cost more than the ceiling did.
 *
 * Passage text: the corpus `question` field is an authored restatement of what
 * each policy answers, so including it hands the cross-encoder a second,
 * query-shaped surface to match against. That may help, or it may just add
 * boilerplate. Set A already shows how badly the question field can flatter a
 * scorer, so this is measured rather than assumed in either direction.
 */
async function stageAblation(kb, cases, winner, rerankerId) {
  const t = await tf();
  console.log('');
  console.log('STAGE 3 -- ablation on the winning pair');
  console.log(`  retriever: ${winner.id}   reranker: ${rerankerId}`);
  console.log('');

  const policyVectors = await embedAll(
    winner.id, kb.map((e) => (winner.passagePrefix || '') + policyText(e)),
  );
  const queryVectors = await embedAll(
    winner.id, cases.map((c) => (winner.queryPrefix || '') + c.q),
  );
  const byQuery = new Map(cases.map((c, i) => [c.q, queryVectors[i]]));

  const rankedByCosine = (c) => kb
    .map((entry, i) => ({ entry, score: cosine(byQuery.get(c.q), policyVectors[i]) }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  const tok = await t.AutoTokenizer.from_pretrained(rerankerId);
  const model = await t.AutoModelForSequenceClassification.from_pretrained(
    rerankerId, { dtype: 'fp32' },
  );

  const withQuestion = (entry) => [
    entry.question || '', entry.category || '', entry.answer || '',
  ].filter(Boolean).join('. ');

  const variants = [
    { pool: 10, text: rerankPassageAnswerOnly, label: 'pool 10, answer only' },
    { pool: 26, text: rerankPassageAnswerOnly, label: 'pool 26 (full corpus), answer only' },
    { pool: 10, text: withQuestion, label: 'pool 10, question + answer' },
    { pool: 26, text: withQuestion, label: 'pool 26 (full corpus), question + answer' },
  ];

  const rows = [];
  for (const variant of variants) {
    const reranked = new Map();
    for (const c of cases) {
      const candidates = rankedByCosine(c).slice(0, variant.pool);
      const inputs = tok(candidates.map(() => c.q), {
        text_pair: candidates.map((x) => variant.text(x.entry)),
        padding: true,
        truncation: true,
      });
      const { logits } = await model(inputs);
      const scores = logits.tolist().map((r) => r[0]);
      reranked.set(c.q, candidates
        .map((x, i) => ({ entry: x.entry, score: scores[i] }))
        .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
        .slice(0, TOP_K));
    }
    const s = score(cases, (c) => reranked.get(c.q));
    rows.push({ ...variant, text: undefined, ...s });
    console.log(
      `  ${variant.label.padEnd(44)} top-1 ${fmt(s.top1)}  `
      + `recall@5 ${fmt(s.recallAtK)}  MRR ${fmt(s.mrr)}`,
    );
  }
  return rows;
}

/**
 * STAGE 4 -- how to combine the two scores, rather than which reranker to use.
 *
 * Production currently throws the retriever's opinion away. The cross-encoder
 * scores the top 10 and its logit alone decides the order, so a document the
 * bi-encoder ranked first and the cross-encoder ranked fourth ends up fourth on
 * the cross-encoder's word alone. That is a choice, and it was never measured.
 *
 * It is worth measuring because the two scorers fail differently -- the same
 * argument that justified the reranker in the first place. The bi-encoder is
 * weak at separating near-duplicates and reliable at topic; the cross-encoder is
 * the reverse often enough that three of the four candidates in round one scored
 * below doing nothing at all. Combining them can beat either, and the honest
 * outcome is that it might not.
 *
 * Both families of combination are tried:
 *
 *   rank fusion   reciprocal rank fusion over the two orderings. Needs no
 *                 normalisation, which is why dense.js already uses it for
 *                 lexical/dense. `k` matters far more here than it does there:
 *                 with only 10 candidates, k=60 flattens 1/(k+rank) almost to a
 *                 constant, so the standard constant is close to averaging the
 *                 two ranks. Small k is also tried.
 *
 *   score fusion  weighted sum after per-query min-max normalisation. Raw values
 *                 are not comparable -- cosines sit in a narrow band near 0.5,
 *                 logits range over roughly [-9, +6] -- and normalising within
 *                 each query's own pool is the cheapest defensible way to put
 *                 them on one scale without inventing a calibration.
 *
 * `w` is the weight on the cross-encoder, so w=1.0 reproduces production exactly
 * and w=0.0 reproduces no reranking. Both endpoints are in the table on purpose:
 * a fusion result that does not bracket its own endpoints is a bug.
 */
async function stageFusion(kb, cases, winner, rerankerId) {
  const t = await tf();
  console.log('');
  console.log('STAGE 4 -- fusing the retriever and the reranker');
  console.log(`  retriever: ${winner.id}   reranker: ${rerankerId}   `
    + `pool: ${RERANK_POOL}`);
  console.log('');

  const policyVectors = await embedAll(
    winner.id, kb.map((e) => (winner.passagePrefix || '') + policyText(e)),
  );
  const queryVectors = await embedAll(
    winner.id, cases.map((c) => (winner.queryPrefix || '') + c.q),
  );
  const byQuery = new Map(cases.map((c, i) => [c.q, queryVectors[i]]));

  const tok = await t.AutoTokenizer.from_pretrained(rerankerId);
  const model = await t.AutoModelForSequenceClassification.from_pretrained(
    rerankerId, { dtype: 'fp32' },
  );

  // question + category + answer: the passage text the ablation selected and the
  // text rerank.js actually sends in production.
  const passage = (entry) => [
    entry.question || '', entry.category || '', entry.answer || '',
  ].filter(Boolean).join('. ');

  // Score every pool once, then evaluate every combination over the same
  // numbers. Anything else would let model nondeterminism masquerade as a
  // difference between strategies.
  const pools = new Map();
  for (const c of cases) {
    const candidates = kb
      .map((entry, i) => ({ entry, cos: cosine(byQuery.get(c.q), policyVectors[i]) }))
      .sort((a, b) => b.cos - a.cos || a.entry.id.localeCompare(b.entry.id))
      .slice(0, RERANK_POOL);
    const inputs = tok(candidates.map(() => c.q), {
      text_pair: candidates.map((x) => passage(x.entry)),
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    const scores = logits.tolist().map((r) => r[0]);
    pools.set(c.q, candidates.map((x, i) => ({ ...x, logit: scores[i] })));
  }

  const order = (pool, key) => pool.slice()
    .sort((a, b) => b[key] - a[key] || a.entry.id.localeCompare(b.entry.id));

  const rankMap = (pool, key) => {
    const m = new Map();
    order(pool, key).forEach((x, i) => m.set(x.entry.id, i));
    return m;
  };

  const rrf = (k) => (c) => {
    const pool = pools.get(c.q);
    const dRank = rankMap(pool, 'cos');
    const rRank = rankMap(pool, 'logit');
    return pool
      .map((x) => ({
        entry: x.entry,
        score: 1 / (k + dRank.get(x.entry.id) + 1)
          + 1 / (k + rRank.get(x.entry.id) + 1),
      }))
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, TOP_K);
  };

  const blend = (w) => (c) => {
    const pool = pools.get(c.q);
    const norm = (vals) => {
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      // A pool where every score is identical carries no information; treat it
      // as all-equal rather than dividing by zero.
      return vals.map((v) => (hi === lo ? 0.5 : (v - lo) / (hi - lo)));
    };
    const cosN = norm(pool.map((x) => x.cos));
    const logitN = norm(pool.map((x) => x.logit));
    return pool
      .map((x, i) => ({ entry: x.entry, score: w * logitN[i] + (1 - w) * cosN[i] }))
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, TOP_K);
  };

  const strategies = [
    { label: 'cross-encoder only (w=1.0, production)', rank: blend(1.0) },
    { label: 'dense only (w=0.0, no reranking)', rank: blend(0.0) },
    { label: 'RRF over both orderings, k=60', rank: rrf(60) },
    { label: 'RRF over both orderings, k=10', rank: rrf(10) },
    { label: 'RRF over both orderings, k=1', rank: rrf(1) },
    { label: 'min-max blend, w=0.3', rank: blend(0.3) },
    { label: 'min-max blend, w=0.5', rank: blend(0.5) },
    { label: 'min-max blend, w=0.6', rank: blend(0.6) },
    { label: 'min-max blend, w=0.7', rank: blend(0.7) },
    { label: 'min-max blend, w=0.8', rank: blend(0.8) },
    { label: 'min-max blend, w=0.9', rank: blend(0.9) },
  ];

  const rows = [];
  for (const s of strategies) {
    const m = score(cases, s.rank);
    rows.push({ label: s.label, ...m });
    console.log(
      `  ${s.label.padEnd(42)} top-1 ${fmt(m.top1)}  `
      + `recall@5 ${fmt(m.recallAtK)}  MRR ${fmt(m.mrr)}`,
    );
  }
  return rows;
}

/**
 * STAGE 5 -- late interaction, the "something that reads" the README asks for.
 *
 * The residual retrieval errors are all near-duplicate confusions: paternity
 * against maternity, chemotherapy against the exclusions annex. Every method
 * tried so far compresses each side to one vector before comparing, or compares
 * the pair through a cross-encoder trained on someone else's data. Late
 * interaction is the third option and the only one that is neither: it keeps a
 * vector per TOKEN, and scores a pair by summing, over query tokens, the best
 * match anywhere in the document.
 *
 * The reason it is worth trying on this corpus specifically is that near
 * duplicates differ in a few tokens and agree everywhere else. Mean pooling
 * averages those few tokens away by construction -- that is what pooling is --
 * whereas MaxSim lets a single decisive token ("paternity", "10 days", "male")
 * carry as much weight as it deserves.
 *
 * The reason it may not work is equally concrete, and is stated before the
 * numbers rather than after: bge-small was trained to produce a good POOLED
 * vector. Its token vectors are a by-product, never supervised for this use, and
 * a real ColBERT is trained end to end with a MaxSim objective and a projection
 * layer this model does not have. So this measures whether the effect is strong
 * enough to survive using an unsuited model, which is a lower bar to fail than
 * "late interaction does not help".
 */
async function stageLateInteraction(kb, cases, winner, rerankerId) {
  const t = await tf();
  console.log('');
  console.log('STAGE 5 -- late interaction (ColBERT-style MaxSim)');
  console.log(`  encoder: ${winner.id}   pool: ${RERANK_POOL}`);
  console.log('');

  const pipe = await t.pipeline('feature-extraction', winner.id, { dtype: 'fp32' });

  // One vector per token, L2-normalised, so a dot product is a cosine.
  const tokenVectors = async (text) => {
    const out = await pipe([text], { pooling: 'none', normalize: false });
    const [, seq, dim] = out.dims;
    const flat = out.tolist()[0];
    return flat.slice(0, seq).map((row) => {
      let norm = 0;
      for (let i = 0; i < dim; i += 1) norm += row[i] * row[i];
      norm = Math.sqrt(norm) || 1;
      return row.map((x) => x / norm);
    });
  };

  const maxSim = (queryTokens, docTokens) => {
    let total = 0;
    for (const q of queryTokens) {
      let best = -1;
      for (const d of docTokens) {
        let dot = 0;
        for (let i = 0; i < q.length; i += 1) dot += q[i] * d[i];
        if (dot > best) best = dot;
      }
      total += best;
    }
    return total / queryTokens.length;
  };

  const policyVectors = await embedAll(
    winner.id, kb.map((e) => (winner.passagePrefix || '') + policyText(e)),
  );
  const queryVectors = await embedAll(
    winner.id, cases.map((c) => (winner.queryPrefix || '') + c.q),
  );
  const byQuery = new Map(cases.map((c, i) => [c.q, queryVectors[i]]));

  const docTokens = new Map();
  for (const e of kb) docTokens.set(e.id, await tokenVectors(rerankPassage(e)));

  const tok = await t.AutoTokenizer.from_pretrained(rerankerId);
  const model = await t.AutoModelForSequenceClassification.from_pretrained(
    rerankerId, { dtype: 'fp32' },
  );

  const rows = [];
  const scored = new Map();
  for (const c of cases) {
    const pool = kb
      .map((entry, i) => ({ entry, cos: cosine(byQuery.get(c.q), policyVectors[i]) }))
      .sort((a, b) => b.cos - a.cos || a.entry.id.localeCompare(b.entry.id))
      .slice(0, RERANK_POOL);

    const qTokens = await tokenVectors((winner.queryPrefix || '') + c.q);
    const late = pool.map((x) => maxSim(qTokens, docTokens.get(x.entry.id)));

    const inputs = tok(pool.map(() => c.q), {
      text_pair: pool.map((x) => rerankPassage(x.entry)),
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    const ce = logits.tolist().map((r) => r[0]);

    scored.set(c.q, pool.map((x, i) => ({ entry: x.entry, cos: x.cos, late: late[i], ce: ce[i] })));
  }

  const rank = (key) => (c) => scored.get(c.q).slice()
    .sort((a, b) => b[key] - a[key] || a.entry.id.localeCompare(b.entry.id))
    .slice(0, TOP_K);

  // Rank fusion rather than a score blend: MaxSim sums are not on the
  // cross-encoder's scale and inventing a normalisation between them would be
  // the thing stage 4 already showed adds nothing.
  const fused = (c) => {
    const pool = scored.get(c.q);
    const rankOf = (key) => {
      const m = new Map();
      pool.slice().sort((a, b) => b[key] - a[key]).forEach((x, i) => m.set(x.entry.id, i));
      return m;
    };
    const rl = rankOf('late');
    const rc = rankOf('ce');
    return pool
      .map((x) => ({
        entry: x.entry,
        score: 1 / (10 + rl.get(x.entry.id)) + 1 / (10 + rc.get(x.entry.id)),
      }))
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, TOP_K);
  };

  const variants = [
    { label: 'dense pooled only (baseline)', rank: rank('cos') },
    { label: 'cross-encoder only (shipping)', rank: rank('ce') },
    { label: 'late interaction only', rank: rank('late') },
    { label: 'late interaction + cross-encoder, RRF', rank: fused },
  ];

  for (const v of variants) {
    const m = score(cases, v.rank);
    rows.push({ label: v.label, ...m });
    console.log(
      `  ${v.label.padEnd(42)} top-1 ${fmt(m.top1)}  `
      + `recall@5 ${fmt(m.recallAtK)}  MRR ${fmt(m.mrr)}`,
    );
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const stageArg = (args.find((a) => a.startsWith('--stage='))
    || '--stage=all').split('=')[1];

  const kb = loadJson(KB_PATH);
  const cases = devHalfOnly(loadJson(QUERIES_PATH).cases);

  const out = { top_k: TOP_K, rerank_pool: RERANK_POOL, dev_n: cases.length };

  let biRows = null;
  if (stageArg === 'all' || stageArg === 'biencoder') {
    biRows = await stageBiEncoder(kb, cases);
    out.bi_encoders = biRows;
  }

  // Ranked by MRR rather than top-1: MRR uses the whole ranking, so it is the
  // less noisy signal on 18 cases, and reranking consumes a ranking.
  //
  // When stage 1 is skipped there is nothing to rank, so the retriever the
  // service actually ships with is used. Falling back to the first entry in the
  // candidate list instead -- as this did -- silently benchmarked the later
  // stages against all-MiniLM-L6-v2, which production stopped using.
  const bestBi = biRows
    ? biRows.slice().sort((a, b) => b.mrr - a.mrr)[0]
    : BI_ENCODERS.find((c) => c.id === embeddings.MODEL_ID) || BI_ENCODERS[0];

  if (stageArg === 'all' || stageArg === 'reranker'
      || stageArg === 'ablation' || stageArg === 'fusion'
      || stageArg === 'late') {
    out.reranker_retriever = bestBi.id;
    const rrRows = await stageReranker(kb, cases, bestBi);
    out.rerankers = rrRows;

    const bestRr = rrRows
      .filter((r) => r.id !== '(none)' && !r.unavailable)
      .slice().sort((a, b) => b.mrr - a.mrr)[0];

    if (stageArg === 'all' || stageArg === 'ablation') {
      out.ablation_reranker = bestRr.id;
      out.ablation = await stageAblation(kb, cases, bestBi, bestRr.id);
    }

    if (stageArg === 'all' || stageArg === 'late') {
      out.late_interaction = await stageLateInteraction(kb, cases, bestBi, bestRr.id);
    }

    if (stageArg === 'all' || stageArg === 'fusion') {
      // Fusion is measured on the top TWO rerankers, not just the winner, and
      // the reason is a decision this project has to make rather than a
      // curiosity. The best reranker's ONNX weights are 704 MB against the
      // runner-up's 271 MB -- a 2.6x step in download and resident memory for a
      // gap of one case out of eighteen. If fusing the runner-up with the
      // retriever's own score closes that gap, the small model ships and the
      // step-up is not needed. That is worth knowing before committing to the
      // download, and it cannot be answered by looking at the winner alone.
      const topTwo = rrRows
        .filter((r) => r.id !== '(none)' && !r.unavailable)
        .slice().sort((a, b) => b.mrr - a.mrr)
        .slice(0, 2);
      out.fusion_rerankers = topTwo.map((r) => r.id);
      out.fusion = {};
      for (const r of topTwo) {
        out.fusion[r.id] = await stageFusion(kb, cases, bestBi, r.id);
      }
    }
  }

  fs.writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log('');
  console.log(`  wrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
