'use strict';

/**
 * Verification of the ANSWER, not the retrieval.
 *
 * WHY THIS FILE EXISTS
 *
 * Every number in this repository up to now measured retrieval: did the right
 * policy come back, at what rank, under which scoring. Not one measured the
 * thing the employee actually reads. That is a real gap and it was the largest
 * one left, because the two failure modes are independent -- perfect retrieval
 * followed by a generated answer that states the wrong number is a worse outcome
 * than a miss, since a miss says "I could not find that" and a wrong number does
 * not announce itself.
 *
 * The gap was easy to miss because of how the default configuration works. With
 * no LLM configured -- the mode the README asks reviewers to use -- the answer is
 * the retrieved policy's own text, returned verbatim. Faithfulness in that mode
 * is not a metric, it is a structural property: the answer cannot contradict its
 * source because it IS its source. `npm run eval:answers` asserts that the
 * property still holds rather than pretending to measure it.
 *
 * The moment `LLM_PROVIDER` is set, that guarantee is gone. A model reads the top
 * five policies and writes prose, and nothing between it and the response checked
 * anything. This module is what goes in that gap.
 *
 * WHAT IS CHECKED HERE AND WHAT IS CHECKED IN THE EVAL
 *
 * Three of the four signals are exact string and table comparisons: no model, no
 * download, microseconds. Those run in the request path, on every generated
 * answer, and their verdict is returned to the caller and counted in /metrics.
 *
 * The fourth -- sentence-level NLI entailment against the retrieved context --
 * needs a 70MB cross-encoder and hundreds of milliseconds. That belongs in the
 * eval harness, not in front of a user waiting for a leave balance. Splitting
 * them on cost rather than on quality is deliberate and is the reason the
 * production guard is not the strongest available check; `scripts/eval_answers.js`
 * reports what the strongest one adds, so the size of that concession is a number
 * rather than an assumption.
 *
 * THE CHECK THAT MATTERS MOST IS THE DULLEST ONE
 *
 * `unsupportedNumbers` looks for numbers in the answer that do not appear in the
 * context. In an HR assistant that is the whole ballgame: 20 of the 26 policies
 * turn on a quantity, and an answer that says 5 casual days against a corpus
 * that grants 4 is wrong in a way an employee will act on. It also catches the
 * subtler version, which is why `entitlementConflicts` exists separately: a
 * number can be present in the context and still be attached to the wrong thing.
 * "You get 18 days of casual leave" quotes a real figure from the retrieved
 * context -- 18 is the combined annual/sick pool -- and is still false. A check
 * that only asked "is this number in the context" would pass it.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not decide whether an answer is good, and it cannot detect an omission.
 * An answer that drops the certificate requirement for sick leave over three days
 * is unfaithful by omission and every signal here passes it, because everything
 * it does say is true. That limit is measured rather than asserted: the mutation
 * suite in the eval includes a `dropped_condition` class, and the detection rate
 * for it is reported alongside the rest instead of being left out of the table.
 */

const { ENTITLEMENTS } = require('./leave_rules');

/**
 * Units that make a number a policy claim.
 *
 * A bare integer is not worth flagging -- section numbers, list markers and
 * "policy 16" would all trip it, and a check that fires constantly is a check
 * that gets switched off. A number carrying one of these units is asserting
 * something about an entitlement, a deadline or a rate.
 */
const UNIT_PATTERN = '%|percent|percentage|days?|working\\s+days?|calendar\\s+days?'
  + '|hours?|weeks?|months?|years?|minutes?|lakhs?|crores?|inr|rs\\.?';

/**
 * Modifiers allowed to sit between the number and its unit.
 *
 * Found by the gate, not by inspection. The first version required the unit to
 * follow the number directly and silently missed three quantities, every one of
 * them load-bearing: the 2-consecutive-day cap on casual leave, the 3-day
 * threshold for a medical certificate, and the 3-day absence that counts as job
 * abandonment. An answer could have changed any of them to any value and no
 * check would have noticed.
 *
 * The list is closed rather than a wildcard on purpose. Allowing any words here
 * makes `3+ late entries/month` and `9:00 AM - 6:00 PM` parse as quantities, and
 * a false quantity is worse than a missed one: it flags true policy text, which
 * is the one failure the control gate forbids outright.
 */
