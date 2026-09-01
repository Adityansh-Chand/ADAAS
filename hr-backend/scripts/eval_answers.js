'use strict';

/**
 * Scores the ANSWER layer.
 *
 *   npm run eval:answers          all stages, with the misses listed
 *   npm run eval:answers:gate     the same, exiting non-zero if a gate trips
 *   npm run eval:answers -- --nli additionally run the entailment stage (needs a model)
 *
 * WHAT WAS MISSING, PRECISELY
 *
 * Thirteen retrieval gates and seven intent gates measured which document came
 * back. Nothing measured what the employee reads. The two are not the same
 * question and the second one is worse when it fails: a retrieval miss says "I
 * could not find a matching policy", which is honest and actionable, while a
 * generated answer with the wrong number says nothing about being wrong and gets
 * acted on.
 *
 * The gap survived this long because of an accident of the default configuration.
 * With `LLM_PROVIDER` unset the answer is the top policy's own text, returned
 * verbatim, so it cannot contradict its source -- and that is the mode every
 * reported number in this repository was produced in. Stage 1 asserts that
 * property instead of measuring it, because measuring an identity gives a
 * meaningless 1.0000 and a reader who saw it would reasonably conclude the
 * generative path had been checked. It has not been. Stage 4 says so out loud.
 *
 * WHY A MUTATION SUITE RATHER THAN A SET OF JUDGED ANSWERS
 *
 * The honest way to score faithfulness is to collect real generations and have a
 * human grade them. That is not available here: it needs an API key the
 * repository refuses to depend on for reported numbers, and it needs an annotator
 * who is not the author, which is the same unresolvable problem already recorded
 * against the graded relevance judgements.
 *
 * What IS available is the inverse experiment. Instead of asking "how faithful
 * are our answers", which needs generations, ask "can this check detect an
 * unfaithful answer", which needs only unfaithful answers -- and those can be
 * built from the corpus deterministically, in known classes, with a known ground
 * truth. That answers a narrower question completely rather than the broad one
 * badly, and it is the question that actually gates the guard shipping in front
 * of users.
 *
 * The direction of the claim changes accordingly, and the report states it in
 * those terms: this measures the SENSITIVITY of the verifier, not the
 * faithfulness of the system. A reader must not be able to come away thinking the
 * second was established.
 *
 * THE FALSE-POSITIVE RATE IS THE GATE THAT MATTERS
 *
 * A verifier that flags everything detects every mutation. The 26 unmutated
 * corpus answers are scored as a control and any finding against them is a
 * failure, because the guard runs on real traffic and a check that fires on true
 * text is a check that gets switched off within a week.
 */

const fs = require('fs');
const path = require('path');

const answers = require('../answers');
const { ENTITLEMENTS } = require('../leave_rules');
const dense = require('../dense');
const rerankModule = require('../rerank');
const embeddings = require('../embeddings');
const llm = require('../llm');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const EVAL_DIR = path.join(ROOT, 'eval');

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(4) : 'n/a');
const pct = (n, d) => (d === 0 ? 'n/a' : `${n}/${d} = ${fmt(n / d)}`);

/**
 * PREDICTIONS: what each detection rate was declared to be, before measuring.
 *
 * Kept separate from the regression floors below, because the two were conflated
 * in the first version of this file and that conflation is a trap. A number
 * written down as a prediction and then quietly edited to match the measurement
 * is worthless; a number that gates CI has to sit at or below what the code
 * actually does or the build is red forever. Those are different jobs and the
 * same field cannot do both honestly.
 *
 * So predictions are frozen. Where one was wrong, `outcome` records that it was
 * wrong and why, and the wrong number stays visible. That record is the useful
 * artefact -- it is the only thing here that distinguishes a designed check from
 * a check reverse-engineered out of whatever the code happened to detect.
 */
const PREDICTIONS = {
  changed_number: {
    predicted: 0.90,
    why: 'the failure an employee acts on, and the number is absent from the corpus',
  },
  swapped_number: {
    predicted: 0.60,
    why: 'expected the entitlement binding to catch most of them',
    outcome: 'WRONG. Measured 0.2737. The prediction assumed a swapped number '
      + 'would usually land on a different leave pool, where the authoritative '
      + 'table could catch it. Mostly it does not: the corpus states its '
      + 'entitlements as a bare "Entitlement: N days per year" with the leave '
      + 'type named in the document title rather than in the sentence, so there '
      + 'is nothing inside the sentence to bind the number to. And the swap '
      + 'target is by construction a real corpus figure, so it is present in the '
      + 'context and the unsupported-number check cannot see it either. The 27% '
      + 'that are caught are the cases where the swap happened to land inside a '
      + 'sentence that does name a leave type. Catching the rest needs a fact '
      + 'bound to the document that asserts it, which means reading; stage 3 '
      + 'measures what a model-based check recovers. Two earlier numbers for '
      + 'this class are worth recording because of what they exposed: 0.3077, '
      + 'then 0.0000 after an unrelated widening of the quantity extractor. No '
      + 'check changed between those two runs. The generator had been picking '
      + 'one swap target per document by Set iteration order, so adding six '
      + 'figures to the corpus pool silently changed the test. A rate that moves '
      + '30 points on an edit to something else is not measuring the detector, '
      + 'and the fix -- enumerate every same-unit alternative -- is why the '
      + 'suite is now 150 mutations rather than 56.',
  },
  entitlement_swap: {
    predicted: 0.80,
    why: 'the authoritative table is right there and the sentence names the leave type',
  },
  fabricated_citation: {
    predicted: 0.90,
    why: 'a fake citation makes a wrong answer look checked',
  },
  negated_requirement: {
    predicted: 0.0,
    why: 'no exact check reads meaning; declared undetectable in advance',
  },
  imported_clause: {
    predicted: 0.0,
    why: 'every word is real corpus text, just from the wrong policy',
  },
  dropped_condition: {
    predicted: 0.0,
    why: 'omission: everything the answer says is true',
  },
};

/**
 * FLOORS: what CI enforces.
 *
 * Set at the measured value, which is the only defensible place for a regression
 * floor -- an earlier round of this project set a gate above the number it was
 * gating and the build could never have gone green. A floor below the prediction
 * is not the prediction being revised; both are printed side by side and the gap
 * is the finding.
 *
 * The control is the exception and is an absolute, not a floor: any finding
 * against unmutated corpus text fails, at any time, because a guard that flags
 * true policy text is one nobody will leave switched on.
 */
