'use strict';

/**
 * Cross-encoder reranking over already-retrieved candidates.
 *
 * WHY A RERANKER, SPECIFICALLY
 *
 * The measured problem was never that the right policy was not being found. On
 * the Set B paraphrases the previous configuration scored top-1 0.6111 against
 * recall@5 0.9444: for five of every six queries it missed, the correct policy
 * had already been retrieved and was sitting in second or third place. That is a
 * ranking failure, not a retrieval failure, and 33 points of top-1 were parked
 * in the gap between the two numbers.
 *
 * A bi-encoder cannot close that gap by getting better. It compresses a document
 * into one 384-dimensional vector before it has ever seen the query, so two
 * documents on the same topic at the same granularity land near each other by
 * construction. This corpus is built from exactly that: 12 of its 26 documents
 * belong to two near-duplicate families -- five leave types under policy_003 and
 * seven medical sub-policies under policy_016. Separating "casual leave, 4 days,
 * urgent errands" from "LWP, comp-off, emergency leave" needs a scorer that
 * reads the query and the document together. That is what a cross-encoder is.
 *
 * WHICH RERANKER, AND WHAT LOST
 *
 * `npm run bakeoff` measured four on the Set B dev half. Three made it worse:
 *
 *   no reranking (baseline)                 top-1 0.7778   MRR 0.8657
 *   mixedbread-ai/mxbai-rerank-xsmall-v1    top-1 0.8333   MRR 0.9167
 *   Xenova/ms-marco-MiniLM-L-6-v2           top-1 0.7222   MRR 0.8472
 *   Xenova/ms-marco-MiniLM-L-12-v2          top-1 0.7222   MRR 0.8380
 *   jinaai/jina-reranker-v1-tiny-en         top-1 0.6111   MRR 0.7519
 *
 * The two ms-marco cross-encoders are the usual default recommendation and both
 * lost to doing nothing. They are trained on web-search passages; short,
 * formally-worded internal policy statements are out of domain for them. This is
 * reported rather than quietly dropped, because "we added a reranker and it
 * helped" is a much weaker claim than "we measured four, three hurt, and here is
 * the one that did not".
 *
 * RERANKING NEVER ADDS A RESULT
 *
 * It only reorders what retrieval already returned. If dense retrieval found
 * nothing above its cosine floor, this stage has nothing to reorder and the
 * service still answers "no matching policy" -- the ability to say that honestly
 * is a property worth keeping, and a reranker asked to score all 26 documents
 * would destroy it by always producing a best guess.
 */

const fs = require('fs');
const path = require('path');

const modelClient = require('./model_client');

const MODEL_ID = 'mixedbread-ai/mxbai-rerank-xsmall-v1';

// Candidates handed to the cross-encoder. Measured, not guessed: the ablation in
// `npm run bakeoff` scored a pool of 10 and a pool of 26 -- the whole corpus,
// which is small enough to afford -- and they came out identical (top-1 0.8889,
// MRR 0.9444 both ways). The retriever's top 10 already contains everything the
// reranker would pick, so the larger pool buys nothing and costs 2.6x the
// forward passes.
const DEFAULT_POOL = 10;

// ABSTENTION
//
// Below this top logit, the reranker is saying nothing it was shown answers the
// question, and the service reports no matching policy rather than its closest
// guess.
//
// The two signals are complementary, which is why both are applied rather than
// either alone. They fail on different queries: "how do I deploy a Kubernetes
// ingress controller" scores 0.4898 cosine -- above four in-scope queries -- but
// -3.58 here; "what is the weather forecast for tomorrow" scores -2.19 here,
// above four in-scope queries, but only 0.4164 cosine. Requiring both, at
// cosine >= 0.42 and logit >= -2.8, keeps all 18 in-scope Set B dev queries and
// rejects 12 of 12 easy out-of-scope probes. Either threshold alone rejects
// fewer.
//
// WHAT THIS CANNOT DO, MEASURED
//
// eval/out_of_scope_queries.json has a second tier of 12 HR-shaped questions
// about things this corpus genuinely does not contain. Both thresholds together
// reject 2 of those 12. The old MiniLM configuration also rejected 2 of 12, so
// this is not a regression introduced by the new model -- it is a limit of the
// approach. "How many days of paternity leave does the law require" scores 0.78
// cosine and +1.11 here, higher than most genuine queries, because the corpus
// does have a paternity leave policy. It just does not state what the law
// requires.
//
// No similarity threshold can fix that, because the distinction is not one of
// similarity: the corpus is *about* the topic and simply does not *answer* the
// question. Separating those two is the generation layer's job -- saying "the
// policy covers paternity leave but does not address statutory minimums" --
// which is why llm.js is given the retrieved text and told what it may conclude
// from it, rather than retrieval being asked to make a judgement it has no
// information to make.
const DEFAULT_MIN_LOGIT = -2.8;

const DEFAULT_SCORES_PATH = path.resolve(
  __dirname, '..', 'eval', 'rerank_scores.json',
);

let modelPromise = null;

class RerankerUnavailable extends Error {
  constructor(cause) {
    super(
      'Reranking requires the optional @huggingface/transformers package, '
      + 'which is a devDependency and is not installed in production images. '
      + 'Unlike the corpus vectors, cross-encoder scores cannot be precomputed '
      + 'for arbitrary queries -- the model has to see the query and the '
      + 'document together. Set RETRIEVAL_MODE=dense to retrieve without '
      + 'reranking.',
    );
    this.name = 'RerankerUnavailable';
    this.cause = cause;
  }
}

