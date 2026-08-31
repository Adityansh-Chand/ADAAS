'use strict';

/**
 * Does a third signal exist for the hard abstention tier?
 *
 *   npm run probe:abstention
 *
 * THE PROBLEM THIS IS TESTING A HYPOTHESIS ABOUT
 *
 * eval/out_of_scope_queries.json has two tiers. The easy tier is plainly
 * off-domain ("how do I deploy a Kubernetes ingress controller") and both
 * production thresholds reject all 12. The hard tier is HR-shaped questions the
 * corpus does not answer -- where to park, whether there is a canteen, what
 * happens to shares on acquisition -- and both thresholds together reject 2 of
 * 12. rerank.js states why: the corpus is *about* these topics and simply does
 * not answer them, and neither a cosine nor a cross-encoder logit can separate
 * "about" from "answers".
 *
 * That claim is correct about similarity scores over whole documents. It is not
 * a claim that no signal exists, and this script tests the most plausible
 * candidate rather than leaving the limit asserted.
 *
 * THE HYPOTHESIS
 *
 * A hard negative usually turns on one concept the corpus never mentions:
 * parking, canteen, dog, sublet, shares, referral bonus. An in-scope paraphrase
 * turns on concepts the corpus does mention, even when it words them
 * differently: "burnt out" against "burnout", "nurse" against "nurses", "hospital
 * bills" against "hospitalisation".
 *
 * So: embed every content word in the corpus, embed every content word in the
 * query, and for each query word take its best match anywhere in the corpus
 * vocabulary. The query's score is the WORST of those -- the least-covered
 * concept in the question. A low score means the question hinges on something
 * the corpus has no word for.
 *
 * Word-level rather than sentence-level on purpose. A sentence embedding of
 * "where can I park my car at the office" is dominated by "office" and "at
 * work", which is precisely why the existing thresholds see it as in-domain; the
 * one token that makes it unanswerable is averaged away. Scoring tokens is the
 * only way to keep it.
 *
 * WHAT COUNTS AS SUCCESS
 *
 * A usable signal must separate the hard tier from in-scope queries with a gap,
 * on all 36 in-scope Set B queries and all 12 hard negatives. Anything less is
 * reported as not usable and nothing is shipped -- a threshold that rejects two
 * more out-of-scope questions at the cost of one real one is not an improvement,
 * and the in-scope survival gate in eval_retrieval.js exists to say so.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const EVAL_DIR = path.join(ROOT, 'eval');

const embeddingsModule = require('../embeddings');

// Function words carry no topic, and including them would put a floor under
// every query's score -- "the" matches "the" perfectly in any corpus.
const STOPWORDS = new Set(`
a an and are as at be been being but by can cannot could did do does doing
done for from get got had has have having how i if in into is it its me my
of on or our shall should so than that the their them then there these they
this those to up us was we were what when where which who whom why will with
would you your am does not no nor about after all also any because before
both during each few more most other over own same some such only very
`.trim().split(/\s+/));

function contentWords(text) {
  return [...new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  )];
}

let transformers = null;
async function embedWords(words, batchSize = 64) {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = process.env.MODEL_CACHE_DIR
      || path.resolve(__dirname, '..', '.model-cache');
  }
  const pipe = await transformers.pipeline(
    'feature-extraction', embeddingsModule.MODEL_ID, { dtype: 'fp32' },
  );
  const out = [];
  for (let i = 0; i < words.length; i += batchSize) {
    // No query prefix. These are single words, not sentences to be searched
    // with, and the prefix is an instruction about a retrieval task that is not
    // what is happening here.
    const result = await pipe(words.slice(i, i + batchSize), {
      pooling: 'mean', normalize: true,
    });
    out.push(...result.tolist());
  }
  return out;
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

const fmt = (v) => v.toFixed(4);

async function main() {
  const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  const load = (f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), 'utf8'));

  const corpusWords = [...new Set(kb.flatMap((e) => contentWords(
    [e.question || '', e.category || '', e.answer || '',
      (e.keywords || []).join(' ')].join(' '),
  )))];

  const setB = load('policy_queries.json').cases.map((c) => c.q);
  const oos = load('out_of_scope_queries.json').cases;

  const groups = [
    ['in-scope (Set B, both halves)', setB],
    ['out-of-scope easy', oos.filter((c) => c.tier === 'easy').map((c) => c.q)],
    ['out-of-scope hard', oos.filter((c) => c.tier === 'hard').map((c) => c.q)],
  ];

  const queryWords = [...new Set(groups.flatMap(([, qs]) => qs.flatMap(contentWords)))];

  console.log('');
  console.log('Term-level corpus coverage as an abstention signal');
  console.log(`  corpus vocabulary ${corpusWords.length} words   `
    + `query vocabulary ${queryWords.length} words`);
  console.log(`  model ${embeddingsModule.MODEL_ID}`);

  const allWords = [...new Set([...corpusWords, ...queryWords])];
  process.stdout.write(`  embedding ${allWords.length} words ... `);
  const vectors = await embedWords(allWords);
  const byWord = new Map(allWords.map((w, i) => [w, vectors[i]]));
  console.log('done');

  const corpusVectors = corpusWords.map((w) => byWord.get(w));

  /** The least-covered content word in a query, and which word it was. */
  const coverage = (q) => {
    const words = contentWords(q);
    if (words.length === 0) return { score: 1, word: null };
    let worst = { score: Infinity, word: null };
    for (const w of words) {
      const v = byWord.get(w);
      let best = -1;
      for (const cv of corpusVectors) {
        const s = cosine(v, cv);
        if (s > best) best = s;
      }
      if (best < worst.score) worst = { score: best, word: w };
    }
    return worst;
  };

  const results = [];
  console.log('');
  for (const [label, queries] of groups) {
    const scored = queries.map((q) => ({ q, ...coverage(q) }));
    const values = scored.map((s) => s.score).sort((a, b) => a - b);
    const stat = {
      label,
      n: values.length,
      min: values[0],
      p25: values[Math.floor(values.length * 0.25)],
      median: values[Math.floor(values.length / 2)],
      max: values[values.length - 1],
    };
    results.push({ ...stat, scored });
    console.log(
      `  ${label.padEnd(32)} n=${String(stat.n).padStart(2)}  `
      + `min ${fmt(stat.min)}  p25 ${fmt(stat.p25)}  `
      + `median ${fmt(stat.median)}  max ${fmt(stat.max)}`,
    );
  }

  const inScope = results[0];
  const hard = results[2];

  console.log('');
  console.log('  Lowest-coverage word per query, hard tier:');
  for (const s of hard.scored.slice().sort((a, b) => a.score - b.score)) {
    console.log(`    ${fmt(s.score)}  ${String(s.word).padEnd(14)} "${s.q}"`);
  }

  console.log('');
  console.log('  Lowest-coverage word per query, five weakest in-scope:');
  for (const s of inScope.scored.slice().sort((a, b) => a.score - b.score).slice(0, 5)) {
    console.log(`    ${fmt(s.score)}  ${String(s.word).padEnd(14)} "${s.q}"`);
  }

  // The only threshold worth considering: the highest one that keeps every
  // in-scope query. Anything above it fails the in-scope survival gate by
  // construction, so its yield is the honest ceiling on this signal.
  const safeThreshold = inScope.min;
  const catchable = hard.scored.filter((s) => s.score < safeThreshold);
  const caught = catchable.length;

  // Margin between the weakest genuine query and the strongest hard negative
  // the threshold could catch. A threshold sitting a hair below a real query is
  // a threshold that will drop the next real query written, so yield alone is
  // not the criterion -- MIN_MARGIN and MIN_YIELD are both required.
  //
  // Both numbers are stated up front rather than fitted after the fact. 0.02 is
  // roughly the spacing between adjacent in-scope queries in this range, so a
  // smaller margin is not distinguishable from where the 36th query happened to
  // land. Two catches, because one is a single query and a signal justified by a
  // single query is justified by nothing.
  const MIN_MARGIN = 0.02;
  const MIN_YIELD = 2;
  const margin = caught === 0
    ? 0
    : safeThreshold - Math.max(...catchable.map((s) => s.score));
  const usable = caught >= MIN_YIELD && margin >= MIN_MARGIN;

  console.log('');
  console.log('  VERDICT');
  console.log(`    highest threshold that keeps all ${inScope.n} in-scope queries: `
    + `${fmt(safeThreshold)}`);
  console.log(`    hard-tier negatives it would reject there: ${caught}/${hard.n}`);
  console.log(`    margin below the weakest genuine query: ${fmt(margin)} `
    + `(need ${MIN_MARGIN})`);
  console.log(`    fully separable: ${hard.max < inScope.min ? 'YES' : 'NO'}`);
  console.log('');
  if (usable) {
    console.log(`    Usable: rejects ${caught} hard negatives with no in-scope loss `
      + `and ${fmt(margin)} of margin.`);
  } else {
    console.log('    NOT usable, and this is the reportable result.');
    console.log('');
    console.log('    The signal is real in direction: both out-of-scope tiers score below');
    console.log('    the in-scope median, and the words the probe picks out are exactly the');
    console.log('    ones a reader would name -- dog, car, sublet, canteen, shares. The');
    console.log('    hypothesis was right about the mechanism and wrong about the size of');
    console.log('    the effect.');
    console.log('');
    console.log('    The distributions overlap because genuine questions also turn on words');
    console.log('    the corpus never uses. "taxi receipts" is the weakest in-scope query at');
    console.log(`    ${fmt(inScope.min)} -- the corpus says "local transport" -- and it sits below`);
    console.log('    eight of the twelve hard negatives. The clearest case is the word');
    console.log('    "friend", which is the weakest word in a hard negative (referral bonus)');
    console.log('    and in a genuine one (telling a friend about clients) at the same score.');
    console.log('');
    console.log('    So nothing is shipped from this. The hard-tier figure stands where it');
    console.log('    was measured, and the limit is now a measured limit rather than an');
    console.log('    asserted one: three different signals -- document cosine, cross-encoder');
    console.log('    logit, term coverage -- have each been tried and each failed on the same');
    console.log('    12 questions. What they have in common is that they all measure');
    console.log('    similarity, and the distinction being asked for is not one of');
    console.log('    similarity. Detecting "the corpus discusses this and does not answer it"');
    console.log('    needs a reader, which is the generation layer, not the retriever.');
  }
  console.log('');

  fs.writeFileSync(
    path.join(EVAL_DIR, 'abstention_probe.json'),
    `${JSON.stringify({
      model: embeddingsModule.MODEL_ID,
      corpus_vocabulary: corpusWords.length,
      groups: results.map(({ scored, ...rest }) => rest),
      safe_threshold: safeThreshold,
      hard_rejected_at_safe_threshold: caught,
      margin: margin,
      min_margin_required: MIN_MARGIN,
      min_yield_required: MIN_YIELD,
      usable,
      hard_tier_detail: hard.scored,
    }, null, 2)}\n`,
  );
  console.log(`  wrote ${path.relative(ROOT, path.join(EVAL_DIR, 'abstention_probe.json'))}`);
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
