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

const RERANKERS = [
  { id: 'Xenova/ms-marco-MiniLM-L-6-v2', note: 'ms-marco cross-encoder, 6 layers' },
  { id: 'Xenova/ms-marco-MiniLM-L-12-v2', note: 'ms-marco cross-encoder, 12 layers' },
  { id: 'jinaai/jina-reranker-v1-tiny-en', note: 'Jina v1 tiny' },
  { id: 'mixedbread-ai/mxbai-rerank-xsmall-v1', note: 'mixedbread xsmall' },
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

/** Passage text handed to a cross-encoder: no question field, no keyword list. */
function rerankPassage(entry) {
  return [entry.category || '', entry.answer || ''].filter(Boolean).join('. ');
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
    const tok = await t.AutoTokenizer.from_pretrained(cand.id);
    const model = await t.AutoModelForSequenceClassification.from_pretrained(
      cand.id, { dtype: 'fp32' },
    );

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
    { pool: 10, text: rerankPassage, label: 'pool 10, answer only' },
    { pool: 26, text: rerankPassage, label: 'pool 26 (full corpus), answer only' },
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
  const bestBi = (biRows || BI_ENCODERS.map((c) => ({ ...c, mrr: 0 })))
    .slice().sort((a, b) => b.mrr - a.mrr)[0];

  if (stageArg === 'all' || stageArg === 'reranker' || stageArg === 'ablation') {
    out.reranker_retriever = bestBi.id;
    const rrRows = await stageReranker(kb, cases, bestBi);
    out.rerankers = rrRows;

    if (stageArg === 'all' || stageArg === 'ablation') {
      const bestRr = rrRows.filter((r) => r.id !== '(none)')
        .slice().sort((a, b) => b.mrr - a.mrr)[0];
      out.ablation_reranker = bestRr.id;
      out.ablation = await stageAblation(kb, cases, bestBi, bestRr.id);
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
