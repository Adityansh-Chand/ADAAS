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
// ---------------------------------------------------------------------------

// Neighbours considered. Odd, so a two-way tie cannot happen; small, because the
// training set is ~64 examples and a large k would wash out the minority classes.
const DEFAULT_K = 5;

// Below this the classifier declines and the caller falls back to the rules.
// A message unlike anything in training should not be forced into a class on the
// strength of a weak nearest neighbour.
const DEFAULT_MIN_CONFIDENCE = 0.18;

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Build a classifier from labelled examples and their vectors.
 *
 * `vectors` maps example text -> embedding. Examples with no vector are skipped
 * loudly rather than silently, because a partially-embedded training set would
 * quietly degrade the classifier.
 */
function buildClassifier(trainingCases, vectors, options = {}) {
  const k = options.k || DEFAULT_K;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  const examples = [];
  const missing = [];
  for (const c of trainingCases) {
    const vector = vectors[c.q];
    if (!vector) { missing.push(c.q); continue; }
    examples.push({ label: c.label, vector });
  }

  return { k, minConfidence, examples, missing };
}

/**
 * Classify a query vector.
 *
 * Returns `{ intent, confidence, votes }`, or `intent: null` when confidence is
 * below the floor. Confidence is the similarity-weighted vote share of the
 * winning label among the k nearest neighbours, scaled by the best similarity --
 * so a query that is only weakly like anything in training scores low even when
 * its neighbours agree.
 */
function classify(classifier, queryVector) {
  if (!queryVector || classifier.examples.length === 0) {
    return { intent: null, confidence: 0, votes: {} };
  }

  const scored = classifier.examples
    .map((e) => ({ label: e.label, similarity: cosine(queryVector, e.vector) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, classifier.k);

  const votes = {};
  let total = 0;
  for (const { label, similarity } of scored) {
    const weight = Math.max(0, similarity);
    votes[label] = (votes[label] || 0) + weight;
    total += weight;
  }

  let best = null;
  let bestWeight = -1;
  for (const label of INTENTS) {
    const weight = votes[label] || 0;
    if (weight > bestWeight) { best = label; bestWeight = weight; }
  }

  const share = total > 0 ? bestWeight / total : 0;
  const topSimilarity = scored[0].similarity;
  const confidence = share * Math.max(0, topSimilarity);

  return {
    intent: confidence >= classifier.minConfidence ? best : null,
    candidate: best,
    confidence,
    share,
    topSimilarity,
    votes,
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
  DEFAULT_K,
  DEFAULT_MIN_CONFIDENCE,
  normalise,
  stemAll,
  routeByRules,
  buildClassifier,
  classify,
  route,
};
