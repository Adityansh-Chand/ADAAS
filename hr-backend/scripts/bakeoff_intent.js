'use strict';

/**
 * Decision-rule selection for the intent classifier.
 *
 *   npm run bakeoff:intent
 *
 * WHY THIS EXISTS, AND WHY IT REFUSES TO OPEN THREE FILES
 *
 * The classifier scored 0.9000 on held_out_3 after the embedding model changed,
 * down from 0.9667. eval_intent.js records why that was not reverted: the model
 * had been chosen on the sets that were not held out, and re-picking it on the
 * strength of the held_out_3 number would have spent the only clean set the
 * classifier had. It also recorded what the honest route would be -- "a fourth
 * held-out set written before anything is re-picked" -- and that is what
 * eval/held_out_intent_queries_4.json is.
 *
 * So the discipline is enforced in code rather than promised in a comment. This
 * script reads exactly three things:
 *
 *   intent_training.json   leave-one-out, so an example never predicts itself
 *   intent_queries.json    the rules were fitted to these; the classifier was
 *                          not, and this is its weakest measured set
 *   held_out_1             already burned by the rule work, so it has nothing
 *                          left to lose and is honest dev data here
 *
 * and refuses to open sets 2, 3 and 4 at all -- see FORBIDDEN below, which
 * throws rather than warning. The winner is committed, and only then does
 * `npm run eval:intent` read the held-out sets, once.
 *
 * WHAT IS BEING SELECTED
 *
 * Not the embedding model -- that is shared with retrieval, where it is worth
 * four cases out of eighteen, and intent does not get to override it. What is
 * selectable is everything downstream of the vectors: how many neighbours vote,
 * how their votes are weighted, and whether k-nearest-neighbour is the right
 * shape of classifier at all. The incumbent (k=5, similarity-weighted votes) was
 * never compared against anything, including the two-line alternatives.
 *
 * The enlarged training set is reported as its own row, so the data change and
 * the method change are attributed separately rather than as one number.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EVAL_DIR = path.join(ROOT, 'eval');
const OUT_PATH = path.join(EVAL_DIR, 'bakeoff_intent.json');

const INTENTS = ['leaveBalance', 'applyLeave', 'policyQuestion'];

// Reading any of these would turn a held-out set into a fitted one. The check is
// on the path, so it also catches a later edit that adds one to the dev list by
// mistake -- the failure mode this is actually guarding against, since nobody
// sets out to read a file they know is held out.
const FORBIDDEN = [
  'held_out_intent_queries_2.json',
  'held_out_intent_queries_3.json',
  'held_out_intent_queries_4.json',
  'held_out_intent_queries_5.json',
];

function loadEvalJson(name) {
  if (FORBIDDEN.includes(name)) {
    throw new Error(
      `bakeoff_intent.js must not read ${name}. It is held out; scoring it here `
      + 'would make it a set the decision rule was fitted to. Read it once, from '
      + 'scripts/eval_intent.js, after the winner is committed.',
    );
  }
  return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, name), 'utf8'));
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

// The same model and the same query-side prefix production uses. A bakeoff that
// embedded differently from the service would measure the difference.
const embeddingsModule = require('../embeddings');
const intentModule = require('../intent');

async function embedAll(texts, batchSize = 32) {
  const t = await tf();
  const pipe = await t.pipeline('feature-extraction', embeddingsModule.MODEL_ID, {
    dtype: 'fp32',
  });
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const result = await pipe(
      texts.slice(i, i + batchSize).map((x) => embeddingsModule.QUERY_PREFIX + x),
      { pooling: 'mean', normalize: true },
    );
    out.push(...result.tolist());
  }
  return out;
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

// ---------------------------------------------------------------------------
// Candidate decision rules
//
// Each is a factory: given labelled (vector, label) examples, return a function
// from a query vector to a label. None of them may decline -- the abstention
// threshold is a separate question, and mixing it in here would confuse "chose
// the wrong class" with "chose not to choose".
// ---------------------------------------------------------------------------

/**
 * k-nearest neighbour, votes weighted by similarity raised to `power`.
 *
 * power=1 is the incumbent. Higher powers sharpen: with cosines from a
 * contrastively-trained encoder all sitting in a narrow high band (roughly
 * 0.5-0.85 here), a linear weight makes the 5th neighbour almost as loud as the
 * 1st, so the vote is close to unweighted majority. Raising the power is the
 * cheapest way to let the nearest neighbour actually dominate.
 */
