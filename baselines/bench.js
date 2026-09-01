'use strict';

/**
 * The off-the-shelf comparison.
 *
 *   npm run bench                 every variant, on the report half
 *   npm run bench -- --dev        the dev half instead
 *   npm run bench -- --only=lc    just one family
 *
 * WHY THIS EXISTS
 *
 * ADAAS was built without LangChain or LlamaIndex, because the person building it
 * did not know they existed. That is a bad reason to have made the right choice,
 * and until this file the repository had no way to tell which it was. Every
 * number in it compares ADAAS against ADAAS: lexical against dense, one reranker
 * against four others, fusion against no fusion. None of it says whether the
 * whole apparatus beats twenty lines of a framework nobody would question.
 *
 * That gap is the one that matters most for the build-versus-buy question, and it
 * is the cheapest of all the open items to close, because the harness, the
 * splits, the graded judgements and the scorer already exist. The only new thing
 * needed was a second system to put through them.
 *
 * THE COMPARISON IS DESIGNED TO BE LOSEABLE
 *
 * The point is not to win. A benchmark run by the author of one of the two
 * systems, in the author's own repository, against the author's own corpus,
 * scored by the author's own metric, has every structural advantage available and
 * is worth very little if it comes out favourable. So the variants are chosen to
 * separate the two things that could explain any gap:
 *
 *   lc-default          LangChain as its own quickstart shows: recursive
 *                       character splitting, an in-memory vector store, cosine
 *                       over all-MiniLM-L6-v2, indexing the policy answer text.
 *   lc-same-model       the same pipeline with bge-small-en-v1.5 and its required
 *                       query prefix. Isolates the embedding model.
 *   lc-same-text        also indexing the exact string ADAAS embeds, curated
 *                       keywords included. Isolates the input representation.
 *   lc-same-everything  and with chunking off. At this point the only remaining
 *                       difference from adaas-dense is LangChain's vector store
 *                       and retriever against ADAAS's.
 *   li-default          LlamaIndex out of the box.
 *   li-same-text        LlamaIndex with the ADAAS passage text.
 *   adaas-dense         the shipping dense configuration, no reranker.
 *   adaas-reranked      the shipping configuration.
 *
 * WHAT WAS PREDICTED, AND WHAT THE TABLE SAID
 *
 * The prediction written here before running it was that lc-default would lose to
 * lc-same-model, making the embedding model the explanation -- because "we picked
 * a better model" is a far smaller claim than "we built a better retriever" and
 * that seemed like the honest small claim to be left holding.
 *
 * It is not what happened, and the actual answer is smaller still.
 *
 *   1. The hand-written dense path is EXACTLY a framework default. lc-same-text,
 *      lc-same-everything, li-same-text and adaas-dense all score top-1 0.7222,
 *      recall@5 1.0000, and the LangChain rows match ADAAS's MRR to four decimals
 *      at 0.8287. Not close to it -- the same. Everything hand-written in
 *      dense.js was reproducible by twenty lines of LangChain, and the honest
 *      conclusion is that a framework would have done.
 *
 *   2. The embedding model was worth almost nothing: 0.5556 to 0.6111, one query
 *      out of eighteen, and it LOSES on nDCG@5 (0.8215 to 0.7725) and on how
 *      often the top result is relevant at all (0.8333 to 0.7222). Two rounds of
 *      this project were spent selecting bge-small over MiniLM.
 *
 *   3. What actually moved the number is the part nobody's default recipe
 *      provides: the twelve curated keywords per policy. Same framework, same
 *      model, keywords added -- 0.6111 to 0.7222. That is hand-written domain
 *      knowledge, not retrieval engineering, and it is the largest single
 *      contribution in the table.
 *
 *   4. LangChain's default chunking is a complete no-op here. 26 documents in, 26
 *      chunks out, identical scores with splitting on and off. Every policy is
 *      shorter than the 1000-character chunk size, so the step that most RAG
 *      tutorials spend their first section on does nothing on this corpus.
 *
 *   5. The one thing no framework configuration reproduced is the cross-encoder:
 *      0.7222 against 0.8333. And even that is not statistically separated at
 *      n=18 -- [-0.3889, 0.1667] spans zero, same as it does against adaas-dense.
 *
 * So the defensible claim left standing is narrow: this project's retrieval is a
 * framework default, its model selection was worth one query and cost graded
 * relevance, its measurable gains came from writing keyword lists and adding a
 * reranker, and it cannot prove the reranker helps at this sample size. That is
 * a much smaller result than the rest of this repository reads like, and it is
 * the one the numbers support.
 *
 * WHAT IS HELD IDENTICAL
 *
 * The same 18 report-half queries, the same 26 documents, the same single gold
 * label, the same top-1 / recall@5 / MRR definitions, the same nDCG@5 over the
 * same graded judgements, and the same seeded bootstrap. Nothing is re-derived
 * here: the scorer is imported from hr-backend/scripts so there is one
 * implementation and a change to it moves every system's number at once.
 *
 * A NOTE ON WHAT THE INSTALL ITSELF SHOWED
 *
 * Recorded because it is part of an honest answer to build-versus-buy, not as a
 * complaint. `npm install @langchain/community` fails outright on an unresolvable
 * peer range -- it requires @langchain/core ^1.1.38 while pulling 0.3.80 through
 * @getzep/zep-cloud -- so the community package is absent here and the embedding
 * adapter below is written against the @langchain/core interface directly.
 * MemoryVectorStore, which every LangChain tutorial imports from
 * `langchain/vectorstores/memory`, now lives in `@langchain/classic`. Getting to
 * the documented starting point took four packages and 39 transitive
 * dependencies; LlamaIndex took 96. ADAAS runs on four production dependencies.
 * That is a real cost on one side of the ledger and the measured accuracy is a
 * real cost on the other; this file exists to put numbers on the second so the
 * trade can be argued rather than asserted.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'hr-backend');

// The scorer, the bootstrap and the corpus, imported rather than reimplemented.
// A second implementation of nDCG in this file would be the single easiest way to
// make the comparison meaningless.
const bootstrap = require(path.join(BACKEND, 'scripts', 'bootstrap.js'));

const KB = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'assets', 'hr_knowledge_base.json'), 'utf8'),
);
const QUERIES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'eval', 'policy_queries.json'), 'utf8'),
);
const QRELS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'eval', 'policy_qrels.json'), 'utf8'),
);

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(4) : 'n/a');

// Part of the bge-small model contract, not a stylistic choice. Withholding it
// from the baselines would hand ADAAS an advantage unrelated to the framework.
const BGE_PREFIX = 'Represent this sentence for searching relevant passages: ';

// ---------------------------------------------------------------------------
// Scoring. One definition, used by every system.
// ---------------------------------------------------------------------------

/**
 * Per-case metrics from a ranked list of policy ids.
 *
 * Identical definitions to scripts/eval_retrieval.js: strict top-1 / recall@5 /
 * MRR against the one gold label, plus nDCG@5 with gain 2^g - 1 over the graded
 * judgements. Both scorings are kept because neither is allowed to stand in for
 * the other -- the strict one cannot be flattered by the qrels, and the graded one
 * says how much of the residual error is labelling rather than ranking.
 */
