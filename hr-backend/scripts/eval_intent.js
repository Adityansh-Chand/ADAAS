'use strict';

/**
 * Scores intent classification and prints the numbers.
 *
 *   npm run eval:intent        all methods on all sets
 *   npm run eval:intent:gate   exits non-zero if a gate trips (CI uses this)
 *
 * Two methods on identical sets:
 *
 *   rules       the rule-based router that shipped first
 *   embedding   k-NN over MiniLM embeddings of eval/intent_training.json,
 *               falling back to the rules when it declines
 *
 * Which set means what, because this is the whole point:
 *
 *   intent_queries    the rules were written with these visible. A high score
 *                     means the rules cover the cases their author thought of.
 *   held_out_1        BURNED. Written after v1 of the rules; its failures
 *                     revealed two general bugs and the fixes were informed by
 *                     it, so its score is no longer independent.
 *   held_out_2        Written after v2 of the rules. Clean for the rules only in
 *                     the sense that no vocabulary was taken from it -- but its
 *                     score was seen before a later change, so it is treated as
 *                     compromised.
 *   held_out_3        Written BEFORE the classifier existed and before any
 *                     classifier score was seen. This is the clean number.
 *
 *   intent_training   TRAINING data for the classifier. Reported for reference
 *                     and never gated: a classifier scoring well on its own
 *                     training set has demonstrated nothing.
 */

const fs = require('fs');
const path = require('path');

const intent = require('../intent');
const dense = require('../dense');

const ROOT = path.resolve(__dirname, '..', '..');
const EVAL_DIR = path.join(ROOT, 'eval');

// Floors, not targets. The classifier's floor is on held_out_3 because that is
// the only set it has never been exposed to; the rules' floors sit below their
// measured values so a regression trips them.
const QUALITY_GATES = {
  'rules held_out_3': 0.35,
  'embedding held_out_3': 0.55,
};

// Leakage is checked directly rather than inferred from a suspiciously high score.
//
// The first version of this gate failed the build when held_out_3 accuracy went
// above 0.95, by analogy with the retrieval ceiling. That was the wrong
// instrument: retrieval over 26 documents is a far harder problem than 3-way
// intent classification, and 0.9667 turned out to be genuine. Measuring the
// nearest-neighbour similarity between each eval query and the training set
// settled it -- max 0.8035, mean 0.5159, nothing above 0.90, so no near
// duplicates. That measurement is now the gate, because it tests the thing the
// accuracy ceiling was only a proxy for.
//
// 0.92 is above the observed max with margin. Two differently-worded sentences
// can legitimately reach the low 0.8s; above 0.92 they are paraphrases of each
// other and the eval has stopped being held out.
const LEAKAGE_SIMILARITY_CEILING = 0.92;

const SETS = [
  ['intent_training', 'intent_training.json', 'TRAINING -- never gated'],
  ['intent_queries', 'intent_queries.json', 'rules were written against these'],
  ['held_out_1', 'held_out_intent_queries.json', 'BURNED -- informed rule fixes'],
  ['held_out_2', 'held_out_intent_queries_2.json', 'compromised -- seen before a change'],
  ['held_out_3', 'held_out_intent_queries_3.json', 'CLEAN for the classifier'],
];

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function score(cases, decide) {
  let correct = 0;
  const confusion = {};
  const misroutes = [];
  const methods = {};

  for (const c of cases) {
    const { intent: got, method } = decide(c.q);
    methods[method] = (methods[method] || 0) + 1;
    if (got === c.label) {
      correct += 1;
    } else {
      const key = `${c.label} -> ${got}`;
      confusion[key] = (confusion[key] || 0) + 1;
      misroutes.push({ q: c.q, want: c.label, got, method });
    }
  }

  return {
    n: cases.length,
    accuracy: correct / cases.length,
    confusion,
    misroutes,
    methods,
  };
}

const fmt = (v) => v.toFixed(4);

