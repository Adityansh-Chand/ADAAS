'use strict';

/**
 * Lexical retrieval over the HR policy corpus.
 *
 * This replaces a scorer that had four measurable faults:
 *
 *   1. Substring matching, so the keyword `cl` (casual leave) fired inside
 *      `clients`, `claim` and `include`, and `el` fired inside `help` and
 *      `travel`.
 *   2. A category boost applied by substring, so the category `IT` scored +2 on
 *      any message containing the letters "it" -- in `entitled`, `submit`,
 *      `with`, and inside the category words `security` and `exit`.
 *   3. Raw hit counts, so a policy with 12 keywords had three times the surface
 *      area of one with 4.
 *   4. No weighting for how discriminating a keyword is, so `remote work` --
 *      claimed by two different policies -- counted the same as a keyword
 *      unique to one.
 *
 * The replacement is whole-phrase matching with IDF weighting and length
 * normalisation. It is still lexical, and it is still expected to do badly on
 * paraphrased queries: that is the honest finding, not a defect to hide. Run
 * `npm run eval` to see both numbers.
 */

// Function words that must never act as retrieval evidence. `it` is on this
// list specifically because it is also a category name in the corpus.
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'anything',
  'are', 'as', 'at', 'be', 'been', 'before', 'being', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'each', 'for', 'from',
  'get', 'give', 'got', 'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'many', 'may',
  'me', 'might', 'more', 'most', 'much', 'must', 'my', 'need', 'no', 'not',
  'of', 'on', 'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own',
  'please', 'said', 'same', 'she', 'should', 'so', 'some', 'still', 'such',
  'take', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'to', 'too', 'under', 'up', 'us', 'use',
  'very', 'want', 'was', 'we', 'well', 'were', 'what', 'when', 'where',
  'whether', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your',
]);

// Tunables, swept against the DEV half of eval/policy_queries.json only. The
// report half was never used to pick a value. Measured effects are recorded
// against each knob so a later change can be compared rather than guessed at;
// two of these turned out to do nothing and are kept at their measured-neutral
// values rather than deleted, because this corpus is also a retrieval bench and
// "we tried it and it did not help" is a result worth keeping.
const DEFAULTS = {
  // Weight on the curated keyword list. The primary signal.
  keywordWeight: 1.0,

  // Content-word overlap with a policy's own `question` field.
  //
  // Deliberately 0. Measured on dev: no effect on Set B top-1 at any value from
  // 0.15 to 1.5, and +1 query of Set B recall@5. That is not worth the cost,
  // which is that Set A stops being a measurement at all -- Set A's queries ARE
  // the question fields, so indexing them means scoring a test against its own
  // answer key. Keeping this at 0 is what lets Set A stay honest.
  questionWeight: 0.0,

  // Exact whole-word category match. Measured neutral on both sets: natural
  // queries rarely contain a bare category name, and Set A's are already solved
  // by keywords. Retained at a modest value because it is defensible on other
  // corpora; note it earns nothing here.
  categoryWeight: 0.6,

  // Multi-word phrases are more specific than single words. Measured neutral on
  // both sets at every value tried (0 to 1.5).
  phraseLengthBonus: 0.5,

  // Length normalisation. This one matters: at 0, policies with long keyword
  // lists dominate and Set A top-1 drops from 1.0000 to 0.9231. Any value at or
  // above 0.25 recovers it. This is the fix for the old scorer's raw hit count.
  lengthNormExponent: 0.5,

  // Minimum score to be returned at all.
  //
  // MUST stay above zero. Setting it to 0 looked like an improvement -- Set B
  // dev top-1 rose 0.1111 -> 0.1667 and recall@5 0.1111 -> 0.3333 -- but
  // inspecting the scores showed why: on most paraphrases every policy scores
  // exactly 0.000, so the sort falls through to its `localeCompare` tiebreak and
  // `policy_001` is returned for everything. The gain was alphabetical luck, not
  // retrieval. A query with no lexical evidence must return nothing so the
  // caller can honestly say no policy was found.
  minScore: 0.05,
};