function scoreCase(ranked, goldId, query) {
  const top5 = ranked.slice(0, 5);
  const rank = top5.findIndex((id) => id === goldId);

  const grades = QRELS.judgements[query] || {};
  const gain = (id) => {
    const g = Object.prototype.hasOwnProperty.call(grades, id) ? grades[id] : 0;
    return (2 ** g) - 1;
  };
  const dcg = top5.reduce((sum, id, i) => sum + gain(id) / Math.log2(i + 2), 0);
  const ideal = Object.values(grades)
    .map((g) => (2 ** g) - 1)
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);

  return {
    top1: ranked[0] === goldId ? 1 : 0,
    recall5: rank === -1 ? 0 : 1,
    mrr: rank === -1 ? 0 : 1 / (rank + 1),
    ndcg5: ideal === 0 ? 0 : dcg / ideal,
    // Whether the top result is relevant at all, which is the answer-layer
    // question rather than the ranking one.
    topRelevant: (grades[ranked[0]] || 0) > 0 ? 1 : 0,
  };
}

function aggregate(perCase) {
  const mean = (key) => perCase.reduce((s, c) => s + c[key], 0) / perCase.length;
  return {
    n: perCase.length,
    top1: mean('top1'),
    recall5: mean('recall5'),
    mrr: mean('mrr'),
    ndcg5: mean('ndcg5'),
    topRelevant: mean('topRelevant'),
  };
}

// ---------------------------------------------------------------------------
// A LangChain Embeddings adapter over @huggingface/transformers.
// ---------------------------------------------------------------------------