const knn = (k, power) => (examples) => (v) => {
  const scored = examples
    .map((e) => ({ label: e.label, s: cosine(v, e.vector) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  const votes = {};
  for (const { label, s } of scored) {
    votes[label] = (votes[label] || 0) + Math.max(0, s) ** power;
  }
  return INTENTS.reduce(
    (best, l) => ((votes[l] || 0) > (votes[best] || 0) ? l : best), INTENTS[0],
  );
};

/**
 * Nearest class centroid.
 *
 * One vector per class, so it cannot be misled by a single odd neighbour, and it
 * uses every example rather than k of them. The failure mode is the opposite:
 * a class whose examples form two separate clusters (applyLeave contains both
 * "book the 14th" and "not coming in, bad back") gets a centroid between them
 * that resembles neither.
 */
const centroid = () => (examples) => {
  const sums = new Map();
  const counts = new Map();
  for (const e of examples) {
    if (!sums.has(e.label)) {
      sums.set(e.label, new Array(e.vector.length).fill(0));
      counts.set(e.label, 0);
    }
    const s = sums.get(e.label);
    for (let i = 0; i < e.vector.length; i += 1) s[i] += e.vector[i];
    counts.set(e.label, counts.get(e.label) + 1);
  }
  const centroids = [];
  for (const [label, s] of sums) {
    const norm = Math.sqrt(s.reduce((acc, x) => acc + x * x, 0)) || 1;
    centroids.push({ label, vector: s.map((x) => x / norm) });
  }
  return (v) => centroids
    .map((c) => ({ label: c.label, s: cosine(v, c.vector) }))
    .sort((a, b) => b.s - a.s)[0].label;
};

/** Mean of the two rules above, on rank-free normalised scores. */
const centroidPlusKnn = (k, power, w) => (examples) => {
  const byCentroid = centroid()(examples);
  const byKnn = knn(k, power)(examples);
  // Not a score blend -- the two produce labels, not comparable scores. This
  // agrees when they agree and follows `w` when they do not, which is the only
  // honest thing two label-producing rules can be combined into.
  return (v) => {
    const a = byCentroid(v);
    const b = byKnn(v);
    if (a === b) return a;
    return w >= 0.5 ? b : a;
  };
};

/**
 * Multinomial logistic regression -- the production implementation, called with
 * varying hyperparameters.
 *
 * Deliberately not reimplemented here. Every other candidate in this file is a
 * few lines and local, but this one is the candidate that might win, and a
 * bakeoff carrying its own copy of the winner would be selecting a
 * hyperparameter for code that does not serve requests. The two would then drift
 * silently, and the committed numbers would be about the copy.
 */
const logreg = (iterations, learningRate, l2) => (examples) => {
  const model = intentModule.fitLogisticRegression(examples, {
    iterations, learningRate, l2,
  });
  return (v) => model.predict(v).label;
};

const CANDIDATES = [
  { label: 'k-NN k=1', build: knn(1, 1) },
  { label: 'k-NN k=3, weight s^1', build: knn(3, 1) },
  { label: 'k-NN k=5, weight s^1 (incumbent)', build: knn(5, 1) },
  { label: 'k-NN k=7, weight s^1', build: knn(7, 1) },
  { label: 'k-NN k=11, weight s^1', build: knn(11, 1) },
  { label: 'k-NN k=5, weight s^8', build: knn(5, 8) },
  { label: 'k-NN k=11, weight s^8', build: knn(11, 8) },
  { label: 'k-NN k=11, weight s^16', build: knn(11, 16) },
  { label: 'nearest centroid', build: centroid() },
  { label: 'centroid, k-NN k=11 s^8 breaks ties', build: centroidPlusKnn(11, 8, 1) },
  { label: 'logistic regression, l2=1e-4', build: logreg(300, 4, 1e-4) },
  { label: 'logistic regression, l2=1e-3', build: logreg(300, 4, 1e-3) },
  { label: 'logistic regression, l2=1e-2', build: logreg(300, 4, 1e-2) },
  { label: 'logistic regression, l2=3e-2', build: logreg(300, 4, 3e-2) },
  { label: 'logistic regression, l2=1e-1', build: logreg(300, 4, 1e-1) },
  { label: 'logistic regression, l2=1e-2, 900 iters', build: logreg(900, 4, 1e-2) },
];

// The rule the size comparison is reported for, alongside the incumbent. Both
// are shown because the data change and the method change interact: more
// examples is not automatically better, and this project has already been
// surprised once by assuming it was.
const REPORT_SIZE_EFFECT_FOR = [
  ['k-NN k=5, s^1 (incumbent)', knn(5, 1)],
  ['nearest centroid', centroid()],
  ['logistic regression, l2=1e-2', logreg(300, 4, 1e-2)],
];

/** Leave-one-out accuracy on the training set. */
function looAccuracy(examples, build) {
  let correct = 0;
  for (let i = 0; i < examples.length; i += 1) {
    const rest = examples.filter((_, j) => j !== i);
    if (build(rest)(examples[i].vector) === examples[i].label) correct += 1;
  }
  return correct / examples.length;
}

function accuracy(examples, cases, vectors, build) {
  const decide = build(examples);
  let correct = 0;
  for (const c of cases) {
    if (decide(vectors.get(c.q)) === c.label) correct += 1;
  }
  return correct / cases.length;
}

const fmt = (v) => v.toFixed(4);

async function main() {
  const training = loadEvalJson('intent_training.json').cases;
  const devSets = [
    ['intent_queries', loadEvalJson('intent_queries.json').cases],
    ['held_out_1', loadEvalJson('held_out_intent_queries.json').cases],
  ];

  const allTexts = [
    ...training.map((c) => c.q),
    ...devSets.flatMap(([, cases]) => cases.map((c) => c.q)),
  ];
  const unique = [...new Set(allTexts)];
  console.log('');
  console.log('Intent decision rule -- dev only');
  console.log(`  model: ${embeddingsModule.MODEL_ID}`);
  console.log(`  training ${training.length}   embedding ${unique.length} texts`);

  const vectorList = await embedAll(unique);
  const vectors = new Map(unique.map((q, i) => [q, vectorList[i]]));
  const examples = training.map((c) => ({ label: c.label, vector: vectors.get(c.q) }));

  // The data change, measured on its own before any method change, so the two
  // are not reported as one number. The original 64 are still the first 64
  // entries of the file; extend_training preserved order deliberately.
  const original = examples.slice(0, 64);
  console.log('');
  console.log('  What the 54 extra training examples did, per decision rule:');
  const sizeEffect = [];
  for (const [ruleName, build] of REPORT_SIZE_EFFECT_FOR) {
    for (const [name, cases] of devSets) {
      const before = accuracy(original, cases, vectors, build);
      const after = accuracy(examples, cases, vectors, build);
      sizeEffect.push({
        rule: ruleName, set: name, at64: before, at118: after, delta: after - before,
      });
      console.log(
        `    ${ruleName.padEnd(30)} ${name.padEnd(16)} `
        + `64 ${fmt(before)} -> ${examples.length} ${fmt(after)}   `
        + `${after >= before ? '+' : ''}${fmt(after - before)}`,
      );
    }
  }

  console.log('');
  console.log(`  ${'decision rule'.padEnd(38)} `
    + `${'LOO'.padEnd(8)}${'queries'.padEnd(9)}${'held1'.padEnd(9)}mean`);

  const rows = [];
  for (const cand of CANDIDATES) {
    const loo = looAccuracy(examples, cand.build);
    const perSet = devSets.map(([name, cases]) => [
      name, accuracy(examples, cases, vectors, cand.build),
    ]);
    // Mean of the three, unweighted. The three sets differ in size (118 / 48 /
    // 24) but not in how much each is trusted, and weighting by size would let
    // the leave-one-out number, which is the least independent of the three,
    // dominate the ranking.
    const mean = (loo + perSet.reduce((a, [, v]) => a + v, 0)) / (perSet.length + 1);
    rows.push({ label: cand.label, loo, ...Object.fromEntries(perSet), mean });
    console.log(
      `  ${cand.label.padEnd(38)} ${fmt(loo)}  `
      + perSet.map(([, v]) => `${fmt(v)}   `).join('')
      + `${fmt(mean)}`,
    );
  }

  const best = rows.slice().sort((a, b) => b.mean - a.mean)[0];

  // -------------------------------------------------------------------------
  // Calibrating the confidence floor
  //
  // The old floor of 0.18 was on a scale that no longer exists -- it applied to
  // a k-NN vote share times a similarity, and the new score is a softmax
  // probability times a similarity. Carrying the number across would have been
  // meaningless, so it is re-measured here, on dev, before eval_intent.js reads
  // anything held out.
  //
  // Two distributions matter and they are not the same question. In-domain dev
  // queries set the floor's ceiling: anything above their minimum starts
  // refusing real messages, and refusing is expensive because the fallback is
  // the rules, which score far worse. The out-of-scope probes from
  // eval/out_of_scope_queries.json set the floor's floor: they are the closest
  // thing to genuinely unlike-anything input this project has, being neither
  // leave requests nor answerable HR questions.
  //
  // If the two ranges do not separate, that is the finding, and the floor stays
  // a guard against degenerate input rather than being tuned into a detector it
  // cannot be.
  // -------------------------------------------------------------------------
  const model = intentModule.fitLogisticRegression(examples, {
    iterations: intentModule.DEFAULT_ITERATIONS,
    learningRate: intentModule.DEFAULT_LEARNING_RATE,
    l2: intentModule.DEFAULT_L2,
  });
  const classifier = { minConfidence: 0, examples, model };

  const confidencesFor = (texts, vecs) => texts
    .map((q) => intentModule.classify(classifier, vecs.get(q)).confidence)
    .sort((a, b) => a - b);

  const inDomain = confidencesFor(
    devSets.flatMap(([, cases]) => cases.map((c) => c.q)), vectors,
  );

  const oos = loadEvalJson('out_of_scope_queries.json').cases.map((c) => c.q);
  const oosVectorList = await embedAll(oos);
  const oosVectors = new Map(oos.map((q, i) => [q, oosVectorList[i]]));
  const outOfDomain = confidencesFor(oos, oosVectors);

  const stat = (xs) => ({
    min: xs[0],
    p5: xs[Math.floor(xs.length * 0.05)],
    median: xs[Math.floor(xs.length / 2)],
    max: xs[xs.length - 1],
  });
  const inStat = stat(inDomain);
  const outStat = stat(outOfDomain);

  console.log('');
  console.log('  Confidence floor calibration (winner\'s hyperparameters):');
  console.log(`    in-domain  n=${inDomain.length}  min ${fmt(inStat.min)}  `
    + `p5 ${fmt(inStat.p5)}  median ${fmt(inStat.median)}  max ${fmt(inStat.max)}`);
  console.log(`    out-of-scope n=${outOfDomain.length}  min ${fmt(outStat.min)}  `
    + `p5 ${fmt(outStat.p5)}  median ${fmt(outStat.median)}  `
    + `max ${fmt(outStat.max)}`);
  console.log(`    separable: ${outStat.max < inStat.min ? 'YES' : 'NO'} `
    + `(out max ${fmt(outStat.max)} vs in min ${fmt(inStat.min)})`);
  console.log(`    current floor: ${intentModule.DEFAULT_MIN_CONFIDENCE} -- `
    + `would decline ${inDomain.filter((c) => c < intentModule.DEFAULT_MIN_CONFIDENCE).length}`
    + ` of ${inDomain.length} in-domain, `
    + `${outOfDomain.filter((c) => c < intentModule.DEFAULT_MIN_CONFIDENCE).length}`
    + ` of ${outOfDomain.length} out-of-scope`);
  console.log('');
  console.log(`  best by mean: ${best.label}  (${fmt(best.mean)})`);
  console.log('  Held-out sets 2, 3 and 4 are NOT read here. Commit the winner,');
  console.log('  then `npm run eval:intent` scores them once.');
  console.log('');

  fs.writeFileSync(OUT_PATH, `${JSON.stringify({
    model: embeddingsModule.MODEL_ID,
    training_examples: examples.length,
    dev_sets: devSets.map(([n, c]) => ({ name: n, n: c.length })),
    size_effect: sizeEffect,
    forbidden: FORBIDDEN,
    candidates: rows,
    winner: best.label,
    confidence_calibration: {
      in_domain: inStat,
      out_of_scope: outStat,
      separable: outStat.max < inStat.min,
      floor: intentModule.DEFAULT_MIN_CONFIDENCE,
    },
  }, null, 2)}\n`);
  console.log(`  wrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