function cosineOf(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * The single closest training/eval pair across every held-out set.
 *
 * This is the real leakage test. A high accuracy on unseen phrasing is only
 * suspicious if the phrasing is not actually unseen, and that is measurable.
 */
function worstLeakage(training, sets, store) {
  let worst = { similarity: 0, query: null, trainingExample: null, set: null };
  for (const [name, file] of sets) {
    if (name === 'intent_training') continue;
    const cases = loadJson(path.join(EVAL_DIR, file)).cases;
    for (const c of cases) {
      const v = store.queries[c.q];
      if (!v) continue;
      for (const t of training) {
        const tv = store.queries[t.q];
        if (!tv) continue;
        const similarity = cosineOf(v, tv);
        if (similarity > worst.similarity) {
          worst = { similarity, query: c.q, trainingExample: t.q, set: name };
        }
      }
    }
  }
  return worst;
}

function main() {
  const args = process.argv.slice(2);
  const gate = args.includes('--gate');
  const verbose = args.includes('--verbose') || !gate;

  const store = dense.loadVectors();
  if (!store) {
    console.error('eval/embeddings.json is missing. Run `npm run embed`.');
    process.exit(1);
  }

  const training = loadJson(path.join(EVAL_DIR, 'intent_training.json')).cases;
  const classifier = intent.buildClassifier(training, store.queries);

  if (classifier.missing.length) {
    console.error(
      `${classifier.missing.length} training example(s) have no embedding. `
      + 'Run `npm run embed`.',
    );
    for (const q of classifier.missing.slice(0, 5)) console.error(`  - ${q}`);
    process.exit(1);
  }

  const decideRules = (q) => ({ intent: intent.routeByRules(q), method: 'rules' });
  const decideEmbedding = (q) => {
    const vector = store.queries[q];
    if (!vector) {
      throw new Error(`no precomputed embedding for ${JSON.stringify(q)} -- run \`npm run embed\``);
    }
    return intent.route(q, classifier, vector);
  };

  console.log('');
  console.log('Intent classification');
  console.log(`training examples: ${classifier.examples.length}    `
    + `k: ${classifier.k}    min confidence: ${classifier.minConfidence}`);
  console.log(`model: ${store.model}`);
  console.log('');

  const results = {};
  console.log('  set                accuracy (rules)   accuracy (embedding)   note');
  for (const [name, file, note] of SETS) {
    const cases = loadJson(path.join(EVAL_DIR, file)).cases;
    const r = score(cases, decideRules);
    const e = score(cases, decideEmbedding);
    results[`rules ${name}`] = r;
    results[`embedding ${name}`] = e;
    console.log(
      `  ${name.padEnd(17)} ${fmt(r.accuracy)} (n=${String(r.n).padStart(2)})     `
      + `${fmt(e.accuracy)} (n=${String(e.n).padStart(2)})        ${note}`,
    );
  }

  const clean = results['embedding held_out_3'];
  console.log('');
  console.log('Method split on held_out_3 (embedding):',
    JSON.stringify(clean.methods));

  if (verbose) {
    for (const key of ['rules held_out_3', 'embedding held_out_3']) {
      const r = results[key];
      console.log(`\n  --- ${key}: ${r.misroutes.length} misroute(s) ---`);
      for (const [pair, count] of Object.entries(r.confusion)) {
        console.log(`      ${pair}  x${count}`);
      }
      for (const m of r.misroutes) {
        console.log(`      "${m.q}"`);
        console.log(`           want ${m.want}, got ${m.got} (via ${m.method})`);
      }
    }
  }

  console.log('');
  const failures = [];
  for (const [key, floor] of Object.entries(QUALITY_GATES)) {
    const actual = results[key].accuracy;
    const ok = actual >= floor;
    console.log(`  gate ${key.padEnd(24)} floor ${fmt(floor)}  actual ${fmt(actual)}  `
      + `${ok ? 'ok' : 'FAIL'}`);
    if (!ok) failures.push(`${key} ${fmt(actual)} < floor ${fmt(floor)}`);
  }

  // Leakage check: has any eval query drifted close enough to a training example
  // that the set is no longer held out?
  const leak = worstLeakage(training, SETS, store);
  const leakOk = leak.similarity < LEAKAGE_SIMILARITY_CEILING;
  console.log(
    `  gate ${'training/eval overlap'.padEnd(24)} max ${fmt(LEAKAGE_SIMILARITY_CEILING)}  `
    + `actual ${fmt(leak.similarity)}  ${leakOk ? 'ok' : 'FAIL'}`,
  );
  if (!leakOk) {
    failures.push(
      `eval query "${leak.query}" (${leak.set}) is ${fmt(leak.similarity)} similar `
      + `to training example "${leak.trainingExample}" -- rewrite one of them, `
      + 'the set is no longer held out',
    );
  }

  console.log('');
  if (gate && failures.length) {
    console.error('intent quality gate failed:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