let transformers = null;
async function tf() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    // The same cache the backend uses, so no model is downloaded twice and both
    // systems are demonstrably running the same weights.
    transformers.env.cacheDir = process.env.MODEL_CACHE_DIR
      || path.join(BACKEND, '.model-cache');
  }
  return transformers;
}

const { Embeddings } = require('@langchain/core/embeddings');

/**
 * Local sentence embeddings behind LangChain's Embeddings interface.
 *
 * Written here rather than imported from @langchain/community because that
 * package will not install (see the header). It is a faithful adapter and not a
 * shortcut: mean pooling then L2 normalisation, which is what
 * HuggingFaceTransformersEmbeddings does and what bge and MiniLM both expect.
 *
 * The `queryPrefix` exists because bge-small-en-v1.5 is trained with an
 * asymmetric objective and its model card asks for "Represent this sentence for
 * searching relevant passages: " on the query side only. ADAAS applies it. Not
 * applying it here would hand ADAAS an advantage that has nothing to do with the
 * framework, so the comparison would stop measuring what it claims to.
 */
class LocalEmbeddings extends Embeddings {
  constructor({ modelId, queryPrefix = '' }) {
    super({});
    this.modelId = modelId;
    this.queryPrefix = queryPrefix;
    this.extractor = null;
  }

  async ready() {
    if (!this.extractor) {
      const t = await tf();
      this.extractor = await t.pipeline('feature-extraction', this.modelId, {
        dtype: 'fp32',
      });
    }
    return this.extractor;
  }

  async embedDocuments(texts) {
    const extractor = await this.ready();
    const out = [];
    for (const text of texts) {
      const result = await extractor(text, { pooling: 'mean', normalize: true });
      out.push(Array.from(result.data));
    }
    return out;
  }

  async embedQuery(text) {
    const [vector] = await this.embedDocuments([`${this.queryPrefix}${text}`]);
    return vector;
  }
}

// ---------------------------------------------------------------------------
// The LangChain variants
// ---------------------------------------------------------------------------

const { MemoryVectorStore } = require('@langchain/classic/vectorstores/memory');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const { Document } = require('@langchain/core/documents');

/**
 * ADAAS's passage construction, imported rather than copied.
 *
 * This import is here because of a mistake worth recording. The first version of
 * this file wrote its own version of the passage text -- question, category,
 * answer, joined with ". " -- on the assumption that it matched. It did not:
 * hr-backend/scripts/build_embeddings.js also includes the twelve curated
 * KEYWORDS per policy, joined with newlines.
 *
 * So every baseline was being scored over a strictly poorer view of the corpus
 * than ADAAS, missing a hand-written signal, and the resulting table showed the
 * baselines losing by 17 points. That table was wrong, and wrong in the flattering
 * direction, which is the direction a self-run comparison is most likely to err
 * in and least likely to notice. There is now one definition and both sides
 * import it.
 */
const { policyText } = require(path.join(BACKEND, 'scripts', 'build_embeddings.js'));

/**
 * Two views of the corpus, because "out of the box" and "same input" are
 * different questions and conflating them is what went wrong above.
 *
 *   naive     the policy's own answer text, which is what a LangChain user gets
 *             from loading this JSON and reaching for `answer`. No curated
 *             keywords, because a framework does not write those for you --
 *             somebody sat down and wrote 12 per policy, and that work is not
 *             part of anybody's default recipe.
 *   adaas     the exact string ADAAS embeds. Isolates the retrieval machinery
 *             from the input representation.
 *
 * The gap between the two is the value of the curated keyword lists, measured
 * rather than assumed -- and it is measured on a framework that has no other
 * connection to them, which is a cleaner read than the ablation inside ADAAS.
 */
function documents(view) {
  return KB.map((entry) => new Document({
    pageContent: view === 'adaas'
      ? policyText(entry)
      : entry.answer,
    metadata: { id: entry.id, source: entry.source },
  }));
}