const MODIFIERS = 'consecutive|working|business|calendar|full|half|additional|clear';

const NUMBER_WITH_UNIT = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(?:(?:${MODIFIERS})\\s+)?(${UNIT_PATTERN})`, 'gi',
);

/** Currency written before the amount, which the pattern above reads backwards. */
const CURRENCY_FIRST = /(?:inr|rs\.?|₹)\s*(\d+(?:[.,]\d+)?)/gi;

/**
 * Fold a unit to a comparison key.
 *
 * Singular and plural are the same claim, "9 hours" and "9 hour" must not count
 * as a mismatch, and the corpus genuinely contains both -- policy_007 says
 * "90 day" where every other policy says "days". Without this, that one typo
 * would make a faithful answer quoting it look unfaithful.
 */
function normaliseUnit(unit) {
  const u = String(unit).toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (u === 'percent' || u === 'percentage' || u === '%') return '%';
  if (u === 'rs' || u === 'inr' || u === '₹') return 'inr';
  if (u === 'working day' || u === 'working days') return 'day';
  if (u === 'calendar day' || u === 'calendar days') return 'day';
  return u.endsWith('s') ? u.slice(0, -1) : u;
}

/** Every quantity a piece of text asserts, as `{ value, unit, text }`. */
function quantities(text) {
  const out = [];
  const source = String(text || '');

  for (const match of source.matchAll(NUMBER_WITH_UNIT)) {
    out.push({
      value: Number(match[1]),
      unit: normaliseUnit(match[2]),
      text: match[0].trim(),
    });
  }
  for (const match of source.matchAll(CURRENCY_FIRST)) {
    out.push({
      value: Number(String(match[1]).replace(/,/g, '')),
      unit: 'inr',
      text: match[0].trim(),
    });
  }

  return out;
}

function quantityKey(q) {
  return `${q.value}|${q.unit}`;
}

/**
 * Numbers the answer asserts that the context does not support.
 *
 * Deliberately compares against the context as a whole rather than per-document.
 * The context is five policies and a correct answer may legitimately combine
 * two of them -- the entitlement from one, the notice period from another. Being
 * stricter than that would flag correct synthesis, and synthesis across retrieved
 * documents is the one thing generation adds over returning the top hit.
 */
function unsupportedNumbers(answer, context) {
  const supported = new Set(quantities(context).map(quantityKey));
  const seen = new Set();
  const out = [];

  for (const q of quantities(answer)) {
    const key = quantityKey(q);
    if (supported.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }

  return out;
}

/**
 * Leave-type words, mapped to the entitlement pool they draw from.
 *
 * Same mapping the leave engine uses, restated here as text patterns because
 * this side has to recognise the phrase in prose rather than in a typed field.
 */
const POOL_PHRASES = [
  { pool: 'casual_leave', pattern: /casual\s+leave|\bcl\b/i },
  {
    pool: 'combined_annual_sick_leave',
    pattern: /(?:annual|earned|sick|combined)\s+(?:\/\s*\w+\s*)*leave|\bel\b|\bsl\b/i,
  },
];

/**
 * Answers that attach a real number to the wrong entitlement.
 *
 * The failure this catches is specific and is the reason `unsupportedNumbers` is
 * not sufficient on its own. Both entitlement figures -- 4 and 18 -- are almost
 * always in the retrieved context together, because the leave policies are a
 * near-duplicate family and dense retrieval pulls the whole family. So a model
 * that says "18 days of casual leave" is quoting the context accurately and
 * still telling an employee something that will be refused when they file it.
 *
 * Scoped to one sentence at a time. Across a whole answer both leave types and
 * both numbers co-occur constantly and any pairing would look plausible.
 */
function entitlementConflicts(answer) {
  const out = [];
  const sentences = splitSentences(answer);

  for (const sentence of sentences) {
    const pools = POOL_PHRASES.filter((p) => p.pattern.test(sentence));
    // Two leave types in one sentence gives no basis for binding a number to
    // either. Reporting a conflict there would be a guess.
    if (pools.length !== 1) continue;

    const { pool } = pools[0];
    const expected = ENTITLEMENTS[pool];
    if (!expected) continue;

    for (const q of quantities(sentence)) {
      if (q.unit !== 'day') continue;
      // Only flag a number that reads as a total entitlement. A notice period or
      // a maximum consecutive span is also a day count and is not this claim.
      if (!/per\s+year|a\s+year|annually|entitle|total|get|granted|allowed|balance/i
        .test(sentence)) continue;
      if (q.value === expected.days) continue;
      if (q.value === expected.maxConsecutive) continue;
      if (q.value === expected.certificateAfterDays) continue;
      out.push({
        pool,
        claimed: q.value,
        authoritative: expected.days,
        sentence: sentence.trim(),
        policyId: expected.policyId,
      });
    }
  }

  return out;
}

/**
 * Sources the answer names that were not retrieved.
 *
 * The prompt tells the model to cite, so it will, and a cited source that was
 * never in the context is a fabricated citation -- the failure mode that makes a
 * wrong answer look verified. Matching is on the source string the corpus uses,
 * since that is what the context puts in front of the model.
 */
function fabricatedCitations(answer, sources) {
  const text = String(answer || '');
  const retrieved = new Set((sources || []).map((s) => String(s).toLowerCase()));
  const out = [];

  // A citation here looks like "Corporate Code of Conduct, Section 1.0" -- a
  // title followed by a section reference. Anything shaped like that which is not
  // in the retrieved set is unsupported.
  for (const match of text.matchAll(/([A-Z][A-Za-z&/\- ]{6,60}?,\s*Section\s*[\d.]+)/g)) {
    const claim = match[1].trim();
    if (retrieved.has(claim.toLowerCase())) continue;
    if (out.some((c) => c.claim === claim)) continue;
    out.push({ claim });
  }

  return out;
}

/**
 * Sentence split.
 *
 * The corpus writes "Objective: ... Scope: ... Detailed Policy: ..." as one
 * run of sentences with colons and abbreviations inside, so this splits on
 * terminal punctuation followed by a capital and additionally on the labelled
 * segments, which behave as sentences for entailment purposes.
 */
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z(])|(?<=\.)\s*(?=(?:Objective|Scope|Detailed Policy|Note|Eligibility|Procedure|Exclusions?)\s*:)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

/**
 * The request-path guard: the three checks that cost nothing.
 *
 * Returns a verdict rather than throwing, and the caller decides. Refusing to
 * return an answer because a number looked unsupported would turn a false
 * positive here into an outage, and this is a heuristic, not a proof. What it is
 * allowed to do is tell the truth about what it found, in the response and in
 * /metrics, so an unfaithful answer leaves a trace instead of passing silently.
 */
function verify(answer, { context = '', sources = [] } = {}) {
  const numbers = unsupportedNumbers(answer, context);
  const entitlements = entitlementConflicts(answer);
  const citations = fabricatedCitations(answer, sources);

  const findings = [
    ...numbers.map((n) => ({ check: 'unsupported_number', detail: n.text })),
    ...entitlements.map((e) => ({
      check: 'entitlement_conflict',
      detail: `${e.claimed} days claimed for ${e.pool}; ${e.policyId} says ${e.authoritative}`,
    })),
    ...citations.map((c) => ({ check: 'fabricated_citation', detail: c.claim })),
  ];

  return {
    grounded: findings.length === 0,
    findings,
    // Verbatim extraction is the default path and is unfalsifiable by
    // construction. Reporting it as a separate fact keeps the two modes from
    // being averaged together, which would let the easy one carry the hard one.
    verbatim: Boolean(answer) && String(context).includes(String(answer).trim()),
  };
}

module.exports = {
  UNIT_PATTERN,
  quantities,
  normaliseUnit,
  unsupportedNumbers,
  entitlementConflicts,
  fabricatedCitations,
  splitSentences,
  verify,
};
