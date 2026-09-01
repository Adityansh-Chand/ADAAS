'use strict';

/**
 * Intent classification: which of the three things is this message?
 *
 * Two implementations live here so they can be compared on identical sets:
 *
 *   rules       the ported rule-based router, measured at 0.4583 on held-out
 *               phrasing after two rounds of vocabulary work
 *   embedding   k-nearest-neighbour over MiniLM sentence embeddings of the
 *               labelled examples in eval/intent_training.json
 *
 * This used to live in the Flutter client. It moved for the same reason the
 * client-side retriever was deleted: all three intents require the backend, so a
 * client-side router was pure duplication, and two copies of a decision inevitably
 * disagree. There is now one implementation, and `npm run eval:intent` scores it.
 *
 * The rules are kept rather than deleted. They are the baseline the classifier has
 * to beat, and a comparison with no baseline is not a comparison.
 */

const INTENTS = ['leaveBalance', 'applyLeave', 'policyQuestion'];

// ---------------------------------------------------------------------------
// Rules (ported verbatim in behaviour from lib/services/intent_router.dart)
//
// Ordering is the design: a message carrying an unambiguous filing verb is a
// request to file; failing that, one asking how much is left is a balance query;
// failing that, an interrogative about the rules is a policy question -- which is
// what rescues "Can I take maternity leave?", because asking whether you may do a
// thing is not doing it.
// ---------------------------------------------------------------------------

const FILING_VERBS = [
  'apply', 'submit', 'file', 'book', 'raise', 'put in', 'put me down',
  'sign me off', 'sign me out', 'mark me', 'leave application',
];

const BALANCE_STRONG = [
  'leave balance', 'balance', 'leave count', 'leave status', 'leave summary',
];

const REMAINDER_MARKERS = [
  'remaining', 'left', 'usage', 'used', 'still have', 'got left', 'so far',
];

const BARE_QUANTITY = ['how many', 'how much'];

const COUNTABLE_NOUNS = [
  'leave', 'leaves', 'day', 'days', 'holiday', 'holidays',
  'casual', 'annual', 'sick',
];

const POLICY_INTERROGATIVES = [
  'what is', 'what are', 'what happens', 'whats the', 'what s the', 'how much',
  'how long', 'how do i', 'how does', 'is there', 'am i allowed', 'can i',
  'could i', 'may i', 'do i need', 'do we', 'does', 'who', 'when is', 'why',
  'explain', 'tell me about', 'remind me',
];

const SOFT_APPLY_VERBS = [
  'take', 'taking', 'need', 'want', 'go on', 'going on', 'request',
  'requesting', 'would like',
];

const LEAVE_NOUNS = [
  'leave', 'day off', 'days off', 'time off', 'holiday', 'half day', 'vacation',
];

const ABSENCE_PHRASES = [
  'will not come in', 'wont come in', 'will not be in', 'wont be in',
  'not coming in', 'will be out', 'be away', 'be out', 'away on', 'stay home',
  'staying home', 'work from home today', 'absent', 'off sick', 'out of office',
];

const AUXILIARIES = ['is ', 'are ', 'do ', 'can ', 'will ', 'was ', 'has ', 'should ', 'must '];

const FIRST_PERSON = ['i', 'me', 'my', 'mine', 'im', 'ive', 'id'];

function normalise(input) {
  return String(input)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim();
}