const FLOORS = {
  false_positives: { max: 0, why: 'a guard that flags true policy text is unusable' },
  changed_number: { min: 1.0 },
  swapped_number: { min: 0.0, why: 'invisible to exact checks; see the prediction outcome' },
  entitlement_swap: { min: 1.0 },
  fabricated_citation: { min: 1.0 },
  negated_requirement: { min: 0.0, why: 'declared undetectable, and is' },
  imported_clause: { min: 0.0, why: 'declared undetectable, and is' },
  dropped_condition: { min: 0.0, why: 'declared undetectable, and is' },
};

// ---------------------------------------------------------------------------
// The mutation suite
// ---------------------------------------------------------------------------

/**
 * Deterministic corruptions of real corpus answers.
 *
 * Generated from the corpus at run time rather than stored, so they cannot drift
 * out of step with the policy text the way a checked-in fixture would. The
 * written copy in eval/answer_mutations.json is a record for review, not the
 * input.
 *
 * Seven classes, chosen because each defeats a different check. Three of them are
 * expected to defeat every exact check this repository has, and they are included
 * for exactly that reason: a suite made only of catchable mutations reports a
 * detection rate that means nothing.
 */
function buildMutations(kb) {
  const byId = new Map(kb.map((e) => [e.id, e]));
  const out = [];
  const push = (m) => out.push({ id: `m${String(out.length + 1).padStart(3, '0')}`, ...m });

  // Which numbers exist anywhere in the corpus, so `changed_number` can pick a
  // value that is genuinely absent rather than one that happens to be present in
  // another policy -- that is a different class with a different expected result.
  const corpusQuantities = new Set();
  for (const entry of kb) {
    for (const q of answers.quantities(entry.answer)) {
      corpusQuantities.add(`${q.value}|${q.unit}`);
    }
  }

  for (const entry of kb) {
    const own = answers.quantities(entry.answer);

    // 1. changed_number -- a quantity replaced by one absent from the corpus.
    //    Every quantity in the policy is mutated in turn, for the same reason
    //    the swap class enumerates: taking only the first made the class a
    //    sample of one per document, chosen by regex match order.
    for (const q of own) {
      let replacement = q.value + 1;
      while (corpusQuantities.has(`${replacement}|${q.unit}`)) replacement += 1;
      push({
        cls: 'changed_number',
        policyId: entry.id,
        answer: entry.answer.replace(q.text, `${replacement} ${q.unit}s`),
        note: `${q.text} -> ${replacement} ${q.unit}s (absent from the corpus)`,
      });
    }

    // 2. swapped_number -- a quantity replaced by a real one from elsewhere in
    //    the corpus. Present in the context, so the unsupported-number check
    //    cannot see it.
    //
    //    EVERY same-unit alternative is enumerated, not the first one found. The
    //    first version took `[...corpusQuantities].find(...)`, which made the
    //    class's difficulty an artefact of Set iteration order -- and it showed:
    //    widening the quantity extractor added six figures to the pool, changed
    //    which swap each policy got, and moved the measured detection rate from
    //    0.3077 to 0.0000 without a single check changing. A rate that swings
    //    that far on an unrelated edit is not measuring the detector.
    for (const key of [...corpusQuantities].sort()) {
      const [rawValue, unit] = key.split('|');
      const other = { value: Number(rawValue), unit };
      const q = own.find((o) => o.unit === other.unit && o.value !== other.value);
      if (!q) continue;
      push({
        cls: 'swapped_number',
        policyId: entry.id,
        answer: entry.answer.replace(q.text, `${other.value} ${other.unit}s`),
        note: `${q.text} -> ${other.value} ${other.unit}s (real, from elsewhere in the corpus)`,
      });
    }

    // 3. negated_requirement -- a stated obligation inverted. No number moves.
    const mustAt = entry.answer.match(/\b(must|are required to|is mandatory|shall)\b/i);
    if (mustAt) {
      const replacement = /mandatory/i.test(mustAt[1])
        ? 'is optional'
        : `${mustAt[1]} not`;
      push({
        cls: 'negated_requirement',
        policyId: entry.id,
        answer: entry.answer.replace(mustAt[1], replacement),
        note: `"${mustAt[1]}" -> "${replacement}"`,
      });
    }

    // 4. dropped_condition -- a conditional clause removed. An omission: nothing
    //    the answer states is false, so there is nothing for a comparison against
    //    the context to find.
    const sentences = answers.splitSentences(entry.answer);
    const conditional = sentences.find((s) => /\b(if|unless|after|beyond|exceeding|more than)\b/i.test(s));
    if (conditional && sentences.length > 2) {
      push({
        cls: 'dropped_condition',
        policyId: entry.id,
        answer: entry.answer.replace(conditional, '').replace(/\s{2,}/g, ' ').trim(),
        note: `removed: "${conditional.slice(0, 70)}..."`,
      });
    }
  }

  // 5. entitlement_swap -- the two leave figures exchanged, stated as a total.
  //    The number is real and in the context; only the authoritative table says
  //    it is bound to the wrong pool.
  push({
    cls: 'entitlement_swap',
    policyId: 'policy_003_cl',
    answer: `You are entitled to ${ENTITLEMENTS.combined_annual_sick_leave.days} `
      + 'days of casual leave per year.',
    note: 'combined pool figure presented as the casual entitlement',
  });
  push({
    cls: 'entitlement_swap',
    policyId: 'policy_003_el_sl',
    answer: `Your combined annual and sick leave entitlement is `
      + `${ENTITLEMENTS.casual_leave.days} days per year.`,
    note: 'casual figure presented as the combined entitlement',
  });
  push({
    cls: 'entitlement_swap',
    policyId: 'policy_003_cl',
    answer: 'Casual leave: employees are granted 12 days per year and may take '
      + 'them consecutively.',
    note: 'a plausible round number, absent from the corpus',
  });

  // 6. imported_clause -- a real sentence grafted from an unrelated policy. Every
  //    word of it appears in the corpus; it is simply not about this question.
  const donor = byId.get('policy_011') || kb[0];
  const donorSentence = answers.splitSentences(donor.answer)[0];
  for (const id of ['policy_003_cl', 'policy_002', 'policy_016_claims']) {
    const target = byId.get(id);
    if (!target || !donorSentence) continue;
    push({
      cls: 'imported_clause',
      policyId: id,
      answer: `${target.answer} ${donorSentence}`,
      note: `grafted from ${donor.id}`,
    });
  }

  // 7. fabricated_citation -- a source that was never retrieved.
  for (const id of ['policy_003_cl', 'policy_013', 'policy_009']) {
    const target = byId.get(id);
    if (!target) continue;
    push({
      cls: 'fabricated_citation',
      policyId: id,
      answer: `${target.answer} Source: Employee Handbook Addendum, Section 47.3`,
      note: 'cites a document that does not exist',
    });
  }

  return out;
}