function normaliseWhitespace(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9&\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Crude plural stripping. Enough for `clients` -> `client`, `leaves` -> `leave`. */
function stem(word) {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

function contentWords(text) {
  return normaliseWhitespace(text)
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w) && w.length > 1)
    .map(stem);
}

/**
 * Whole-phrase containment against a normalised query.
 *
 * The query is normalised to space-delimited tokens, so wrapping both sides in
 * spaces makes every match word-bounded. This is the single change that removes
 * fault (1) above -- `cl` now matches only a standalone "cl".
 */
function containsPhrase(paddedQuery, phrase) {
  const normalised = normaliseWhitespace(phrase);
  if (!normalised) return false;
  return paddedQuery.includes(` ${normalised} `);
}

function buildIndex(kb, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const total = kb.length;

  const keywordDf = new Map();
  const wordDf = new Map();

  for (const entry of kb) {
    const seenKeywords = new Set(
      (entry.keywords || []).map((k) => normaliseWhitespace(k)).filter(Boolean),
    );
    for (const k of seenKeywords) {
      keywordDf.set(k, (keywordDf.get(k) || 0) + 1);
    }
    const seenWords = new Set(contentWords(entry.question || ''));
    for (const w of seenWords) {
      wordDf.set(w, (wordDf.get(w) || 0) + 1);
    }
  }

  const idf = (df) => Math.log((total + 1) / (df + 0.5));

  const documents = kb.map((entry) => {
    const keywords = [...new Set(
      (entry.keywords || []).map((k) => normaliseWhitespace(k)).filter(Boolean),
    )];
    const questionWords = [...new Set(contentWords(entry.question || ''))];
    const category = normaliseWhitespace(entry.category || '');
    const categoryUsable = Boolean(category) && !category.split(' ')
      .every((part) => STOPWORDS.has(part));

    return {
      entry,
      keywords,
      questionWords,
      category,
      categoryUsable,
      // Length normaliser: how much surface area this policy has to match on.
      norm: Math.pow(
        Math.max(1, keywords.length),
        config.lengthNormExponent,
      ),
    };
  });

  return { config, documents, keywordDf, wordDf, idf, total };
}

function scoreDocument(paddedQuery, queryWords, doc, index) {
  const { config, keywordDf, wordDf, idf } = index;
  let score = 0;
  const matchedKeywords = [];

  for (const keyword of doc.keywords) {
    if (!containsPhrase(paddedQuery, keyword)) continue;
    const words = keyword.split(' ').length;
    const bonus = 1 + (words - 1) * config.phraseLengthBonus;
    score += config.keywordWeight * idf(keywordDf.get(keyword) || 1) * bonus;
    matchedKeywords.push(keyword);
  }

  if (doc.categoryUsable && containsPhrase(paddedQuery, doc.category)) {
    score += config.categoryWeight * idf(1);
  }

  const querySet = new Set(queryWords);
  for (const word of doc.questionWords) {
    if (!querySet.has(word)) continue;
    score += config.questionWeight * idf(wordDf.get(word) || 1);
  }

  return { score: score / doc.norm, matchedKeywords };
}

/**
 * Rank policies for a query. Returns entries in descending score order,
 * excluding anything below `minScore`.
 */
function retrieve(query, index, { topK = 5 } = {}) {
  const paddedQuery = ` ${normaliseWhitespace(query)} `;
  const queryWords = contentWords(query);

  const scored = index.documents
    .map((doc) => {
      const { score, matchedKeywords } = scoreDocument(
        paddedQuery, queryWords, doc, index,
      );
      return { entry: doc.entry, score, matchedKeywords };
    })
    .filter((item) => item.score >= index.config.minScore)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  return scored.slice(0, topK);
}

module.exports = {
  STOPWORDS,
  DEFAULTS,
  buildIndex,
  retrieve,
  contentWords,
  containsPhrase,
  normaliseWhitespace,
  stem,
};