function stemWord(word) {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

function stemAll(normalised) {
  if (!normalised) return '';
  return normalised.split(' ').map(stemWord).join(' ');
}

/**
 * Whole-phrase containment. The guard the original router lacked: plain substring
 * matching let the corpus's two-letter keywords fire inside unrelated words, so
 * `cl` matched `clients` and `el` matched `help` and `travel`.
 */
function containsAny(padded, stemmed, needles) {
  for (const needle of needles) {
    const n = normalise(needle);
    if (!n) continue;
    if (padded.includes(` ${n} `)) return true;
    if (stemmed.includes(` ${stemAll(n)} `)) return true;
  }
  return false;
}

function isFirstPerson(padded) {
  return FIRST_PERSON.some((p) => padded.includes(` ${p} `));
}

function isBalanceQuery(padded, stemmed) {
  if (!isFirstPerson(padded)) return false;
  if (containsAny(padded, stemmed, REMAINDER_MARKERS)
      && containsAny(padded, stemmed, LEAVE_NOUNS)) {
    return true;
  }
  for (const opener of BARE_QUANTITY) {
    for (const noun of COUNTABLE_NOUNS) {
      if (padded.includes(` ${opener} ${noun} `)) return true;
    }
  }
  return false;
}

function routeByRules(input) {
  const normalised = normalise(input);
  const padded = ` ${normalised} `;
  const stemmed = ` ${stemAll(normalised)} `;

  if (containsAny(padded, stemmed, FILING_VERBS)) return 'applyLeave';
  if (containsAny(padded, stemmed, BALANCE_STRONG)) return 'leaveBalance';
  if (isBalanceQuery(padded, stemmed)) return 'leaveBalance';
  if (containsAny(padded, stemmed, POLICY_INTERROGATIVES)
      || containsAny(padded, stemmed, ['policy', 'process'])
      || AUXILIARIES.some((a) => normalised.startsWith(a))) {
    return 'policyQuestion';
  }
  if (containsAny(padded, stemmed, ABSENCE_PHRASES)) return 'applyLeave';
  if (containsAny(padded, stemmed, SOFT_APPLY_VERBS)
      && containsAny(padded, stemmed, LEAVE_NOUNS)) {
    return 'applyLeave';
  }
  return 'policyQuestion';
}

// ---------------------------------------------------------------------------
// Embedding classifier
//
// WHY THIS IS NO LONGER k-NEAREST-NEIGHBOUR
//
// It was, at k=5 with similarity-weighted votes, and that rule was never
// compared against anything -- it was the first thing written and it stayed.
// `npm run bakeoff:intent` compared it against twelve alternatives on the three
// sets that are not held out, and it came last but one:
//
//   k-NN k=5, weight s^1 (incumbent)     LOO 0.8898  queries 0.6458  held1 0.7500
//   k-NN k=11, weight s^8                LOO 0.8983  queries 0.7292  held1 0.7917
//   nearest centroid                     LOO 0.9237  queries 0.7917  held1 0.9167
//   logistic regression, l2=1e-2         LOO 0.9322  queries 0.8750  held1 0.9167
//
// The reason is structural rather than a matter of tuning. k-NN decides using
// only the distances to k training points, and bge-small puts every sentence in
// this domain into a narrow high cosine band -- so the 5th neighbour is nearly
// as loud as the 1st, and a handful of leave-shaped phrasings in the wrong class
// can outvote the right one. Sharpening the weights (s^8, s^16) recovers some of
// that, which is the evidence for the diagnosis, but it does not fix it.
//
// A linear model uses all 384 dimensions at once, and it is fitted rather than
// looked up: with three classes and ~118 examples it has enough data to find
// which directions in the embedding space separate "how many are left" from
// "book me the 14th", instead of hoping a near neighbour exists.
//
// The comparison also settled two things worth recording because they are not
// what one would guess. The nearest-centroid rule -- three vectors, no
// hyperparameters -- beats every k-NN variant. And the 54 training examples
// added at the same time did NOT cause the improvement: they cost the incumbent
// 0.0625 on intent_queries and were roughly neutral for the linear model
// (-0.0208 there, +0.0417 on held_out_1). The gain is the classifier, not the
// data, and the data was kept for coverage rather than for its score.
// ---------------------------------------------------------------------------

// Full-batch gradient descent from a zero initialisation. No seed, because there
// is no randomness: the same examples in the same order always produce the same
// weights, which is what makes the reported accuracy reproducible without
// committing a fitted artefact.
//
// 300 iterations at lr 4 is where the loss has flattened; the bakeoff measured
// 900 iterations as identical to 300 on all three dev sets. L2 1e-2 was selected
// there too, and it matters: 384 features over 118 examples is heavily
// over-parameterised, and at l2=1e-1 the model underfits hard (mean 0.6151),
// while 1e-4 through 3e-2 are all within 0.013 of each other. A hyperparameter
// that flat across two orders of magnitude is one to state and stop tuning.
const DEFAULT_ITERATIONS = 300;
const DEFAULT_LEARNING_RATE = 4;
const DEFAULT_L2 = 1e-2;

// Below this the classifier declines and the caller falls back to the rules.
//
// Recalibrated, because the old 0.18 was on a scale that no longer exists: it
// applied to a k-NN vote share times a similarity, and this is a softmax
// probability times a similarity. Carrying the number across would have been
// arithmetic without meaning.
//
// WHAT THE CALIBRATION MEASURED, AND WHAT IT RULED OUT
//
// `npm run bakeoff:intent` scores the confidence of every dev query and of all 24
// out-of-scope probes -- the nearest thing this project has to input that is
// neither a leave request nor an answerable HR question:
//
//   in-domain, n=72      min 0.2324   median 0.4177   max 0.6566
//   out-of-scope, n=24   min 0.1661   median 0.2798   max 0.4562
//
// Those ranges overlap across most of their span, so this threshold cannot be an
// out-of-domain detector, and it is not set up as one. Two-thirds of the
// out-of-scope probes score above the weakest genuine query.
//
// That is a smaller problem than it looks, because routing is not where scope is
// decided. A question about Kubernetes routed to policyQuestion then hits
// retrieval, where the cosine and cross-encoder floors reject it -- so the
// consequence of a misroute here is an abstention there, not a wrong answer.
// Meanwhile declining is genuinely expensive: the fallback is the rules, at
// 0.5667 against the classifier's much higher figure, so a floor tuned to catch
// out-of-scope input would trade real accuracy for a job another layer already
// does.
//
// 0.10 sits below everything measured, in-domain or out. It is a guard against
// degenerate input -- a zero or near-orthogonal vector, an embedding failure
// returning something meaningless -- and it is documented as that rather than
// dressed up as a confidence gate that works.
const DEFAULT_MIN_CONFIDENCE = 0.10;

// ASYMMETRY: an action needs more evidence than an answer.
//
// The two mistakes this classifier can make do not cost the same. Calling a
// leave request a policy question produces a worse answer, and the employee asks
// again. Calling a policy question a leave request makes the service *do*
// something -- applyLeave writes to a real leave balance, leaveBalance returns
// someone's figures. A screenshot caught the first kind of that failure: asked
// whether they could work from home a few days a week, the app filed five days of
// casual leave.
//
// Treating those as equally bad is a choice, and it was made by default rather
// than deliberately, because softmax argmax has no notion of what a label costs.
// So the argmax stands for policyQuestion and has to clear a margin for an
// action: the winning action class must beat policyQuestion's probability by
// this much, or the message is answered instead of acted on.
//
// Calibrated on dev by `npm run bakeoff:margin`, which sweeps it and prints what
// each value costs on the leave intents -- because this trade is real, and the
// tempting number is the wrong one. The sweep, dev only:
//
//   margin   policy questions kept   leave intents kept   dev accuracy
//   0        28/36  0.7778           45/45  1.0000        0.9306
//   0.10     31/36  0.8611           45/45  1.0000        0.9861
//   0.20     31/36  0.8611           41/45  0.9111        0.9306
//   0.45     35/36  0.9722           18/45  0.4000        0.6250
//
// 0.10 is not a compromise between the two columns, it dominates: three more
// policy questions answered instead of acted on, no genuine leave request lost,
// and the best overall dev accuracy of any value tried. Above it the trade turns
// sharply -- at 0.45 the app keeps nearly every question but files fewer than half
// the leave requests it is asked to file, which is a worse product and would have
// looked like a win against action safety alone.
//
// Zero reproduces the previous behaviour exactly and is in the sweep so the
// baseline is visible rather than assumed.
const DEFAULT_ACTION_MARGIN = 0.10;

const ACTION_INTENTS = new Set(['applyLeave', 'leaveBalance']);

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Fit multinomial logistic regression on embedding vectors.
 *
 * Exported so scripts/bakeoff_intent.js selects hyperparameters using the exact
 * code that serves requests. A bakeoff with its own copy of the model measures
 * its own copy.
 *
 * Returns `{ predict }`, where `predict(vector)` gives the label and the full
 * softmax distribution over INTENTS.
 */
function fitLogisticRegression(examples, options = {}) {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const learningRate = options.learningRate ?? DEFAULT_LEARNING_RATE;
  const l2 = options.l2 ?? DEFAULT_L2;

  const dimensions = examples.length ? examples[0].vector.length : 0;
  const weights = INTENTS.map(() => new Array(dimensions).fill(0));
  const bias = new Array(INTENTS.length).fill(0);
  const target = examples.map((e) => INTENTS.indexOf(e.label));

  const scores = (vector) => {
    const out = new Array(INTENTS.length);
    for (let c = 0; c < INTENTS.length; c += 1) {
      let s = bias[c];
      const w = weights[c];
      for (let i = 0; i < dimensions; i += 1) s += w[i] * vector[i];
      out[c] = s;
    }
    return out;
  };

  const softmax = (logits) => {
    const max = Math.max(...logits);
    const exp = logits.map((z) => Math.exp(z - max));
    const sum = exp.reduce((acc, z) => acc + z, 0);
    return exp.map((z) => z / sum);
  };

  for (let it = 0; it < iterations && examples.length > 0; it += 1) {
    const gradW = INTENTS.map(() => new Array(dimensions).fill(0));
    const gradB = new Array(INTENTS.length).fill(0);

    for (let n = 0; n < examples.length; n += 1) {
      const x = examples[n].vector;
      const probabilities = softmax(scores(x));
      for (let c = 0; c < INTENTS.length; c += 1) {
        const error = probabilities[c] - (target[n] === c ? 1 : 0);
        gradB[c] += error;
        const g = gradW[c];
        for (let i = 0; i < dimensions; i += 1) g[i] += error * x[i];
      }
    }

    for (let c = 0; c < INTENTS.length; c += 1) {
      bias[c] -= learningRate * (gradB[c] / examples.length);
      const w = weights[c];
      const g = gradW[c];
      for (let i = 0; i < dimensions; i += 1) {
        // L2 on the weights only. Penalising the bias would pull the decision
        // towards a uniform prior over three classes for no reason -- the class
        // balance here is 38/39/41 and the bias has nothing to overfit.
        w[i] -= learningRate * ((g[i] / examples.length) + l2 * w[i]);
      }
    }
  }

  return {
    iterations,
    learningRate,
    l2,
    predict(vector) {
      const probabilities = softmax(scores(vector));
      let best = 0;
      for (let c = 1; c < INTENTS.length; c += 1) {
        if (probabilities[c] > probabilities[best]) best = c;
      }
      return {
        label: INTENTS[best],
        probability: probabilities[best],
        probabilities: Object.fromEntries(
          INTENTS.map((l, i) => [l, probabilities[i]]),
        ),
      };
    },
  };
}

/**
 * Build a classifier from labelled examples and their vectors.
 *
 * `vectors` maps example text -> embedding. Examples with no vector are collected
 * in `missing` rather than skipped silently, because a partially-embedded
 * training set would quietly degrade the model and still look fitted.
 */
function buildClassifier(trainingCases, vectors, options = {}) {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const actionMargin = options.actionMargin ?? DEFAULT_ACTION_MARGIN;

  const examples = [];
  const missing = [];
  for (const c of trainingCases) {
    const vector = vectors[c.q];
    if (!vector) { missing.push(c.q); continue; }
    examples.push({ label: c.label, vector });
  }

  return {
    minConfidence,
    actionMargin,
    examples,
    missing,
    model: examples.length ? fitLogisticRegression(examples, options) : null,
  };
}

/**
 * Classify a query vector.
 *
 * Returns `{ intent, confidence, probabilities }`, with `intent: null` when
 * confidence is below the floor.
 *
 * Confidence is the winning class's softmax probability multiplied by the query's
 * similarity to its nearest training example. Both factors are load-bearing and
 * measure different failures:
 *
 *   the probability      how cleanly the three classes separate for this input.
 *                        Low when a message is genuinely ambiguous ("do I have
 *                        enough left to take next Friday" is both a balance
 *                        question and nearly a request).
 *
 *   the top similarity   whether the input resembles the training distribution
 *                        at all. A linear model extrapolates confidently outside
 *                        its data -- softmax alone will happily report 0.97 for
 *                        a sentence about Kubernetes -- so probability by itself
 *                        cannot detect out-of-domain input, and this is the term
 *                        that can.
 *
 * The product, not either alone: a confident prediction about something unlike
 * anything in training is exactly the case worth refusing.
 */
function classify(classifier, queryVector) {
  if (!queryVector || !classifier.model || classifier.examples.length === 0) {
    return { intent: null, confidence: 0, probabilities: {} };
  }

  const prediction = classifier.model.predict(queryVector);

  // The asymmetric step. An action must out-score answering by the margin; below
  // it the message is answered instead, which is the recoverable mistake.
  // `demoted` is reported rather than hidden, so a caller and the metrics can see
  // how often this fires -- a guard that silently changes decisions is a guard
  // nobody can audit.
  const margin = classifier.actionMargin ?? DEFAULT_ACTION_MARGIN;
  let label = prediction.label;
  let demoted = false;
  if (ACTION_INTENTS.has(label) && margin > 0) {
    const gap = prediction.probabilities[label]
      - (prediction.probabilities.policyQuestion || 0);
    if (gap < margin) {
      label = 'policyQuestion';
      demoted = true;
    }
  }

  let topSimilarity = -1;
  for (const e of classifier.examples) {
    const similarity = cosine(queryVector, e.vector);
    if (similarity > topSimilarity) topSimilarity = similarity;
  }

  // Confidence reports the class actually chosen, not the argmax it replaced --
  // a confidence attached to a label the service did not use would be a number
  // about nothing.
  const chosenProbability = prediction.probabilities[label];
  const confidence = chosenProbability * Math.max(0, topSimilarity);

  return {
    intent: confidence >= classifier.minConfidence ? label : null,
    candidate: label,
    argmax: prediction.label,
    demotedToAnswer: demoted,
    confidence,
    probability: chosenProbability,
    probabilities: prediction.probabilities,
    topSimilarity,
  };
}

/**
 * The routing decision actually used by the service.
 *
 * Classifier first, rules as the fallback when it declines. Reports which one
 * decided, so a caller is never guessing and the split is visible in metrics.
 */
function route(input, classifier, queryVector) {
  if (classifier && queryVector) {
    const result = classify(classifier, queryVector);
    if (result.intent) {
      return {
        intent: result.intent,
        method: 'embedding',
        confidence: Number(result.confidence.toFixed(4)),
      };
    }
    return {
      intent: routeByRules(input),
      method: 'rules_fallback',
      confidence: Number(result.confidence.toFixed(4)),
    };
  }
  return { intent: routeByRules(input), method: 'rules', confidence: null };
}

module.exports = {
  INTENTS,
  DEFAULT_ITERATIONS,
  DEFAULT_LEARNING_RATE,
  DEFAULT_L2,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_ACTION_MARGIN,
  ACTION_INTENTS,
  normalise,
  stemAll,
  routeByRules,
  fitLogisticRegression,
  buildClassifier,
  classify,
  route,
};
