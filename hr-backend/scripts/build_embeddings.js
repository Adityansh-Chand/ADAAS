'use strict';

/**
 * Precompute sentence embeddings for the policy corpus and every eval query.
 *
 *   npm run embed          regenerate and write
 *   npm run embed:verify   regenerate and fail if the result differs from what
 *                          is committed
 *
 * Committing the vectors buys three things. Scoring retrieval in CI needs no
 * model download, so the eval is fast and cannot fail for network reasons. The
 * numbers are reproducible by anyone without a GPU or an account. And `--verify`
 * turns "the embeddings match the corpus" into a check that can fail, rather
 * than an assumption — if someone edits a policy and forgets to re-embed, the
 * dense numbers would silently be scored against stale vectors.
 *
 * Text embedded per policy is `question + category + keywords + answer`. The
 * question field is included here deliberately, unlike in the lexical retriever
 * where it is weighted 0: for the dense path the leakage argument does not apply
 * in the same way, because Set A is not the set the dense method is judged on.
 * Set B is. This is stated in the eval output so the comparison is not silently
 * unfair.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const embeddings = require('../embeddings');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const EVAL_DIR = path.join(ROOT, 'eval');
const OUT_PATH = path.join(EVAL_DIR, 'embeddings.json');

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** What gets embedded for a policy. Kept in one place so it cannot drift. */
function policyText(entry) {
  return [
    entry.question || '',
    entry.category || '',
    (entry.keywords || []).join(', '),
    entry.answer || '',
  ].filter(Boolean).join('\n');
}

