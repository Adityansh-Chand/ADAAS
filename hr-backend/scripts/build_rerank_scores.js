'use strict';

/**
 * Precompute cross-encoder scores for every eval query against every policy.
 *
 *   npm run rerank:build     regenerate and write
 *   npm run rerank:verify    regenerate and fail if it differs from what is
 *                            committed
 *
 * Same reasoning as `build_embeddings.js`: committing the scores means
 * `npm run eval` needs no model download, runs in CI in seconds, cannot fail for
 * network reasons, and produces the same numbers on anyone's machine.
 *
 * WHY ALL 26 AND NOT JUST THE POOL
 *
 * The reranker only ever sees the retriever's top 10 in production. Scoring all
 * 26 here costs 62 x 26 forward passes once, and in exchange the pool size stops
 * being baked into the fixture -- the eval can vary it, and the bake-off's
 * pool-10-versus-pool-26 comparison stays reproducible from committed data. A
 * fixture that only holds the current configuration cannot be used to question
 * the current configuration.
 *
 * These are raw logits. They are unbounded, uncalibrated, and comparable only
 * within a single query's candidate list. Nothing downstream should treat one as
 * a probability or a confidence.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rerank = require('../rerank');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const EVAL_DIR = path.join(ROOT, 'eval');
const OUT_PATH = path.join(EVAL_DIR, 'rerank_scores.json');

// Logits are far coarser-grained than cosines -- they span roughly [-12, +2]
// here rather than [-1, 1] -- so four decimal places is well below any
// difference that could reorder two candidates.
const STORED_PRECISION = 4;

// Cross-platform ONNX noise, in units of the last stored place. Same reasoning
// as the embedding verifier: agreement to the stored precision give or take a
// unit is agreement, and a real model change moves logits by whole numbers.
const MAX_UNITS_APART = 1;

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function digest(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

function round(value) {
  const factor = 10 ** STORED_PRECISION;
  return Math.round(value * factor) / factor;
}

async function build() {
  const kb = loadJson(KB_PATH);
  const policyQueries = loadJson(path.join(EVAL_DIR, 'policy_queries.json'));

  // Set A (the corpus's own question fields), Set B (the paraphrases), and the
  // out-of-scope probes, which the abstention gate needs. Intent utterances are
  // not included: intent classification never reranks.
  const setA = kb.filter((e) => e.question).map((e) => e.question);
  const setB = policyQueries.cases.map((c) => c.q);
  const outOfScope = loadJson(path.join(EVAL_DIR, 'out_of_scope_queries.json'))
    .cases.map((c) => c.q);
  const queries = [...new Set([...setA, ...setB, ...outOfScope])];

  const passages = kb.map((e) => rerank.passageText(e));
  const scores = {};

  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i];
    process.stdout.write(
      `\rscoring query ${i + 1}/${queries.length} x ${kb.length} policies ... `,
    );
    const logits = await rerank.scorePairs(query, passages);
    const row = {};
    kb.forEach((entry, j) => { row[entry.id] = round(logits[j]); });
    scores[query] = row;
  }
  process.stdout.write('done\n');

  return {
    about: 'Precomputed cross-encoder reranking scores. Regenerate with '
      + '`npm run rerank:build`; verify with `npm run rerank:verify`. Committed '
      + 'so retrieval scoring in CI needs no model download.',
    model: rerank.MODEL_ID,
    stored_precision: STORED_PRECISION,
    passage_text_fields: ['question', 'category', 'answer'],
    score_type: 'raw logit, unbounded and uncalibrated; ordering only',
    corpus_digest: digest(kb),
    queries_digest: digest(queries.slice().sort()),
    scores,
  };
}

/** One query's full score row per line, for the same diff-readability reason. */
function serialise(data) {
  const { scores, ...meta } = data;
  const lines = ['{'];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('  "scores": {');
  const keys = Object.keys(scores);
  keys.forEach((key, i) => {
    const comma = i === keys.length - 1 ? '' : ',';
    lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(scores[key])}${comma}`);
  });
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const verify = process.argv.includes('--verify');

  if (!rerank.isAvailable()) {
    console.error(
      'The optional @huggingface/transformers package is not installed.\n'
      + 'Run `npm install` in hr-backend (without --omit=dev) and retry.',
    );
    process.exit(1);
  }

  const built = await build();

  if (!verify) {
    fs.writeFileSync(OUT_PATH, serialise(built));
    console.log(`\nwrote ${path.relative(ROOT, OUT_PATH)}`);
    console.log(`  model              ${built.model}`);
    console.log(`  queries            ${Object.keys(built.scores).length}`);
    console.log(`  corpus digest      ${built.corpus_digest}`);
    return;
  }

  if (!fs.existsSync(OUT_PATH)) {
    console.error(
      `missing ${path.relative(ROOT, OUT_PATH)} -- run \`npm run rerank:build\``,
    );
    process.exit(1);
  }

  const committed = loadJson(OUT_PATH);
  const problems = [];

  if (committed.model !== built.model) {
    problems.push(`model changed: ${committed.model} -> ${built.model}`);
  }
  if (committed.corpus_digest !== built.corpus_digest) {
    problems.push(
      `corpus changed since the scores were built (${committed.corpus_digest} `
      + `-> ${built.corpus_digest}); run \`npm run rerank:build\``,
    );
  }
  if (committed.queries_digest !== built.queries_digest) {
    problems.push('eval queries changed; run `npm run rerank:build`');
  }

  const scale = 10 ** STORED_PRECISION;
  let maxUnits = 0;
  let drifted = 0;
  for (const [query, row] of Object.entries(built.scores)) {
    const other = committed.scores[query];
    if (!other) { problems.push(`missing committed scores for ${query}`); continue; }
    for (const [id, value] of Object.entries(row)) {
      if (other[id] === undefined) {
        problems.push(`missing committed score for ${id} / ${query}`);
        continue;
      }
      const units = Math.abs(
        Math.round(value * scale) - Math.round(other[id] * scale),
      );
      if (units > maxUnits) maxUnits = units;
      if (units > MAX_UNITS_APART) drifted += 1;
    }
  }

  console.log('\nverify:');
  console.log(`  model              ${built.model}`);
  console.log(`  corpus digest      ${built.corpus_digest}`);
  console.log(`  max drift          ${maxUnits} unit(s) of ${1 / scale}`);
  console.log(`  scores drifted     ${drifted} `
    + `(allowed: up to ${MAX_UNITS_APART} unit apart)`);

  if (drifted > 0) {
    problems.push(
      `${drifted} score(s) differ by more than ${MAX_UNITS_APART} unit of the `
      + `stored precision (worst: ${maxUnits} units) -- the model or its `
      + 'settings changed.',
    );
  }

  if (problems.length) {
    console.error('\nrerank score verification FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nrerank scores match the committed file.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