/**
 * The context a mutated answer would have been generated from.
 *
 * Built the way the service builds it -- the gold policy plus its four nearest
 * neighbours by cosine, formatted identically -- because a mutation scored
 * against a context that does not resemble the real one measures nothing. The
 * near-duplicate families matter here: they are why both leave figures are almost
 * always in the context together, which is what makes `swapped_number` hard.
 */
function contextFor(policyId, kb, store) {
  const byId = new Map(kb.map((e) => [e.id, e]));
  const gold = byId.get(policyId);
  const goldVector = store.policies[policyId];

  let ids = [policyId];
  if (goldVector) {
    const neighbours = Object.entries(store.policies)
      .filter(([id]) => id !== policyId)
      .map(([id, v]) => ({ id, cos: embeddings.cosine(goldVector, v) }))
      .sort((a, b) => b.cos - a.cos)
      .slice(0, 4)
      .map((n) => n.id);
    ids = [policyId, ...neighbours];
  }

  const entries = ids.map((id) => byId.get(id)).filter(Boolean);
  const formatted = entries
    .map((e) => `Source: ${e.source}\nPolicy Details: ${e.answer}`);
  return {
    context: formatted.join('\n\n'),
    // The same documents, unconcatenated. Stage 3 needs both: scoring a sentence
    // against the concatenation and against each document separately are
    // different questions and they turn out to give very different answers.
    documents: formatted,
    sources: entries.map((e) => e.source),
    gold,
  };
}

// ---------------------------------------------------------------------------
// Stage 1: the extractive path
// ---------------------------------------------------------------------------

function stageExtractive(kb, qrels, queries, store, rerankStore) {
  console.log('');
  console.log('STAGE 1  the extractive path (the default, and what CI reviews)');
  console.log('');

  const byId = new Map(kb.map((e) => [e.id, e]));
  const report = queries.cases.filter((_, i) => i % 2 === 1);

  // What the shipping configuration returns for each query: dense retrieval,
  // reranked. Same precomputed scores the retrieval eval uses, so this is the
  // same system and not a reimplementation of it.
  const topFor = (q) => {
    const vector = store.queries[q];
    const row = rerankStore.scores[q];
    if (!vector) return null;
    const pool = Object.entries(store.policies)
      .map(([id, pv]) => ({ id, cos: embeddings.cosine(vector, pv) }))
      .sort((a, b) => b.cos - a.cos)
      .slice(0, rerankModule.DEFAULT_POOL);
    if (!row) return pool[0]?.id || null;
    return pool
      .map((c) => ({ id: c.id, score: row[c.id] }))
      .filter((c) => Number.isFinite(c.score))
      .sort((a, b) => b.score - a.score)[0]?.id || pool[0]?.id || null;
  };

  let verbatimOk = 0;
  let graded = 0;
  let gradeSum = 0;
  let answered = 0;
  let partial = 0;
  let unanswered = 0;
  const misses = [];

  for (const testCase of report) {
    const topId = topFor(testCase.q);
    if (!topId) continue;
    const entry = byId.get(topId);
    const { context, sources } = contextFor(topId, kb, store);

    // The property, asserted: the answer IS the retrieved text.
    const verdict = answers.verify(entry.answer, { context, sources });
    if (verdict.verbatim && verdict.grounded) verbatimOk += 1;

    // Answer relevance, from the graded judgements: does the document the user is
    // shown actually answer what they asked? This is an answer-layer number even
    // though it is derived from retrieval, because in extractive mode retrieval
    // IS the answer layer -- and saying that plainly is more useful than
    // inventing a separate metric that would measure the same thing.
    const row = qrels.judgements[testCase.q];
    if (row && Object.prototype.hasOwnProperty.call(row, topId)) {
      graded += 1;
      const g = row[topId];
      gradeSum += g;
      if (g === 2) answered += 1;
      else if (g === 1) partial += 1;
      else unanswered += 1;
      if (g < 2) misses.push({ q: testCase.q, topId, grade: g });
    } else if (row) {
      // Absent from the graded set means grade 0 by the fixture's own convention.
      graded += 1;
      unanswered += 1;
      misses.push({ q: testCase.q, topId, grade: 0 });
    }
  }

  console.log(`  answers that are verbatim from context and pass every check   `
    + `${pct(verbatimOk, report.length)}`);
  console.log('    Not a measurement. In extractive mode the answer is the');
  console.log('    retrieved text, so this is a structural property and the only');
  console.log('    interesting outcome is it breaking.');
  console.log('');
  console.log(`  answer relevance on the report half (graded judgements)`);
  console.log(`    fully answers the question (grade 2)     ${pct(answered, graded)}`);
  console.log(`    partial, useful but incomplete (grade 1) ${pct(partial, graded)}`);
  console.log(`    does not answer it (grade 0)             ${pct(unanswered, graded)}`);
  console.log(`    mean normalised grade                    ${fmt(gradeSum / (2 * graded))}`);
  console.log('');
  console.log('    In extractive mode the answer layer has no headroom above');
  console.log('    retrieval: it returns one document unaltered, so a query whose');
  console.log('    answer spans two policies cannot be fully answered at all.');

  if (misses.length) {
    console.log('');
    console.log('  where the returned text does not fully answer the question:');
    for (const m of misses) {
      console.log(`    grade ${m.grade}  ${m.topId.padEnd(24)} ${m.q}`);
    }
  }

  return {
    cases: report.length,
    verbatim_and_grounded: verbatimOk,
    graded,
    answered,
    partial,
    unanswered,
    mean_normalised_grade: gradeSum / (2 * graded),
  };
}

// ---------------------------------------------------------------------------
// Stage 2: verifier sensitivity, exact checks only
// ---------------------------------------------------------------------------