function digest(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

async function build() {
  const kb = loadJson(KB_PATH);
  const policyQueries = loadJson(path.join(EVAL_DIR, 'policy_queries.json'));

  // Set A queries are the corpus's own question fields; Set B is the paraphrases.
  const setAQueries = kb.filter((e) => e.question).map((e) => e.question);
  const setBQueries = policyQueries.cases.map((c) => c.q);
  const allQueries = [...new Set([...setAQueries, ...setBQueries])];

  process.stdout.write(`embedding ${kb.length} policies ... `);
  const policyVectors = await embeddings.embed(kb.map(policyText));
  process.stdout.write('done\n');

  process.stdout.write(`embedding ${allQueries.length} queries ... `);
  const queryVectors = await embeddings.embed(allQueries);
  process.stdout.write('done\n');

  const policies = {};
  kb.forEach((entry, i) => { policies[entry.id] = policyVectors[i]; });

  const queries = {};
  allQueries.forEach((q, i) => { queries[q] = queryVectors[i]; });

  return {
    about: 'Precomputed sentence embeddings. Regenerate with `npm run embed`; '
      + 'verify with `npm run embed:verify`. Committed so retrieval scoring in CI '
      + 'needs no model download and is reproducible without an account.',
    model: embeddings.MODEL_ID,
    dimensions: embeddings.DIMENSIONS,
    stored_precision: embeddings.STORED_PRECISION,
    // Recorded because embeddings are mildly batch-dependent: texts are padded
    // to the longest item in their batch, so changing the batch size shifts
    // every vector slightly. Editing one policy answer drifted four vectors in
    // testing, not just its own.
    batch_size: embeddings.BATCH_SIZE,
    policy_text_fields: ['question', 'category', 'keywords', 'answer'],
    // Ties the vectors to the exact corpus they were built from, so a policy
    // edit without a re-embed is detectable rather than silent.
    corpus_digest: digest(kb),
    queries_digest: digest(allQueries.slice().sort()),
    policies,
    queries,
  };
}

/**
 * One vector per line.
 *
 * `JSON.stringify(x, null, 1)` puts every one of the ~34,000 floats on its own
 * line, which makes the committed file unreadable and turns a re-embed into a
 * 34,000-line diff. Keeping each vector on a single line means an edited policy
 * shows up as one changed line, which is the difference between a reviewable
 * artifact and noise.
 */
function serialise(data) {
  const { policies, queries, ...meta } = data;
  const lines = ['{'];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  const block = (name, table) => {
    lines.push(`  ${JSON.stringify(name)}: {`);
    const keys = Object.keys(table);
    keys.forEach((key, i) => {
      const comma = i === keys.length - 1 ? '' : ',';
      lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(table[key])}${comma}`);
    });
    lines.push('  }');
  };
  block('policies', policies);
  lines[lines.length - 1] += ',';
  block('queries', queries);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const verify = process.argv.includes('--verify');

  if (!embeddings.isAvailable()) {
    console.error(
      'The optional @huggingface/transformers package is not installed.\n'
      + 'Run `npm install` in hr-backend (without --omit=dev) and retry.',
    );
    process.exit(1);
  }

  const built = await build();

  if (!verify) {
    fs.writeFileSync(OUT_PATH, serialise(built));
    const kb = loadJson(KB_PATH);
    console.log(`\nwrote ${path.relative(ROOT, OUT_PATH)}`);
    console.log(`  model              ${built.model}`);
    console.log(`  policies           ${Object.keys(built.policies).length}`);
    console.log(`  queries            ${Object.keys(built.queries).length}`);
    console.log(`  corpus digest      ${built.corpus_digest} (${kb.length} entries)`);
    return;
  }

  if (!fs.existsSync(OUT_PATH)) {
    console.error(`missing ${path.relative(ROOT, OUT_PATH)} -- run \`npm run embed\``);
    process.exit(1);
  }

  const committed = loadJson(OUT_PATH);
  const problems = [];

  if (committed.batch_size !== built.batch_size) {
    problems.push(
      `batch size changed: ${committed.batch_size} -> ${built.batch_size}; `
      + 'every vector shifts with it, so re-embed rather than comparing',
    );
  }
  if (committed.model !== built.model) {
    problems.push(`model changed: ${committed.model} -> ${built.model}`);
  }
  if (committed.corpus_digest !== built.corpus_digest) {
    problems.push(
      `corpus changed since the vectors were built (${committed.corpus_digest} `
      + `-> ${built.corpus_digest}); run \`npm run embed\``,
    );
  }
  if (committed.queries_digest !== built.queries_digest) {
    problems.push(
      `eval queries changed since the vectors were built; run \`npm run embed\``,
    );
  }

  // Compare component-wise against the storage granularity, not by cosine.
  // Cosine is the wrong test here: rounding to STORED_PRECISION leaves a vector
  // very slightly off unit norm, so cosine(v, v) lands around 0.99998 for
  // byte-identical vectors and a tight threshold reports drift that does not
  // exist. The first run of this check did exactly that -- max component delta
  // 0.00e+0 alongside "1 policy vector drifted".
  const tolerance = 10 ** -embeddings.STORED_PRECISION;
  let drifted = 0;
  let maxDelta = 0;
  for (const [id, vector] of Object.entries(built.policies)) {
    const other = committed.policies[id];
    if (!other) { problems.push(`missing committed vector for ${id}`); continue; }
    let worst = 0;
    for (let i = 0; i < vector.length; i += 1) {
      const delta = Math.abs(vector[i] - other[i]);
      if (delta > worst) worst = delta;
    }
    if (worst > maxDelta) maxDelta = worst;
    if (worst > tolerance) drifted += 1;
  }

  console.log('\nverify:');
  console.log(`  model              ${built.model}`);
  console.log(`  corpus digest      ${built.corpus_digest}`);
  console.log(`  max component drift ${maxDelta.toExponential(2)}`);
  console.log(`  policies drifted   ${drifted} (tolerance ${tolerance})`);

  if (drifted > 0) {
    problems.push(
      `${drifted} policy vector(s) differ beyond rounding -- the model or its `
      + 'settings changed, or ONNX is producing different values on this CPU',
    );
  }

  if (problems.length) {
    console.error('\nembedding verification FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nembeddings match the committed file.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