async function runLangChain({ modelId, queryPrefix, split, cases, label, view }) {
  const embeddings = new LocalEmbeddings({ modelId, queryPrefix });
  let docs = documents(view);

  let chunks = docs.length;
  if (split) {
    // The parameters LangChain's own quickstart uses. Deliberately unchanged:
    // tuning them would turn the out-of-the-box baseline into a tuned one and
    // the comparison would stop being about the default recipe.
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    docs = await splitter.splitDocuments(docs);
    chunks = docs.length;
  }

  const store = await MemoryVectorStore.fromDocuments(docs, embeddings);
  // Ten rather than five, because chunking can put several chunks of one policy
  // in the top five and collapse to fewer than five distinct documents. Taking a
  // wider list and deduplicating is what LangChain users do and what makes
  // recall@5 mean the same thing on both sides.
  const retriever = store.asRetriever({ k: 10 });

  const perCase = [];
  for (const testCase of cases) {
    const hits = await retriever.invoke(testCase.q);
    const seen = new Set();
    const ranked = [];
    for (const hit of hits) {
      const id = hit.metadata.id;
      if (seen.has(id)) continue;
      seen.add(id);
      ranked.push(id);
    }
    perCase.push(scoreCase(ranked, testCase.id, testCase.q));
  }

  return {
    label, framework: 'langchain', modelId, split, chunks, view, perCase,
  };
}

// ---------------------------------------------------------------------------
// The LlamaIndex variant
// ---------------------------------------------------------------------------

async function runLlamaIndex({ modelId, cases, label, view }) {
  const li = require('llamaindex');
  const { HuggingFaceEmbedding } = require('@llamaindex/huggingface');

  const t = await tf();
  void t; // ensures the shared cacheDir is set before LlamaIndex loads a model

  li.Settings.embedModel = new HuggingFaceEmbedding({ modelType: modelId });
  // No LLM is configured and none is needed: this measures retrieval, and asking
  // LlamaIndex for a synthesised answer would drag a vendor into a number that is
  // supposed to be reproducible from a fresh clone.
  li.Settings.llm = null;

  const docs = KB.map((entry) => new li.Document({
    text: view === 'adaas' ? policyText(entry) : entry.answer,
    id_: entry.id,
    metadata: { id: entry.id },
  }));

  const index = await li.VectorStoreIndex.fromDocuments(docs);
  const retriever = index.asRetriever({ similarityTopK: 10 });

  const perCase = [];
  for (const testCase of cases) {
    const hits = await retriever.retrieve({ query: testCase.q });
    const seen = new Set();
    const ranked = [];
    for (const hit of hits) {
      const id = (hit.node.metadata && hit.node.metadata.id) || hit.node.id_;
      if (seen.has(id)) continue;
      seen.add(id);
      ranked.push(id);
    }
    perCase.push(scoreCase(ranked, testCase.id, testCase.q));
  }

  return {
    label,
    framework: 'llamaindex',
    modelId,
    split: true,
    chunks: docs.length,
    view,
    perCase,
  };
}

// ---------------------------------------------------------------------------
// ADAAS, from its own precomputed fixtures
// ---------------------------------------------------------------------------

/**
 * The shipping configurations, scored from the committed vectors and logits.
 *
 * Read from eval/embeddings.json and eval/rerank_scores.json rather than
 * recomputed, which is how every other number in this repository is produced. It
 * makes the ADAAS side of this table identical to the one `npm run eval` prints,
 * so the comparison cannot be accused of having quietly re-run ADAAS under
 * friendlier conditions.
 */