function stageMutations(kb, mutations, store) {
  console.log('');
  console.log('STAGE 2  can the request-path guard detect an unfaithful answer?');
  console.log('');
  console.log('  Sensitivity of the verifier, NOT the faithfulness of the system.');
  console.log('  Nothing here says how often a real generation is wrong; it says');
  console.log('  what fraction of known-wrong answers the guard would catch.');
  console.log('');

  // The control first. A verifier that flags true text has no usable operating
  // point and the detection rates below would be meaningless.
  const falsePositives = [];
  for (const entry of kb) {
    const { context, sources } = contextFor(entry.id, kb, store);
    const verdict = answers.verify(entry.answer, { context, sources });
    if (!verdict.grounded) {
      falsePositives.push({ id: entry.id, findings: verdict.findings });
    }
  }

  console.log(`  CONTROL  unmutated corpus answers flagged   `
    + `${pct(falsePositives.length, kb.length)}`);
  for (const fp of falsePositives) {
    console.log(`    ${fp.id.padEnd(30)} ${fp.findings.map((f) => `${f.check}:${f.detail}`).join(', ')}`);
  }
  console.log('');

  const byClass = new Map();
  for (const m of mutations) {
    const { context, sources } = contextFor(m.policyId, kb, store);
    const verdict = answers.verify(m.answer, { context, sources });
    const detected = !verdict.grounded;

    if (!byClass.has(m.cls)) byClass.set(m.cls, { total: 0, detected: 0, missed: [] });
    const bucket = byClass.get(m.cls);
    bucket.total += 1;
    if (detected) bucket.detected += 1;
    else bucket.missed.push(m);

    m.detected_exact = detected;
    m.findings_exact = verdict.findings.map((f) => f.check);
  }

  console.log('  class                  detected         predicted  floor   verdict');
  const perClass = {};
  for (const [cls, bucket] of [...byClass.entries()].sort()) {
    const rate = bucket.detected / bucket.total;
    const prediction = PREDICTIONS[cls];
    const floor = FLOORS[cls];
    const predicted = prediction ? fmt(prediction.predicted) : '   n/a';
    const held = !prediction || rate >= prediction.predicted;
    const verdict = held ? 'as predicted' : 'PREDICTION MISSED';
    console.log(`  ${cls.padEnd(22)} ${pct(bucket.detected, bucket.total).padEnd(16)} `
      + `${predicted}     ${fmt(floor ? floor.min : 0)}  ${verdict}`);
    perClass[cls] = {
      total: bucket.total,
      detected: bucket.detected,
      rate,
      predicted: prediction ? prediction.predicted : null,
      prediction_held: held,
    };
  }

  const missed = Object.entries(perClass).filter(([, r]) => !r.prediction_held);
  if (missed.length) {
    console.log('');
    console.log('  PREDICTIONS THAT WERE WRONG');
    for (const [cls] of missed) {
      const outcome = PREDICTIONS[cls] && PREDICTIONS[cls].outcome;
      console.log(`    ${cls}: predicted ${fmt(PREDICTIONS[cls].predicted)}, `
        + `measured ${fmt(perClass[cls].rate)}`);
      if (outcome) {
        // Wrapped at the width the rest of this output uses.
        const words = outcome.split(' ');
        let line = '     ';
        for (const w of words) {
          if ((line + w).length > 74) { console.log(line); line = '     '; }
          line += `${w} `;
        }
        if (line.trim()) console.log(line);
      }
    }
  }

  console.log('');
  for (const [cls, bucket] of [...byClass.entries()].sort()) {
    if (!bucket.missed.length) continue;
    console.log(`  missed by every exact check -- ${cls}:`);
    for (const m of bucket.missed.slice(0, 4)) {
      console.log(`    ${m.policyId.padEnd(26)} ${m.note}`);
    }
    if (bucket.missed.length > 4) {
      console.log(`    ... and ${bucket.missed.length - 4} more`);
    }
  }

  return {
    control_false_positives: falsePositives.length,
    control_total: kb.length,
    per_class: perClass,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: what entailment adds
// ---------------------------------------------------------------------------

let transformers = null;
async function tf() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = process.env.MODEL_CACHE_DIR
      || path.resolve(__dirname, '..', '.model-cache');
  }
  return transformers;
}

const NLI_CANDIDATES = [
  'Xenova/nli-deberta-v3-xsmall',
  'Xenova/distilbert-base-uncased-mnli',
  'Xenova/bart-large-mnli',
];

