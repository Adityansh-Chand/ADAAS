'use strict';

/**
 * Can a reader tell "the corpus discusses this" from "the corpus answers this"?
 *
 *   npm run probe:answerability
 *
 * WHY THIS IS THE RIGHT SHAPE OF ATTEMPT
 *
 * Three signals have failed on the same twelve hard-tier questions: dense cosine,
 * cross-encoder logit, and term-level corpus coverage. All three measure
 * SIMILARITY, and the distinction being asked for is not one of similarity --
 * "how many days of paternity leave does the law require" is maximally similar to
 * the paternity leave policy, which is exactly why it leaks. The policy says the
 * company gives 10 days. It says nothing about what the law requires.
 *
 * What separates those two is entailment, not similarity: does the passage
 * support a claim that answers the question? That is a different question a
 * different kind of model answers, and this probe tests whether an off-the-shelf
 * natural language inference model can answer it here.
 *
 * The setup: turn each question into a hypothesis that the passage would have to
 * support ("The company policy states the answer to: <question>"), run NLI over
 * (passage, hypothesis), and use the entailment probability. In-scope questions
 * whose gold policy genuinely answers them should entail; hard-tier questions
 * whose retrieved policy is merely about the topic should not.
 *
 * WHAT WOULD COUNT AS SUCCESS, DECLARED BEFORE THE NUMBERS
 *
 * Same bar as the abstention probe, and set for the same reason. A threshold that
 * keeps every genuine question must reject at least 4 of the 12 hard negatives --
 * double what the shipping thresholds already achieve -- with at least 0.05 of
 * margin below the weakest genuine question. Anything less is reported as not
 * usable and nothing ships, because rejecting a real question to catch an
 * unanswerable one is a worse service, and the in-scope survival gate in
 * eval_retrieval.js exists to say so.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const EVAL_DIR = path.join(ROOT, 'eval');
const OUT_PATH = path.join(EVAL_DIR, 'answerability_probe.json');

const dense = require('../dense');
const embeddings = require('../embeddings');
const rerankModule = require('../rerank');

// Candidates in rough order of preference. An NLI model has to be small enough
// to be a plausible addition to a service that already carries two models, and
// has to have an ONNX export transformers.js can load -- which is not a given, so
// they are tried in turn and the failures are recorded rather than hidden.
const NLI_CANDIDATES = [
  'Xenova/nli-deberta-v3-xsmall',
  'Xenova/distilbert-base-uncased-mnli',
  'Xenova/bart-large-mnli',
];

const MIN_YIELD = 4;
const MIN_MARGIN = 0.05;

const fmt = (v) => v.toFixed(4);

let transformers = null;
async function tf() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = process.env.MODEL_CACHE_DIR
      || path.resolve(__dirname, '..', '.model-cache');
  }
  return transformers;
}

async function loadNli() {
  const t = await tf();
  const attempts = [];
  for (const id of NLI_CANDIDATES) {
    try {
      const tokenizer = await t.AutoTokenizer.from_pretrained(id);
      const model = await t.AutoModelForSequenceClassification.from_pretrained(
        id, { dtype: 'fp32' },
      );
      return { id, tokenizer, model, attempts };
    } catch (error) {
      attempts.push({ id, error: String(error.message).slice(0, 160) });
      console.log(`  ${id.padEnd(40)} unavailable -- `
        + `${String(error.message).slice(0, 80)}`);
    }
  }
  throw new Error(`no NLI model could be loaded; tried ${NLI_CANDIDATES.join(', ')}`);
}

function passageText(entry) {
  return [entry.question || '', entry.category || '', entry.answer || '']
    .filter(Boolean).join('. ');
}

async function main() {
  const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  const kbById = new Map(kb.map((e) => [e.id, e]));
  const load = (f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), 'utf8'));
  const store = dense.loadVectors();
  const rerankStore = rerankModule.loadScores();

  console.log('');
  console.log('Answerability as an abstention signal');

  const nli = await loadNli();
  console.log(`  model ${nli.id}`);

  // Which label index is entailment? Read it from the model's own config rather
  // than assuming a convention -- MNLI checkpoints disagree about whether index 0
  // is contradiction or entailment, and guessing would invert the whole probe.
  const labels = nli.model.config.id2label || {};
  const entailIndex = Object.entries(labels)
    .find(([, name]) => /entail/i.test(name));
  if (!entailIndex) {
    throw new Error(`cannot find an entailment label in ${JSON.stringify(labels)}`);
  }
  const idx = Number(entailIndex[0]);
  console.log(`  labels ${JSON.stringify(labels)} -- entailment is index ${idx}`);

  const entail = async (passage, question) => {
    const hypothesis = `This policy states the answer to the question: ${question}`;
    const inputs = nli.tokenizer([passage], {
      text_pair: [hypothesis], padding: true, truncation: true,
    });
    const { logits } = await nli.model(inputs);
    const row = logits.tolist()[0];
    const max = Math.max(...row);
    const exp = row.map((z) => Math.exp(z - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return exp[idx] / sum;
  };

  // The passage each question actually gets. For in-scope questions that is the
  // gold policy, which by construction does answer them; for out-of-scope
  // questions it is whatever the shipping configuration returns, which is the
  // document a user would be shown.
  const topFor = (q) => {
    const vector = store.queries[q];
    const row = rerankStore.scores[q];
    if (!vector || !row) return null;
    const pool = [];
    for (const [id, pv] of Object.entries(store.policies)) {
      const entry = kbById.get(id);
      if (!entry) continue;
      const cos = embeddings.cosine(vector, pv);
      if (cos >= dense.DEFAULT_MIN_COSINE) pool.push({ entry, cos });
    }
    pool.sort((a, b) => b.cos - a.cos || a.entry.id.localeCompare(b.entry.id));
    const shortlist = pool.slice(0, rerankModule.DEFAULT_POOL)
      .map((x) => ({ entry: x.entry, ce: row[x.entry.id] }))
      .filter((x) => x.ce !== undefined)
      .sort((a, b) => b.ce - a.ce || a.entry.id.localeCompare(b.entry.id));
    return shortlist.length ? shortlist[0].entry : null;
  };

  const inScopeCases = load('policy_queries.json').cases;
  const oos = load('out_of_scope_queries.json').cases.filter((c) => c.tier === 'hard');

  const inScope = [];
  for (const c of inScopeCases) {
    const entry = kbById.get(c.id);
    inScope.push({ q: c.q, id: c.id, p: await entail(passageText(entry), c.q) });
  }

  const hard = [];
  for (const c of oos) {
    const entry = topFor(c.q);
    if (!entry) continue;
    hard.push({ q: c.q, id: entry.id, p: await entail(passageText(entry), c.q) });
  }

  const stat = (xs) => {
    const v = xs.map((x) => x.p).sort((a, b) => a - b);
    return {
      n: v.length, min: v[0], p25: v[Math.floor(v.length * 0.25)],
      median: v[Math.floor(v.length / 2)], max: v[v.length - 1],
    };
  };
  const inStat = stat(inScope);
  const hardStat = stat(hard);

  console.log('');
  console.log(`  in-scope, gold passage    n=${inStat.n}  min ${fmt(inStat.min)}  `
    + `p25 ${fmt(inStat.p25)}  median ${fmt(inStat.median)}  max ${fmt(inStat.max)}`);
  console.log(`  hard tier, top passage    n=${hardStat.n}  min ${fmt(hardStat.min)}  `
    + `p25 ${fmt(hardStat.p25)}  median ${fmt(hardStat.median)}  max ${fmt(hardStat.max)}`);

  console.log('');
  console.log('  hard tier, lowest entailment first:');
  for (const h of hard.slice().sort((a, b) => a.p - b.p)) {
    console.log(`    ${fmt(h.p)}  ${h.id.padEnd(28)} "${h.q}"`);
  }
  console.log('');
  console.log('  in-scope, five weakest:');
  for (const x of inScope.slice().sort((a, b) => a.p - b.p).slice(0, 5)) {
    console.log(`    ${fmt(x.p)}  ${x.id.padEnd(28)} "${x.q}"`);
  }

  const threshold = inStat.min;
  const caught = hard.filter((h) => h.p < threshold);
  const margin = caught.length
    ? threshold - Math.max(...caught.map((h) => h.p))
    : 0;
  const usable = caught.length >= MIN_YIELD && margin >= MIN_MARGIN;

  console.log('');
  console.log('  VERDICT');
  console.log(`    highest threshold keeping all ${inStat.n} genuine questions: `
    + `${fmt(threshold)}`);
  console.log(`    hard-tier negatives rejected there: ${caught.length}/${hard.length} `
    + `(need ${MIN_YIELD})`);
  console.log(`    margin below the weakest genuine question: ${fmt(margin)} `
    + `(need ${MIN_MARGIN})`);
  console.log(`    fully separable: ${hardStat.max < inStat.min ? 'YES' : 'NO'}`);
  console.log('');
  console.log(usable
    ? `    USABLE -- rejects ${caught.length} with ${fmt(margin)} of margin.`
    : '    NOT usable at the declared bar. Reported, and nothing ships from it.');
  console.log('');

  fs.writeFileSync(OUT_PATH, `${JSON.stringify({
    model: nli.id,
    failed_to_load: nli.attempts,
    entail_label_index: idx,
    in_scope: inStat,
    hard_tier: hardStat,
    threshold,
    rejected: caught.length,
    margin,
    min_yield_required: MIN_YIELD,
    min_margin_required: MIN_MARGIN,
    usable,
    hard_detail: hard,
  }, null, 2)}\n`);
  console.log(`  wrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log('');
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