function runAdaas({ reranked, cases, label }) {
  const { cosine } = require(path.join(BACKEND, 'embeddings.js'));
  const dense = require(path.join(BACKEND, 'dense.js'));
  const rerankModule = require(path.join(BACKEND, 'rerank.js'));

  const store = dense.loadVectors();
  const rerankStore = reranked ? rerankModule.loadScores() : null;
  const byId = new Map(KB.map((e) => [e.id, e]));

  /**
   * Dense candidates above the cosine floor, with the tiebreak the service uses.
   *
   * The floor is the part that has to be here, and the first version of this file
   * left it out. Without it the ranked list is all 26 documents in cosine order,
   * so positions two through five get filled with policies the real service would
   * never return -- and since some of them are graded 1 in the qrels, they add
   * discounted gain that the shipping system does not earn. It read as nDCG@5
   * 0.8834 against the 0.8747 `npm run eval` reports for the same configuration.
   *
   * An 87-point discrepancy in the fourth decimal is small; the reason it
   * happened is not. A comparison whose whole value rests on both systems being
   * scored identically had quietly given one of them a different retriever. The
   * floors, the pool width and the id tiebreak are all mirrored from
   * scripts/eval_retrieval.js now, and the assertion below refuses to report a
   * number that disagrees with it.
   */
  const densePool = (query, width) => {
    const vector = store.queries[query];
    if (!vector) throw new Error(`no precomputed vector for: ${query}`);
    const scored = [];
    for (const [id, policyVector] of Object.entries(store.policies)) {
      const entry = byId.get(id);
      if (!entry) continue;
      const score = cosine(vector, policyVector);
      if (score >= dense.DEFAULT_MIN_COSINE) scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, width);
  };

  const perCase = [];
  for (const testCase of cases) {
    let ranked;
    if (!rerankStore) {
      ranked = densePool(testCase.q, 5).map((c) => c.id);
    } else {
      const row = rerankStore.scores[testCase.q];
      if (!row) throw new Error(`no precomputed rerank scores for: ${testCase.q}`);
      const reorder = densePool(testCase.q, rerankModule.DEFAULT_POOL)
        .map((c) => ({ id: c.id, score: row[c.id] }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      // The logit floor gates the ANSWER rather than truncating the ranking --
      // mirroring rerank.js, where returning nothing is how the service says it
      // found no matching policy. A baseline with no such floor can never do that,
      // which is noted in the report rather than corrected for.
      ranked = (reorder.length === 0
        || reorder[0].score < rerankModule.DEFAULT_MIN_LOGIT)
        ? []
        : reorder.slice(0, 5).map((c) => c.id);
    }
    perCase.push(scoreCase(ranked, testCase.id, testCase.q));
  }

  return {
    label,
    framework: 'adaas',
    modelId: 'Xenova/bge-small-en-v1.5',
    split: false,
    chunks: KB.length,
    perCase,
  };
}

/**
 * Refuse to report ADAAS numbers that disagree with `npm run eval`.
 *
 * The one check that keeps this file honest. If the two ever diverge, the
 * comparison is scoring something other than the shipping system and every row
 * in the table below is worthless -- so it throws rather than printing.
 * Hard-coded from the published report half because that is the number a reader
 * can check against the README.
 */
const PUBLISHED = {
  'adaas-dense': { top1: 0.7222, recall5: 1.0, mrr: 0.8287, ndcg5: 0.8174 },
  'adaas-reranked': { top1: 0.8333, recall5: 1.0, mrr: 0.9074, ndcg5: 0.8747 },
};

function assertMatchesPublished(label, summary) {
  const expected = PUBLISHED[label];
  if (!expected) return;
  for (const [metric, value] of Object.entries(expected)) {
    if (Math.abs(summary[metric] - value) > 5e-4) {
      throw new Error(
        `${label} ${metric} is ${fmt(summary[metric])} here but npm run eval `
        + `reports ${value}. The two must agree or this comparison is not `
        + 'scoring the shipping system.',
      );
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const useDev = args.includes('--dev');
  const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];

  // Odd index is the report half, matching the split rule in the fixture. The
  // dev half is available for anyone wanting to tune a baseline; nothing here
  // tunes anything, which is the point of an out-of-the-box comparison.
  const cases = QUERIES.cases.filter((_, i) => (useDev ? i % 2 === 0 : i % 2 === 1));

  console.log('');
  console.log('Off-the-shelf frameworks against the shipping configuration');
  console.log('');
  console.log(`  Set B ${useDev ? 'DEV' : 'REPORT'} half, ${cases.length} queries, `
    + `${KB.length} documents`);
  console.log('  Same split, same gold labels, same graded judgements, same scorer.');
  console.log('');

  const plan = [
    // Out of the box: the recipe LangChain's own quickstart shows, over the
    // policy text a user would reach for.
    {
      key: 'lc',
      run: () => runLangChain({
        label: 'lc-default',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        queryPrefix: '',
        split: true,
        view: 'naive',
        cases,
      }),
    },
    // Same pipeline, ADAAS's embedding model. Isolates the model choice.
    {
      key: 'lc',
      run: () => runLangChain({
        label: 'lc-same-model',
        modelId: 'Xenova/bge-small-en-v1.5',
        queryPrefix: BGE_PREFIX,
        split: true,
        view: 'naive',
        cases,
      }),
    },
    // Same model AND the exact passage ADAAS embeds, keywords included.
    // Isolates the input representation.
    {
      key: 'lc',
      run: () => runLangChain({
        label: 'lc-same-text',
        modelId: 'Xenova/bge-small-en-v1.5',
        queryPrefix: BGE_PREFIX,
        split: true,
        view: 'adaas',
        cases,
      }),
    },
    // And with chunking off, which is the decisive row: at this point the only
    // remaining differences from adaas-dense are LangChain's vector store and
    // retriever against ADAAS's. If these two match, everything hand-written in
    // the dense path was replaceable by a framework default.
    {
      key: 'lc',
      run: () => runLangChain({
        label: 'lc-same-everything',
        modelId: 'Xenova/bge-small-en-v1.5',
        queryPrefix: BGE_PREFIX,
        split: false,
        view: 'adaas',
        cases,
      }),
    },
    {
      key: 'li',
      run: () => runLlamaIndex({
        label: 'li-default',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        view: 'naive',
        cases,
      }),
    },
    {
      key: 'li',
      run: () => runLlamaIndex({
        label: 'li-same-text',
        modelId: 'Xenova/bge-small-en-v1.5',
        view: 'adaas',
        cases,
      }),
    },
    { key: 'adaas', run: () => runAdaas({ label: 'adaas-dense', reranked: false, cases }) },
    { key: 'adaas', run: () => runAdaas({ label: 'adaas-reranked', reranked: true, cases }) },
  ].filter((p) => !only || p.key === only);

  const results = [];
  for (const step of plan) {
    process.stdout.write(`  running ...`);
    let result;
    try {
      result = await step.run();
    } catch (error) {
      console.log(`\r  FAILED: ${String(error.message).slice(0, 100)}`);
      continue;
    }
    const summary = aggregate(result.perCase);
    // Only reached for the ADAAS rows; a mismatch means this file is scoring
    // something other than the shipping system.
    assertMatchesPublished(result.label, summary);
    results.push({ ...result, summary });
    console.log(`\r  ${result.label.padEnd(16)} done`);
  }

  console.log('');
  console.log('  system              text    chunks  top-1     recall@5  MRR       nDCG@5    top rel.');
  for (const r of results) {
    console.log(`  ${r.label.padEnd(19)} ${String(r.view || 'adaas').padEnd(7)} `
      + `${String(r.chunks).padEnd(7)} `
      + `${fmt(r.summary.top1).padEnd(9)} ${fmt(r.summary.recall5).padEnd(9)} `
      + `${fmt(r.summary.mrr).padEnd(9)} ${fmt(r.summary.ndcg5).padEnd(9)} `
      + `${fmt(r.summary.topRelevant)}`);
  }

  // Paired differences against the shipping configuration. Paired because every
  // system answered the identical queries, which is a far tighter test than
  // comparing two independent means -- and at n=18 nothing else has a chance of
  // separating anything.
  const shipping = results.find((r) => r.label === 'adaas-reranked');
  if (shipping && results.length > 1) {
    console.log('');
    console.log('  paired difference in top-1 against adaas-reranked, 95% bootstrap CI');
    for (const r of results) {
      if (r.label === 'adaas-reranked') continue;
      const diff = bootstrap.difference(
        r.perCase.map((c) => c.top1),
        shipping.perCase.map((c) => c.top1),
      );
      const separated = diff.separated ? 'separated' : 'NOT separated';
      console.log(`  ${r.label.padEnd(19)} ${(diff.mean >= 0 ? '+' : '')}`
        + `${fmt(diff.mean)}  [${fmt(diff.lo)}, ${fmt(diff.hi)}]  ${separated}`);
    }
    console.log('');
    console.log('  An interval spanning zero means this corpus cannot tell the two');
    console.log('  apart, whichever way the point estimate leans. At n=18 that is');
    console.log('  the expected outcome for anything short of a large gap, and');
    console.log('  reporting the point estimate without the interval would be the');
    console.log('  single easiest way to overstate this comparison.');
  }

  // Where each point of the difference actually comes from. Printed rather than
  // left for a reader to derive, because the derivation is the finding and it is
  // not the flattering one.
  const at = (label) => results.find((r) => r.label === label);
  const delta = (a, b) => {
    const x = at(a);
    const y = at(b);
    if (!x || !y) return null;
    return y.summary.top1 - x.summary.top1;
  };

  console.log('');
  console.log('  WHERE THE DIFFERENCE COMES FROM, in top-1');
  const attribution = [
    ['lc-default', 'lc-same-model', 'the embedding model (bge-small over MiniLM)'],
    ['lc-same-model', 'lc-same-text', 'the 12 curated keywords per policy'],
    ['lc-same-text', 'lc-same-everything', 'turning off LangChain default chunking'],
    ['lc-same-everything', 'adaas-dense', 'ADAAS retrieval code over LangChain\'s'],
    ['adaas-dense', 'adaas-reranked', 'the cross-encoder reranker'],
  ];
  for (const [from, to, what] of attribution) {
    const d = delta(from, to);
    if (d === null) continue;
    const sign = d > 0 ? '+' : (d === 0 ? ' ' : '');
    console.log(`  ${sign}${fmt(d)}  ${what}`);
  }
  console.log('');
  console.log('  Read that column downward. The largest contribution in this');
  console.log('  project\'s retrieval is hand-written keyword lists -- domain');
  console.log('  knowledge, not retrieval engineering. The dense retrieval code');
  console.log('  contributes zero against a framework default, to four decimals');
  console.log('  and on every metric. The reranker is the only machinery here that');
  console.log('  a framework did not reproduce, and at n=18 its interval still');
  console.log('  spans zero.');

  const out = {
    about: 'Off-the-shelf RAG frameworks scored on the ADAAS splits with the '
      + 'ADAAS scorer. Written to answer the build-versus-buy question with '
      + 'numbers rather than principle. The comparison is run by the author of '
      + 'one of the systems, in that system\'s repository, against that system\'s '
      + 'corpus and metric -- every structural advantage is on the ADAAS side, '
      + 'which is why the variants are split to separate the framework from the '
      + 'embedding model from the chunking.',
    generated_by: 'cd baselines && npm run bench',
    split: useDev ? 'dev' : 'report',
    queries: cases.length,
    documents: KB.length,
    install_notes: {
      langchain_community:
        'will not install: requires @langchain/core ^1.1.38 while pulling 0.3.80 '
        + 'through @getzep/zep-cloud. The embedding adapter is written against '
        + '@langchain/core directly.',
      memory_vector_store:
        'moved out of langchain/vectorstores/memory into @langchain/classic.',
      dependency_counts: {
        adaas_production: 4,
        langchain_stack: 39,
        llamaindex_stack: 96,
      },
    },
    findings: [
      'The hand-written dense path is exactly a framework default. lc-same-text, '
      + 'lc-same-everything, li-same-text and adaas-dense all score top-1 0.7222 '
      + 'and recall@5 1.0000, and the LangChain rows match ADAAS MRR to four '
      + 'decimals at 0.8287.',
      'The embedding model was worth one query out of eighteen (0.5556 to 0.6111) '
      + 'and LOSES on nDCG@5 (0.8215 to 0.7725) and on how often the top result is '
      + 'relevant at all (0.8333 to 0.7222).',
      'The largest single contribution is the twelve curated keywords per policy: '
      + 'same framework, same model, keywords added, 0.6111 to 0.7222. That is '
      + 'hand-written domain knowledge, not retrieval engineering, and no default '
      + 'recipe provides it.',
      'LangChain default chunking is a no-op on this corpus: 26 documents in, 26 '
      + 'chunks out, identical scores with splitting on and off, because every '
      + 'policy is shorter than the 1000-character chunk size.',
      'The cross-encoder is the only component no framework configuration '
      + 'reproduced (0.7222 to 0.8333), and even it is not separated at n=18: '
      + 'the interval spans zero.',
      'A PREDICTION MADE BEFORE RUNNING THIS was that the embedding model would '
      + 'explain the gap. It did not, and the true explanation is a smaller claim '
      + 'still: keyword lists and a reranker.',
    ],
    results: results.map((r) => ({
      label: r.label,
      framework: r.framework,
      model: r.modelId,
      chunking: r.split ? 'RecursiveCharacterTextSplitter(1000, 200)' : 'one chunk per policy',
      passage_text: r.view === 'adaas' || !r.view
        ? 'question / category / keywords / answer -- the string ADAAS embeds'
        : 'the policy answer field alone, as a naive ingestion would take it',
      chunks: r.chunks,
      ...r.summary,
    })),
  };
  fs.writeFileSync(
    path.join(ROOT, 'eval', 'baselines.json'), `${JSON.stringify(out, null, 2)}\n`,
  );
  console.log('');
  console.log('  wrote eval/baselines.json');
  console.log('');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n${error.stack}\n`);
    process.exit(1);
  });
}

module.exports = { scoreCase, aggregate, LocalEmbeddings };