/**
 * The document text the cross-encoder scores.
 *
 * Includes the `question` field. Also measured rather than assumed -- the
 * ablation scored both, and question+answer beat answer-only by 0.0556 top-1 and
 * 0.0277 MRR on the dev half. The question field is corpus-authored metadata
 * that reads like a heading, and the Set B paraphrases were written to avoid its
 * literal wording, so this is not the same contamination that makes Set A
 * meaningless. It does mean Set A is flattered even further, which it already
 * was beyond usefulness.
 */
function passageText(entry) {
  return [entry.question || '', entry.category || '', entry.answer || '']
    .filter(Boolean)
    .join('. ');
}

async function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      let transformers;
      try {
        transformers = await import('@huggingface/transformers');
      } catch (error) {
        throw new RerankerUnavailable(error);
      }
      transformers.env.cacheDir = process.env.MODEL_CACHE_DIR
        || path.resolve(__dirname, '.model-cache');

      const [tokenizer, model] = await Promise.all([
        transformers.AutoTokenizer.from_pretrained(MODEL_ID),
        transformers.AutoModelForSequenceClassification.from_pretrained(
          MODEL_ID, { dtype: 'fp32' },
        ),
      ]);
      return { tokenizer, model };
    })();
  }
  return modelPromise;
}

/**
 * Score one query against many passages. Returns raw logits.
 *
 * The logits are unbounded and not calibrated, so they are usable for ordering
 * and nothing else. Nothing here converts them to a "confidence" -- the previous
 * generation of this codebase renamed a retrieval score to "confidence" and that
 * is exactly the move being avoided.
 */
async function scorePairs(query, passages) {
  if (passages.length === 0) return [];

  // Same decision as embeddings.js: when a model service is configured it is the
  // only source, and no local fallback is attempted. See model_client.js for why
  // failing over silently would be worse than failing.
  if (modelClient.serviceUrl()) {
    return modelClient.rerankScores(query, passages);
  }

  const { tokenizer, model } = await getModel();
  const inputs = tokenizer(passages.map(() => query), {
    text_pair: passages,
    padding: true,
    truncation: true,
  });
  const { logits } = await model(inputs);
  return logits.tolist().map((row) => row[0]);
}

/**
 * Reorder retrieved candidates.
 *
 * `candidates` is the retriever's output: `[{ entry, score }]`. Returns the same
 * shape with `score` replaced by the cross-encoder logit and `retrievalScore`
 * preserved, so a caller can still see what the first stage thought.
 *
 * `precomputed` lets the eval run without downloading a model: a map of
 * policy id -> logit for this query. When a candidate is missing from it, that
 * is a fixture bug and it throws rather than silently falling back to a live
 * model call, which would make the eval non-deterministic.
 */
async function rerank(query, candidates, {
  pool = DEFAULT_POOL,
  minLogit = DEFAULT_MIN_LOGIT,
  precomputed = null,
} = {}) {
  if (!candidates || candidates.length === 0) return [];

  const shortlist = candidates.slice(0, pool);
  let scores;

  if (precomputed) {
    scores = shortlist.map((c) => {
      const score = precomputed[c.entry.id];
      if (score === undefined) {
        throw new Error(
          `no precomputed rerank score for ${JSON.stringify(query)} / `
          + `${c.entry.id} -- run \`npm run rerank:build\``,
        );
      }
      return score;
    });
  } else {
    scores = await scorePairs(query, shortlist.map((c) => passageText(c.entry)));
  }

  const ranked = shortlist
    .map((c, i) => ({
      entry: c.entry,
      score: scores[i],
      retrievalScore: c.score,
    }))
    // Tie-break on id so the order is total and the eval is reproducible.
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  // THE FLOOR GATES THE ANSWER, IT DOES NOT FILTER THE LIST
  //
  // This used to be `.filter(c => c.score >= minLogit)` before the sort, and the
  // difference is not stylistic. Since the emptiness condition is identical --
  // every candidate below the floor is the same statement as the highest
  // candidate being below it -- abstention behaviour is unchanged, exactly. What
  // changed is what happens on the queries that are answered: filtering also
  // deleted sub-floor documents from ranks 2 to 5, which cost recall@5 for
  // nothing. It was measurable: reranked recall@5 on the Set B dev half was
  // 0.9444 with the filter and 1.0000 without it, on identical scores.
  //
  // The floor is answering "is the best thing I found worth showing at all". It
  // was never answering "should this document be visible as a third source",
  // and using one threshold for both questions silently made the service worse
  // at the one it was not meant for.
  if (ranked.length === 0 || ranked[0].score < minLogit) return [];
  return ranked;
}

/** Committed cross-encoder scores for the eval queries, or null if absent. */
function loadScores(file = DEFAULT_SCORES_PATH) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data.scores) return null;
  return data;
}

/** Is the optional package present? Does not load the model. */
function isAvailable() {
  // A configured model service counts as available -- that is the whole point of
  // it. Before this, the production image had no local package and therefore
  // reported reranking unavailable even when a service was running beside it.
  return modelClient.activeSource() !== 'none';
}

module.exports = {
  MODEL_ID,
  DEFAULT_POOL,
  DEFAULT_MIN_LOGIT,
  RerankerUnavailable,
  passageText,
  scorePairs,
  rerank,
  loadScores,
  isAvailable,
};
