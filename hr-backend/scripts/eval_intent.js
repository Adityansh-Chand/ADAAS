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
 *   embedding   k-NN over bge-small-en-v1.5 embeddings of
 *               eval/intent_training.json, falling back to the rules when it
 *               declines
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
  'embedding held_out_3': 0.88,
  'embedding held_out_4': 0.72,
  'embedding held_out_5': 0.80,
};

// ACTION SAFETY
//
// A separate gate because it is a separate failure. The gates above ask how often
// the classifier is right; this asks how often a question becomes an action, and
// those are not the same question in an app where one intent answers and the
// other two write to or read from someone's leave record.
//
// It exists because a screenshot found what no evaluation had: asked "Can I work
// from my house a few days a week?", the app routed to applyLeave and attempted
// to file five days of casual leave. The 36 retrieval paraphrases are 36 policy
// questions, and no intent fixture had ever contained one.
//
// Gated on the conservative figure -- all 36, exclusions included -- so the
// three contested labels in eval/intent_from_retrieval.json cannot lower the
// bar. Both numbers are printed.
//
// 0.75 rather than 0.80, and the reason is a measurement rather than a
// preference. Rewording ONE training example -- for a leakage-margin reason
// having nothing to do with this probe, and on a sentence about exit formalities
// -- moved this number from 0.8056 to 0.7778, by flipping an unrelated question
// about performance targets. At n=36 a single case is 2.8 points, and a linear
// model over shared embeddings has no locality: an edit anywhere moves the
// boundary everywhere.
//
// So the floor sits roughly two cases below the measured value. Higher would
// flake on edits that have nothing to do with routing, and a gate that fails for
// reasons unconnected to what it is guarding gets disabled. The probe is
// directional at this size, and it is reported as directional.
const ACTION_SAFETY_FLOOR = 0.75;

// THE EMBEDDING MODEL CHANGED, AND INTENT PAID FOR IT
//
// held_out_3 scored 0.9667 with all-MiniLM-L6-v2. It scores 0.9000 with
// bge-small-en-v1.5 -- two cases out of thirty. The swap was made for retrieval,
// where it was worth four cases out of eighteen on top-1, so one model serving
// both tasks is a net gain overall and a loss on this one.
//
// MiniLM could have been kept for intent alone. It was not, and the reason is
// procedural rather than technical: the intent model was chosen on the two sets
// that are not held out (the fitted set and the already-compromised held_out_2),
// where prefixed bge-small beat MiniLM on average, 0.8333 to 0.8021. Reversing
// that choice now, on the strength of the held_out_3 number, would consume the
// only clean set this classifier has -- the same mistake that burned held_out_1.
//
// So the number stands as measured, and the trade is recorded rather than
// optimised away. If intent accuracy becomes the priority, the honest route is a
// fourth held-out set written before anything is re-picked.

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
  ['held_out_4', 'held_out_intent_queries_4.json', 'CLEAN -- written before the rewrite'],
  ['held_out_5', 'held_out_intent_queries_5.json', 'CLEAN -- written before the action-safety fix'],
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
    + `min confidence: ${classifier.minConfidence}`);
  console.log('classifier: multinomial logistic regression   '
    + `iterations ${classifier.model.iterations}   `
    + `lr ${classifier.model.learningRate}   l2 ${classifier.model.l2}`);
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

  // -------------------------------------------------------------------------
  // Action safety: how often does a question become an action?
  // -------------------------------------------------------------------------
  const probe = loadJson(path.join(EVAL_DIR, 'intent_from_retrieval.json'));
  const excluded = new Set(probe.excluded.map((e) => e.q));
  const policyQuestions = loadJson(path.join(EVAL_DIR, 'policy_queries.json')).cases;

  const scoreProbe = (cases) => {
    const wrong = [];
    for (const c of cases) {
      const got = decideEmbedding(c.q).intent;
      if (got !== 'policyQuestion') wrong.push({ q: c.q, got });
    }
    return { n: cases.length, ok: cases.length - wrong.length, wrong };
  };

  const probeAll = scoreProbe(policyQuestions);
  const probeKept = scoreProbe(policyQuestions.filter((c) => !excluded.has(c.q)));
  const rulesProbe = policyQuestions
    .filter((c) => intent.routeByRules(c.q) === 'policyQuestion').length;

  console.log('');
  console.log('Action safety -- the 36 retrieval paraphrases are all policy questions.');
  console.log('         A misroute here is not a worse answer, it is the wrong action:');
  console.log('         applyLeave writes to a leave balance.');
  console.log(`  embedding, all 36            ${fmt(probeAll.ok / probeAll.n)}  `
    + `(${probeAll.ok}/${probeAll.n})   gated on this figure`);
  console.log(`  embedding, 33 undisputed     ${fmt(probeKept.ok / probeKept.n)}  `
    + `(${probeKept.ok}/${probeKept.n})   3 contested labels excluded`);
  console.log(`  rules, all 36                ${fmt(rulesProbe / probeAll.n)}  `
    + `(${rulesProbe}/${probeAll.n})   the baseline, and it is better at this`);

  if (verbose && probeAll.wrong.length) {
    console.log('');
    console.log('  questions routed to an action:');
    for (const w of probeAll.wrong) {
      const tag = excluded.has(w.q) ? ' [contested label]' : '';
      console.log(`      -> ${w.got.padEnd(13)} "${w.q}"${tag}`);
    }
  }

  console.log('');
  for (const set of ['held_out_3', 'held_out_4', 'held_out_5']) {
    console.log(`Method split on ${set} (embedding):`,
      JSON.stringify(results[`embedding ${set}`].methods));
  }

  if (verbose) {
    for (const key of ['rules held_out_3', 'embedding held_out_3',
      'rules held_out_4', 'embedding held_out_4',
      'rules held_out_5', 'embedding held_out_5']) {
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

  {
    const actual = probeAll.ok / probeAll.n;
    const ok = actual >= ACTION_SAFETY_FLOOR;
    console.log(`  gate action safety           floor ${fmt(ACTION_SAFETY_FLOOR)}  `
      + `actual ${fmt(actual)}  ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) {
      failures.push(
        `action safety ${fmt(actual)} < floor ${fmt(ACTION_SAFETY_FLOOR)} `
        + '-- policy questions are being routed to leave actions',
      );
    }
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