async function stageEntailment(kb, mutations, store, options = {}) {
  console.log('');
  console.log('STAGE 3  what sentence-level entailment adds over the exact checks');
  console.log('');
  console.log('  Three of the seven mutation classes are invisible to every exact');
  console.log('  check by construction. This is the measurement of whether the');
  console.log('  model-based signal that would cost 100x more per request earns it.');
  console.log('');

  const t = await tf();
  let nli = null;
  for (const id of NLI_CANDIDATES) {
    try {
      const tokenizer = await t.AutoTokenizer.from_pretrained(id);
      const model = await t.AutoModelForSequenceClassification.from_pretrained(
        id, { dtype: 'fp32' },
      );
      nli = { id, tokenizer, model };
      break;
    } catch (error) {
      console.log(`  ${id.padEnd(40)} unavailable -- ${String(error.message).slice(0, 60)}`);
    }
  }
  if (!nli) {
    console.log('  SKIPPED: no NLI model could be loaded.');
    return { skipped: true };
  }
  console.log(`  model ${nli.id}`);

  // Read the entailment index from the model's own config. MNLI checkpoints
  // disagree about label order and guessing would invert every score.
  const labels = nli.model.config.id2label || {};
  const found = Object.entries(labels).find(([, name]) => /entail/i.test(name));
  if (!found) throw new Error(`no entailment label in ${JSON.stringify(labels)}`);
  const entailIdx = Number(found[0]);
  const contraFound = Object.entries(labels).find(([, name]) => /contra/i.test(name));
  const contraIdx = contraFound ? Number(contraFound[0]) : null;
  console.log(`  labels ${JSON.stringify(labels)}`);

  const score = async (premise, hypothesis) => {
    const inputs = nli.tokenizer([premise], {
      text_pair: [hypothesis], padding: true, truncation: true,
    });
    const { logits } = await nli.model(inputs);
    const row = logits.tolist()[0];
    const max = Math.max(...row);
    const exp = row.map((z) => Math.exp(z - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return {
      entail: exp[entailIdx] / sum,
      contra: contraIdx === null ? null : exp[contraIdx] / sum,
    };
  };

  /**
   * The answer's least-entailed and most-contradicted sentence.
   *
   * Each sentence is scored against the whole context as premise. Extremes over
   * sentences rather than means, deliberately: one fabricated sentence in an
   * otherwise correct answer makes the answer unfaithful, and a mean would let
   * nine true sentences bury it.
   *
   * Both directions are kept because they are not the same detector and the
   * difference turned out to matter. Low entailment says "the context does not
   * support this"; high contradiction says "the context says the opposite". A
   * sentence that inverts a requirement is barely less entailed than the original
   * -- both are on-topic and use the same vocabulary -- while being flatly
   * contradicted. Only measuring one would have missed that.
   */
  const scoreAnswer = async (answer, context) => {
    const sentences = answers.splitSentences(answer);
    if (!sentences.length) return { entail: 1, contra: 0 };
    let minEntail = 1;
    let maxContra = 0;
    for (const sentence of sentences) {
      const s = await score(context, sentence);
      if (s.entail < minEntail) minEntail = s.entail;
      if (s.contra !== null && s.contra > maxContra) maxContra = s.contra;
    }
    return { entail: minEntail, contra: maxContra };
  };

  /**
   * The same scoring, but per retrieved document instead of against the
   * concatenation.
   *
   * This variant exists because of a false positive the first version produced,
   * and the false positive turned out to be the more interesting result. Scored
   * against the concatenated context, the single most CONTRADICTED true sentence
   * in the whole corpus is policy_003_el_sl's "Can be carried forward within
   * limits" at 0.9009 -- and the model is right. The context handed to it also
   * contains policy_003_cl, which says leave "cannot be carried forward,
   * accumulated, or encashed". Both sentences are true, of different leave types,
   * and concatenating them into one premise makes each a contradiction of the
   * other. The three next-highest are the same family for the same reason.
   *
   * That is a structural fault in how groundedness is usually computed, not a
   * quirk of this corpus. Any retriever that returns a near-duplicate family --
   * which is what retrievers on policy corpora are for -- builds a premise that
   * contradicts itself, and the false-positive floor it creates is what forces
   * the usable threshold up to 0.9009 and starves the detector.
   *
   * The alternative is to ask the question that was actually meant: is this
   * sentence supported by SOME retrieved document, rather than by all of them at
   * once. Best-over-documents, at 5x the model calls. Whether it is worth 5x is
   * the measurement.
   *
   * Three aggregations come out of the same model calls, because the first
   * attempt got one of them wrong in an instructive way. Support and
   * contradiction do not aggregate in the same direction:
   *
   *   entail    best over documents. "Is this supported by SOME document."
   *   contra    least over documents. "Does NO document contradict it." Lenient,
   *             and measurably too lenient -- it dropped negation detection from
   *             0.8333 to 0.3333, because a sentence that inverts a requirement
   *             is flatly contradicted by its own policy while some other policy
   *             in the pool is simply silent about it, and the silent one sets
   *             the minimum.
   *   aligned   the contradiction score of the document that supports the
   *             sentence best. This is the question that was meant all along:
   *             not "does anything disagree" and not "does everything agree",
   *             but "does the document this claim came from actually say it".
   */
  const scoreAnswerPerDocument = async (answer, documents) => {
    const sentences = answers.splitSentences(answer);
    if (!sentences.length) return { entail: 1, contra: 0, aligned: 0 };
    let minEntail = 1;
    let minContra = 0;
    let maxAligned = 0;
    for (const sentence of sentences) {
      let bestEntail = -1;
      let leastContra = 1;
      let alignedContra = 0;
      for (const document of documents) {
        const s = await score(document, sentence);
        if (s.entail > bestEntail) {
          bestEntail = s.entail;
          alignedContra = s.contra === null ? 0 : s.contra;
        }
        if (s.contra !== null && s.contra < leastContra) leastContra = s.contra;
      }
      if (bestEntail < minEntail) minEntail = bestEntail;
      if (leastContra > minContra) minContra = leastContra;
      if (alignedContra > maxAligned) maxAligned = alignedContra;
    }
    return { entail: minEntail, contra: minContra, aligned: maxAligned };
  };

  // Calibrate on the CONTROL only -- the true corpus answers -- and never on the
  // mutations. Picking a threshold that separates the mutations would be fitting
  // the detector to the test set, which is what most of this repository's harness
  // code exists to prevent.
  const control = [];
  const controlPerDoc = [];
  for (const entry of kb) {
    const { context, documents } = contextFor(entry.id, kb, store);
    control.push(await scoreAnswer(entry.answer, context));
    controlPerDoc.push(await scoreAnswerPerDocument(entry.answer, documents));
  }
  const entailAsc = control.map((c) => c.entail).sort((a, b) => a - b);
  const contraDesc = control.map((c) => c.contra).sort((a, b) => b - a);
  const entailAscPD = controlPerDoc.map((c) => c.entail).sort((a, b) => a - b);
  const contraDescPD = controlPerDoc.map((c) => c.contra).sort((a, b) => b - a);
  const alignedDesc = controlPerDoc.map((c) => c.aligned).sort((a, b) => b - a);

  console.log(`  control, true answers -- entailment  min ${fmt(entailAsc[0])}  `
    + `median ${fmt(entailAsc[Math.floor(entailAsc.length / 2)])}  `
    + `max ${fmt(entailAsc[entailAsc.length - 1])}`);
  console.log(`  control, true answers -- contradiction  max ${fmt(contraDesc[0])}  `
    + `median ${fmt(contraDesc[Math.floor(contraDesc.length / 2)])}  `
    + `min ${fmt(contraDesc[contraDesc.length - 1])}`);
  console.log('');
  console.log('    Note how compressed the entailment scores are: no true answer');
  console.log('    scores above 0.08 against its own context. The model was trained');
  console.log('    on natural-language inference pairs and formal policy prose is');
  console.log('    out of domain for it, so the absolute values carry little');
  console.log('    meaning and only the ordering is usable. That is why every');
  console.log('    threshold below is a quantile of the control rather than a');
  console.log('    round number.');
  console.log('');

  // Score every mutation once, then sweep thresholds. Scoring is the expensive
  // part and the sweep is free, so a single-operating-point report would be
  // leaving the most informative view on the floor.
  const scored = [];
  for (const m of mutations) {
    const { context, documents } = contextFor(m.policyId, kb, store);
    const s = await scoreAnswer(m.answer, context);
    const pd = await scoreAnswerPerDocument(m.answer, documents);
    scored.push({
      m, ...s, pdEntail: pd.entail, pdContra: pd.contra, aligned: pd.aligned,
    });
  }

  /**
   * The trade-off, priced in control false positives.
   *
   * A threshold at the control's extreme keeps false positives at zero and is
   * what the report leads with. But a reader is entitled to know whether the
   * detector is starving at that operating point or whether the signal simply is
   * not there, and those look identical from one number. Allowing k false
   * positives out of 26 and reporting what detection buys answers it.
   */
  /**
   * Four detectors, priced identically.
   *
   * Two signals (low entailment, high contradiction) crossed with two premise
   * constructions (the concatenated context, and best-over-documents). Every
   * threshold is a quantile of the CONTROL, so all four are compared at the same
   * false-positive budget and none of them ever saw a mutation.
   */
  const detectors = [
    {
      key: 'entail_concat',
      label: 'entailment, concatenated',
      order: entailAsc,
      hit: (s, threshold) => s.entail < threshold,
    },
    {
      key: 'contra_concat',
      label: 'contradiction, concatenated',
      order: contraDesc,
      hit: (s, threshold) => s.contra > threshold,
    },
    {
      key: 'entail_perdoc',
      label: 'entailment, per document',
      order: entailAscPD,
      hit: (s, threshold) => s.pdEntail < threshold,
    },
    {
      key: 'contra_perdoc_least',
      label: 'contradiction, least over docs',
      order: contraDescPD,
      hit: (s, threshold) => s.pdContra > threshold,
    },
    {
      key: 'contra_aligned',
      label: 'contradiction, aligned document',
      order: alignedDesc,
      hit: (s, threshold) => s.aligned > threshold,
    },
  ];

  console.log('  detection at a matched false-positive budget (of 26 true answers)');
  console.log('  detector                       0 FP     1 FP     2 FP     3 FP');
  const sweeps = {};
  for (const d of detectors) {
    const row = [];
    for (const k of [0, 1, 2, 3]) {
      const threshold = d.order[k];
      const detected = scored.filter((s) => d.hit(s, threshold)).length;
      row.push({ allowed_false_positives: k, threshold, detected });
    }
    console.log(`  ${d.label.padEnd(30)} `
      + row.map((r) => fmt(r.detected / scored.length).padEnd(8)).join(''));
    sweeps[d.key] = row;
  }
  console.log('');
  console.log('  thresholds at 0 FP:');
  for (const d of detectors) {
    console.log(`    ${d.label.padEnd(30)} ${fmt(d.order[0])}`);
  }
  console.log('');
  console.log('  THREE FINDINGS, ONE OF THEM AGAINST A PREDICTION MADE HERE');
  console.log('');
  console.log('  1. Contradiction beats entailment by three to four times, at every');
  console.log('     budget and in every construction. Entailment tops out at 0.0867');
  console.log('     and is near-useless. This is worth stating plainly because');
  console.log('     entailment probability is the signal groundedness checks are');
  console.log('     normally built on: the question "is this supported" is being');
  console.log('     asked of a model that scores no true answer in this corpus above');
  console.log('     0.0703 against its own source. Asking "does the source say the');
  console.log('     opposite" gets a usable answer from the same forward pass.');
  console.log('');
  console.log('  2. The concatenated premise contradicts itself, and that sets a');
  console.log('     false-positive floor. The most-contradicted TRUE sentence in the');
  console.log('     corpus is policy_003_el_sl\'s "Can be carried forward within');
  console.log('     limits" at 0.9009 -- and the model is right, because the same');
  console.log('     premise also contains policy_003_cl saying leave cannot be');
  console.log('     carried forward. Two true statements about two leave types,');
  console.log('     concatenated into one self-contradicting premise; the three');
  console.log('     next-highest are the same family for the same reason. Scoring');
  console.log('     per document drops the 0-FP threshold from 0.9009 to 0.0708, a');
  console.log('     factor of twelve, which is the size of the artefact.');
  console.log('');
  console.log('     This is a fault in how groundedness is normally computed rather');
  console.log('     than a quirk of this corpus: any retriever doing its job on a');
  console.log('     policy corpus returns the near-duplicate family, so the premise');
  console.log('     contradicts itself by construction.');
  console.log('');
  console.log('     It does NOT make per-document uniformly better, and claiming so');
  console.log('     would overstate it. Per-document wins at 0 FP (0.2533 against');
  console.log('     0.1933) and loses by 1 FP onwards (0.3533 against 0.4333 at');
  console.log('     3 FP). Zero false positives is the defensible operating point');
  console.log('     for a request-path guard, so that is the one used below -- but a');
  console.log('     reader wanting recall over precision should take the');
  console.log('     concatenated form and the extra false positives with it.');
  console.log('');
  console.log('  3. PREDICTION MISSED. "Contradiction against the sentence\'s own');
  console.log('     best-supporting document" was designed here as the formulation');
  console.log('     that should beat both -- neither "does anything disagree" nor');
  console.log('     "does everything agree" but "does the document this claim came');
  console.log('     from actually say it". It is the WORST of the five: 0.0133 at');
  console.log('     0 FP, against 0.2533 for the crude least-over-documents form.');
  console.log('');
  console.log('     The reason is finding 1 turning back on itself. Picking the');
  console.log('     best-supporting document means taking an argmax over entailment');
  console.log('     scores that are all around 0.01 and carry almost no signal, so');
  console.log('     the document selected is close to arbitrary, and a contradiction');
  console.log('     score against an arbitrary document is noise. The formulation is');
  console.log('     not wrong in principle; it needs a support signal strong enough');
  console.log('     to rank documents, and this model does not provide one.');
  console.log('');

  // The operating point the per-class table uses: the best-measured pair at zero
  // false positives, which is the only setting defensible for a check that would
  // run in front of a user. Not the pair predicted to be best -- see finding 3.
  const entailThreshold = entailAscPD[0];
  const contraThreshold = contraDescPD[0];
  console.log(`  per-class table below: per-document entailment < ${fmt(entailThreshold)} `
    + `OR least-over-documents`);
  console.log(`    contradiction > ${fmt(contraThreshold)}, both at zero control false `
    + 'positives.');
  console.log('');

  const byClass = new Map();
  for (const s of scored) {
    const m = s.m;
    const detectedNli = s.pdEntail < entailThreshold || s.pdContra > contraThreshold;

    if (!byClass.has(m.cls)) {
      byClass.set(m.cls, {
        total: 0, nli: 0, exact: 0, either: 0, nliOnly: 0,
      });
    }
    const b = byClass.get(m.cls);
    b.total += 1;
    if (detectedNli) b.nli += 1;
    if (m.detected_exact) b.exact += 1;
    if (detectedNli || m.detected_exact) b.either += 1;
    if (detectedNli && !m.detected_exact) b.nliOnly += 1;

    m.detected_nli = detectedNli;
    m.entail_min = s.pdEntail;
    m.contra_max = s.pdContra;
  }

  console.log('  class                  exact      NLI        either     NLI adds');
  const perClass = {};
  for (const [cls, b] of [...byClass.entries()].sort()) {
    console.log(`  ${cls.padEnd(22)} ${fmt(b.exact / b.total).padEnd(10)} `
      + `${fmt(b.nli / b.total).padEnd(10)} ${fmt(b.either / b.total).padEnd(10)} `
      + `${b.nliOnly === 0 ? 'nothing' : `+${b.nliOnly}`}`);
    perClass[cls] = {
      total: b.total,
      exact: b.exact / b.total,
      nli: b.nli / b.total,
      either: b.either / b.total,
      nli_only: b.nliOnly,
    };
  }

  const totals = [...byClass.values()].reduce((acc, b) => ({
    total: acc.total + b.total,
    exact: acc.exact + b.exact,
    nli: acc.nli + b.nli,
    either: acc.either + b.either,
    nliOnly: acc.nliOnly + b.nliOnly,
  }), { total: 0, exact: 0, nli: 0, either: 0, nliOnly: 0 });

  console.log('');
  console.log(`  overall  exact ${pct(totals.exact, totals.total)}   `
    + `NLI ${pct(totals.nli, totals.total)}   either ${pct(totals.either, totals.total)}`);
  console.log(`  entailment catches ${totals.nliOnly} mutation(s) the exact checks miss.`);

  return {
    skipped: false,
    model: nli.id,
    premise: 'per retrieved document, not the concatenated context',
    signal: 'least-over-documents contradiction OR best-over-documents entailment',
    findings: [
      'contradiction outscores entailment 3-4x at every budget and construction; '
      + 'entailment tops out at 0.0867 and is near-useless, which matters because '
      + 'entailment probability is what groundedness checks are normally built on',
      'the concatenated premise contradicts itself on near-duplicate families, '
      + 'setting a false-positive floor that puts the 0-FP threshold at 0.9009; '
      + 'per-document scoring drops it to 0.0708, a factor of twelve',
      'per-document is NOT uniformly better: it wins at 0 FP (0.2533 vs 0.1933) '
      + 'and loses from 1 FP onwards (0.3533 vs 0.4333 at 3 FP)',
      'PREDICTION MISSED: contradiction against the best-supporting document was '
      + 'designed here as the formulation that should beat both, and is the worst '
      + 'of the five at 0.0133. The argmax that selects the document runs over '
      + 'entailment scores of about 0.01 that carry no signal, so the document is '
      + 'effectively arbitrary and the score against it is noise.',
    ],
    entail_threshold: entailThreshold,
    contra_threshold: contraThreshold,
    control_concatenated: {
      entail_min: entailAsc[0], entail_max: entailAsc[entailAsc.length - 1],
      contra_max: contraDesc[0], contra_min: contraDesc[contraDesc.length - 1],
    },
    control_per_document: {
      entail_min: entailAscPD[0], entail_max: entailAscPD[entailAscPD.length - 1],
      contra_max: contraDescPD[0], contra_min: contraDescPD[contraDescPD.length - 1],
      aligned_max: alignedDesc[0], aligned_min: alignedDesc[alignedDesc.length - 1],
    },
    sweeps,
    per_class: perClass,
    overall: {
      total: totals.total,
      exact: totals.exact / totals.total,
      nli: totals.nli / totals.total,
      either: totals.either / totals.total,
      nli_only: totals.nliOnly,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 4: the live generative path
// ---------------------------------------------------------------------------

async function stageLive(kb, queries, store, rerankStore) {
  console.log('');
  console.log('STAGE 4  the live generative path');
  console.log('');

  const config = llm.readConfig();
  if (!llm.isConfigured(config)) {
    console.log('  NOT RUN. No LLM_PROVIDER is configured, which is the mode every');
    console.log('  other number in this repository is produced in.');
    console.log('');
    console.log('  This is the honest state of the generative path and it is worth');
    console.log('  being blunt about: stages 2 and 3 measure whether the guard can');
    console.log('  catch an unfaithful answer, and that is not the same claim as');
    console.log('  "our answers are faithful". Nothing here establishes the second.');
    console.log('');
    console.log('  Running it needs a key, and a number produced that way cannot be');
    console.log('  reproduced by a reader or re-run in CI -- it would depend on a');
    console.log('  vendor, a model version and a sampling temperature. Set');
    console.log('  LLM_PROVIDER and LLM_API_KEY to run it locally; the report will');
    console.log('  name the provider and model so what it depended on is legible.');
    return { run: false, reason: 'not_configured' };
  }

  console.log(`  provider ${config.provider}, model ${config.model || 'provider default'}`);
  console.log('  Numbers below depend on that provider and are not reproducible');
  console.log('  from a fresh clone. They are reported, not gated.');
  console.log('');

  const byId = new Map(kb.map((e) => [e.id, e]));
  const report = queries.cases.filter((_, i) => i % 2 === 1);
  const results = [];
  let grounded = 0;

  for (const testCase of report) {
    const vector = store.queries[testCase.q];
    if (!vector) continue;
    const row = rerankStore.scores[testCase.q];
    const pool = Object.entries(store.policies)
      .map(([id, pv]) => ({ id, cos: embeddings.cosine(vector, pv) }))
      .sort((a, b) => b.cos - a.cos)
      .slice(0, rerankModule.DEFAULT_POOL);
    const ranked = row
      ? pool.map((c) => ({ id: c.id, score: row[c.id] }))
        .filter((c) => Number.isFinite(c.score))
        .sort((a, b) => b.score - a.score)
      : pool;
    const top = ranked.slice(0, 5).map((c) => byId.get(c.id)).filter(Boolean);
    const context = top
      .map((e) => `Source: ${e.source}\nPolicy Details: ${e.answer}`).join('\n\n');
    const sources = top.map((e) => e.source);

    const generated = await llm.generate(testCase.q, context);
    if (!generated.text) {
      results.push({ q: testCase.q, error: generated.reason });
      continue;
    }
    const verdict = answers.verify(generated.text, { context, sources });
    if (verdict.grounded) grounded += 1;
    else {
      console.log(`  FLAGGED  ${testCase.q}`);
      for (const f of verdict.findings) console.log(`    ${f.check}: ${f.detail}`);
    }
    results.push({ q: testCase.q, grounded: verdict.grounded, findings: verdict.findings });
  }

  const scored = results.filter((r) => r.grounded !== undefined);
  console.log('');
  console.log(`  generated answers passing every exact check  ${pct(grounded, scored.length)}`);
  console.log('  A pass is not proof of faithfulness -- stage 3 reports three');
  console.log('  mutation classes these checks cannot see.');

  return {
    run: true,
    provider: config.provider,
    model: config.model || null,
    scored: scored.length,
    grounded,
    results,
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const gate = args.includes('--gate');
  const wantNli = args.includes('--nli') || gate === false && args.includes('--all');

  const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  const load = (f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), 'utf8'));
  const queries = load('policy_queries.json');
  const qrels = load('policy_qrels.json');
  const store = dense.loadVectors();
  const rerankStore = rerankModule.loadScores();

  console.log('');
  console.log('The answer layer');
  console.log('');
  console.log('  Four stages. The first asserts a structural property of the');
  console.log('  default path, the second and third measure whether the guard can');
  console.log('  detect a known-wrong answer, and the fourth reports whether the');
  console.log('  generative path was exercised at all.');

  const mutations = buildMutations(kb);
  console.log('');
  console.log(`  ${mutations.length} mutations across `
    + `${new Set(mutations.map((m) => m.cls)).size} classes, `
    + 'generated from the corpus at run time');

  const extractive = stageExtractive(kb, qrels, queries, store, rerankStore);
  const mutation = stageMutations(kb, mutations, store);

  /**
   * The last recorded entailment result, so a skipped stage 3 does not erase it.
   *
   * CI runs without `--nli`, because the stage needs a 70MB cross-encoder and one
   * model call per sentence per retrieved document. The first version wrote
   * `{ skipped: true }` over the entailment block on every such run, so the whole
   * measurement -- four detectors, four false-positive budgets, the finding about
   * the self-contradicting premise -- was deleted from the report by the next
   * gated run and only the person who ran it locally ever saw it.
   *
   * Carried forward with the provenance attached rather than silently kept, so a
   * reader can tell a figure produced by this run from one produced by an earlier
   * one.
   */
  const previousReport = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'answer_report.json'), 'utf8'));
    } catch {
      return null;
    }
  })();

  let entailment;
  if (wantNli) {
    entailment = await stageEntailment(kb, mutations, store);
  } else if (previousReport && previousReport.entailment
    && previousReport.entailment.skipped === false) {
    entailment = {
      ...previousReport.entailment,
      from_a_previous_run: true,
      note: 'Not re-measured by this run. Stage 3 needs a model and is skipped by '
        + 'default and in CI; run `npm run eval:answers:nli` to refresh it.',
    };
    console.log('');
    console.log('STAGE 3  not re-run. Carrying forward the last recorded result:');
    console.log(`  model ${entailment.model}`);
    console.log(`  exact ${fmt(entailment.overall.exact)}   `
      + `NLI ${fmt(entailment.overall.nli)}   either ${fmt(entailment.overall.either)}`);
    console.log('  `npm run eval:answers:nli` re-measures it (~10 minutes).');
  } else {
    entailment = { skipped: true, reason: 'never run; pass --nli (needs a 70MB model)' };
    console.log('');
    console.log('STAGE 3  never run. Pass --nli to run it (needs a 70MB model).');
  }

  const live = await stageLive(kb, queries, store, rerankStore);

  // ------------------------------------------------------------------
  // Gates
  // ------------------------------------------------------------------
  const failures = [];
  if (mutation.control_false_positives > FLOORS.false_positives.max) {
    failures.push(`${mutation.control_false_positives} unmutated corpus answers were `
      + `flagged; the bar is ${FLOORS.false_positives.max} -- ${FLOORS.false_positives.why}`);
  }
  for (const [cls, result] of Object.entries(mutation.per_class)) {
    const floor = FLOORS[cls];
    if (!floor || floor.min === undefined) continue;
    if (result.rate < floor.min) {
      failures.push(`${cls} detection ${fmt(result.rate)} fell below its regression `
        + `floor of ${floor.min}`);
    }
  }

  console.log('');
  if (failures.length) {
    console.log('GATES  FAILED');
    for (const f of failures) console.log(`  - ${f}`);
  } else {
    console.log('GATES  every declared bar held.');
  }

  const out = {
    about: 'Answer-layer evaluation. Stage 2 and 3 measure the SENSITIVITY of the '
      + 'faithfulness verifier against deterministically generated unfaithful '
      + 'answers. They do not measure the faithfulness of the system: that needs '
      + 'real generations, which need an API key, which would make the number '
      + 'unreproducible. Stage 4 records whether the generative path was run.',
    generated_by: 'npm run eval:answers',
    predictions: PREDICTIONS,
    regression_floors: FLOORS,
    extractive,
    mutation,
    entailment,
    live,
  };
  fs.writeFileSync(
    path.join(EVAL_DIR, 'answer_report.json'), `${JSON.stringify(out, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(EVAL_DIR, 'answer_mutations.json'),
    `${JSON.stringify({
      about: 'A record of the mutation suite for review. NOT the input: '
        + 'scripts/eval_answers.js regenerates these from the corpus every run so '
        + 'they cannot drift out of step with the policy text.',
      classes: Object.fromEntries(
        [...new Set(mutations.map((m) => m.cls))].map((c) => [c, PREDICTIONS[c] || null]),
      ),
      mutations,
    }, null, 2)}\n`,
  );

  console.log('');
  console.log('  wrote eval/answer_report.json and eval/answer_mutations.json');
  console.log('');

  if (gate && failures.length) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n${error.stack}\n`);
    process.exit(1);
  });
}

module.exports = { buildMutations, contextFor, PREDICTIONS, FLOORS };
