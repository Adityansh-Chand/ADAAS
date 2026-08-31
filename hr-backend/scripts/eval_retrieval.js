'use strict';

/**
 * Scores policy retrieval and prints the numbers.
 *
 *   npm run eval          all methods, both eval sets, with the misses listed
 *   npm run eval:gate     the same, exiting non-zero if a gate trips (CI uses this)
 *
 * Four methods are compared on identical splits:
 *
 *   lexical    whole-phrase keyword matching, IDF-weighted, length-normalised
 *   dense      cosine over bge-small-en-v1.5 sentence embeddings
 *   hybrid     reciprocal rank fusion of the two
 *   reranked   dense, then a cross-encoder reorders its top 10
 *
 * WHAT THE NUMBERS SAID, AND WHAT WAS DONE ABOUT IT
 *
 * The configuration this replaced scored top-1 0.6111 on the Set B report half
 * against recall@5 0.9444. Those two numbers together say something specific:
 * the correct policy was almost always retrieved and then not put first. It was
 * a ranking failure, not a retrieval failure, and reading the misses confirmed
 * it -- five of seven had the gold document at rank 2 to 4, and every one of
 * those was a confusion inside a near-duplicate family (five leave types under
 * policy_003, seven medical sub-policies under policy_016).
 *
 * Two changes followed from that reading, each selected on the dev half by
 * `npm run bakeoff` and each worth about the same on the report half:
 * bge-small-en-v1.5 in place of all-MiniLM-L6-v2 (0.6111 -> 0.7222), and a
 * cross-encoder reranking stage (0.7222 -> 0.8333).
 *
 * Set A is derived from the corpus's own `question` fields and is the easiest
 * possible test -- the query was authored alongside its answer. Set B is
 * paraphrased and is the number that matters. Every score is printed, including
 * the bad ones and including cases where a more sophisticated method loses:
 * hybrid fusion still does not beat dense on its own, and lexical retrieval is
 * still near-useless on paraphrases. A comparison in which every technique
 * helped would be a comparison whose evaluation cannot fail.
 *
 * Scoring uses the precomputed vectors in eval/embeddings.json and the
 * precomputed cross-encoder logits in eval/rerank_scores.json, so this runs with
 * no model download and is deterministic. `npm run embed:verify` and
 * `npm run rerank:verify` check both still match the corpus.
 *
 * TWO SCORINGS, AND WHY BOTH
 *
 * Each Set B case names exactly one correct policy, and under that scoring
 * anything else is a miss. On a corpus with two near-duplicate families and
 * several genuinely overlapping policies that is sometimes unfair: "Can I tell a
 * friend which clients we work with?" is labelled policy_009 (Confidentiality),
 * and policy_001 (Code of Conduct) says in as many words that client data must
 * not be disclosed. A retriever that returns policy_001 has answered the
 * employee's question and scores zero.
 *
 * The single gold labels were NOT widened to fix that, because relaxing a metric
 * after seeing which cases it fails is how an evaluation stops being able to
 * fail, and because every top-1 figure reported earlier in this project would
 * stop being comparable. Instead eval/policy_qrels.json grades all 26 documents
 * per query -- 2 answers it, 1 is useful but incomplete, 0 is irrelevant -- and
 * both scorings are printed side by side:
 *
 *   strict    top-1 / recall@5 / MRR against the one gold label, gated as before
 *   graded    nDCG@5, and how often the top result is relevant at all
 *
 * Neither is allowed to stand in for the other. The graded view cannot flatter
 * the strict one, since the strict one does not read the qrels; and the strict
 * view stays the headline. The gap between them is itself the reportable
 * quantity: it says how much of the residual error is ranking and how much is
 * labelling.
 *
 * The remaining weakness is stated in the fixture and not smoothed over here:
 * the same person who tuned the retriever wrote the judgements. The guards
 * against that are the unchanged strict gates, and the assertion below that
 * every original gold is graded 2 -- so a gold cannot be quietly demoted.
 */

const fs = require('fs');
const path = require('path');

const { buildIndex, retrieve } = require('../retrieval');
const { cosine } = require('../embeddings');
const dense = require('../dense');
const rerankModule = require('../rerank');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const QUERIES_PATH = path.join(ROOT, 'eval', 'policy_queries.json');
const QRELS_PATH = path.join(ROOT, 'eval', 'policy_qrels.json');
const OUT_OF_SCOPE_PATH = path.join(ROOT, 'eval', 'out_of_scope_queries.json');

const TOP_K = 5;

// Floors, not targets, set below measured values so a real regression trips them
// and ordinary noise does not. Only the report halves are gated: the dev halves
// are what the tunables were fitted against, and gating those would be circular.
const QUALITY_GATES = {
  'lexical A/report': 0.85,
  'lexical B/report': 0.08,
  'dense A/report': 0.85,
  'dense B/report': 0.65,
  'hybrid A/report': 0.85,
  'hybrid B/report': 0.65,
  'reranked A/report': 0.85,
  'reranked B/report': 0.70,
};

// Abstention floors, on eval/out_of_scope_queries.json. Two tiers, because the
// two tiers measure different things and only one of them is achievable.
//
// The easy tier is plainly off-domain and is gated hard: anything less than all
// of them means the thresholds have drifted loose. The hard tier is HR-shaped
// questions this corpus does not answer, and the floor is set at what is
// actually achieved -- 2 of 12 -- because the other 10 are not separable by a
// similarity score at all. See the ABSTENTION note in rerank.js.
const ABSTENTION_GATES = { easy: 12, hard: 2 };

// Graded floors, on the judgements in eval/policy_qrels.json. Separate from the
// strict gates and deliberately not a substitute for them: a change that lifts
// nDCG while dropping strict top-1 has moved relevant-but-wrong documents up,
// which is not the same as answering more questions.
const GRADED_GATES = {
  'dense B/report': 0.78,
  'reranked B/report': 0.84,
};

// Every in-scope query must survive the abstention thresholds. A threshold that
// buys out-of-scope rejection by silently dropping real questions is not a
// better threshold, and this is the gate that would catch that.
const IN_SCOPE_MUST_SURVIVE = 1.0;

// Dense Set A scores 1.0000, and that number means nothing: the vectors embed
// each policy's `question` field, which IS the Set A query. It is gated only as
// a smoke test that the vectors load and align with the corpus.
const DENSE_SET_A_IS_CONTAMINATED = true;

// A lexical retriever cannot legitimately score this well on paraphrases; if it
// does, the eval queries have leaked into the keyword lists. Failing upward is
// as informative as failing downward.
const IMPLAUSIBLE_LEXICAL_B = 0.90;

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function splitByIndex(cases) {
  const dev = [];
  const report = [];
  cases.forEach((c, i) => (i % 2 === 0 ? dev : report).push(c));
  return { dev, report };
}

function scoreRanked(cases, rank) {
  let top1 = 0;
  let inTopK = 0;
  let empty = 0;
  let rrTotal = 0;
  const misses = [];

  for (const testCase of cases) {
    const ranked = rank(testCase) || [];
    if (ranked.length === 0) {
      empty += 1;
      misses.push({ q: testCase.q, want: testCase.id, got: '(nothing)', rank: -1 });
      continue;
    }
    const r = ranked.findIndex((x) => x.entry.id === testCase.id);
    if (r === 0) {
      top1 += 1;
    } else {
      misses.push({ q: testCase.q, want: testCase.id, got: ranked[0].entry.id, rank: r });
    }
    if (r >= 0) {
      inTopK += 1;
      rrTotal += 1 / (r + 1);
    }
  }

  const n = cases.length;
  return { n, top1: top1 / n, recallAtK: inTopK / n, mrr: rrTotal / n, empty, misses };
}

/**
 * Load the graded judgements and refuse to score on a fixture that does not
 * validate.
 *
 * Every check here exists because of a specific way the fixture could lie:
 *
 *   unknown query      a judgement for a query that is not in the eval set is
 *                      dead weight that looks like coverage
 *   unknown policy id  a typo'd id silently grades nothing, which reads as "the
 *                      retriever failed to return a relevant document"
 *   gold not graded 2  the one label that predates the qrels must survive them.
 *                      This is the check that stops the graded view from being
 *                      used to quietly demote an inconvenient gold
 *   unjudged query     a Set B query with no judgements would score nDCG 0 for
 *                      every method and drag the average down invisibly
 *
 * Throws rather than warning. A partially-valid relevance fixture produces
 * numbers that look fine and are not.
 */
function loadQrels(setB, kbById) {
  const raw = loadJson(QRELS_PATH);
  const byQuery = raw.judgements;
  const problems = [];
  const queryText = new Set(setB.map((c) => c.q));

  for (const [q, grades] of Object.entries(byQuery)) {
    if (!queryText.has(q)) problems.push(`judged query is not in Set B: ${JSON.stringify(q)}`);
    for (const [id, grade] of Object.entries(grades)) {
      if (!kbById.has(id)) problems.push(`judged id is not in the corpus: ${id} (${q})`);
      if (![1, 2].includes(grade)) {
        problems.push(`grade must be 1 or 2, got ${grade} for ${id} (${q})`);
      }
    }
  }
  for (const c of setB) {
    const grades = byQuery[c.q];
    if (!grades) {
      problems.push(`Set B query has no judgements: ${JSON.stringify(c.q)}`);
      continue;
    }
    if (grades[c.id] !== 2) {
      problems.push(
        `the original gold ${c.id} is graded ${grades[c.id] === undefined ? 'nothing' : grades[c.id]} `
        + `rather than 2 for ${JSON.stringify(c.q)}`,
      );
    }
  }

  if (problems.length) {
    console.error('eval/policy_qrels.json does not validate:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  return byQuery;
}

/**
 * Graded scoring: nDCG@5 plus two readings of the top result.
 *
 * Gain is 2^grade - 1, so answering (3) is worth three times as much as being
 * merely useful (1) and an irrelevant document is worth nothing. The ideal DCG
 * is computed from that query's own judgements, so a query with one relevant
 * document and a query with four are both scored out of their own achievable
 * best rather than against each other.
 *
 * `p1Relevant` is the share of queries whose top result is graded at all, and
 * `p1Answers` the share whose top result is graded 2. The pair matters: a method
 * can lift the first while leaving the second flat, which means it is surfacing
 * adjacent policies rather than answers, and that is worth seeing separately.
 */
function scoreGraded(cases, rank, qrels) {
  const gain = (g) => (2 ** g) - 1;
  const dcg = (grades) => grades
    .reduce((sum, g, i) => sum + gain(g) / Math.log2(i + 2), 0);

  let ndcgTotal = 0;
  let p1Relevant = 0;
  let p1Answers = 0;
  const rescued = [];

  for (const testCase of cases) {
    const grades = qrels[testCase.q];
    const ranked = (rank(testCase) || []).slice(0, TOP_K);
    const got = ranked.map((x) => grades[x.entry.id] || 0);

    const ideal = Object.values(grades).sort((a, b) => b - a).slice(0, TOP_K);
    const idealDcg = dcg(ideal);
    ndcgTotal += idealDcg === 0 ? 0 : dcg(got) / idealDcg;

    if (got[0] >= 1) p1Relevant += 1;
    if (got[0] === 2) p1Answers += 1;

    // Strictly wrong, graded as answering: the cases where the two scorings
    // disagree. Listing them is the point -- it is the evidence for how much of
    // the strict miss rate is a labelling artefact rather than a ranking error.
    if (ranked.length && ranked[0].entry.id !== testCase.id && got[0] === 2) {
      rescued.push({ q: testCase.q, want: testCase.id, got: ranked[0].entry.id });
    }
  }

  const n = cases.length;
  return {
    n,
    ndcg: ndcgTotal / n,
    p1Relevant: p1Relevant / n,
    p1Answers: p1Answers / n,
    rescued,
  };
}

const fmt = (v) => v.toFixed(4);

function printRow(label, r) {
  console.log(
    `  ${label.padEnd(20)} n=${String(r.n).padStart(3)}   `
    + `top-1 ${fmt(r.top1)}   recall@${TOP_K} ${fmt(r.recallAtK)}   `
    + `MRR ${fmt(r.mrr)}   nothing ${String(r.empty).padStart(2)}`,
  );
}

function printMisses(r, limit = 40) {
  for (const m of r.misses.slice(0, limit)) {
    const at = m.rank < 0 ? 'not retrieved' : `gold at rank ${m.rank}`;
    console.log(`      MISS "${m.q}"`);
    console.log(`           want ${m.want}  got ${m.got}  (${at})`);
  }
  if (r.misses.length > limit) {
    console.log(`      ... ${r.misses.length - limit} further miss(es) not listed`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const gate = args.includes('--gate');
  const verbose = args.includes('--verbose') || !gate;

  const kb = loadJson(KB_PATH);
  const queries = loadJson(QUERIES_PATH);
  const index = buildIndex(kb);
  const kbById = new Map(kb.map((e) => [e.id, e]));

  const store = dense.loadVectors();
  if (!store) {
    console.error(
      'eval/embeddings.json is missing. Run `npm run embed` in hr-backend '
      + '(requires the optional @huggingface/transformers devDependency).',
    );
    process.exit(1);
  }

  const setA = kb.filter((e) => e.question && e.id).map((e) => ({ q: e.question, id: e.id }));
  const setB = queries.cases;
  const splits = { A: splitByIndex(setA), B: splitByIndex(setB) };

  const lexicalRank = (c) => retrieve(c.q, index, { topK: TOP_K });

  // Precomputed vectors only. A query missing from the table is a bug in the
  // fixtures, not something to paper over with a live embedding call -- that
  // would make the eval non-deterministic and quietly dependent on the model.
  const denseRank = (c) => {
    const vector = store.queries[c.q];
    if (!vector) {
      throw new Error(
        `no precomputed embedding for query ${JSON.stringify(c.q)} `
        + '-- run `npm run embed`',
      );
    }
    const scored = [];
    for (const [id, policyVector] of Object.entries(store.policies)) {
      const entry = kbById.get(id);
      if (!entry) continue;
      const score = cosine(vector, policyVector);
      if (score >= dense.DEFAULT_MIN_COSINE) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return scored.slice(0, TOP_K);
  };

  const hybridRank = (c) => dense.fuse(lexicalRank(c), denseRank(c), { topK: TOP_K });

  // Reranked: dense retrieval, then the cross-encoder reorders its top pool.
  //
  // Uses the committed logits, so this stays deterministic and model-free like
  // every other method here. `rerank` is async only because the live path has to
  // be; with `precomputed` supplied it resolves without touching a model, so the
  // promise is unwrapped synchronously below via a prepared table.
  const rerankStore = rerankModule.loadScores();
  if (!rerankStore) {
    console.error(
      'eval/rerank_scores.json is missing. Run `npm run rerank:build` in '
      + 'hr-backend (requires the optional @huggingface/transformers '
      + 'devDependency).',
    );
    process.exit(1);
  }

  // Dense with no top-K cut, so the reranker sees a real pool rather than the
  // five the other methods report.
  const densePool = (c) => {
    const vector = store.queries[c.q];
    if (!vector) {
      throw new Error(
        `no precomputed embedding for query ${JSON.stringify(c.q)} `
        + '-- run `npm run embed`',
      );
    }
    const scored = [];
    for (const [id, policyVector] of Object.entries(store.policies)) {
      const entry = kbById.get(id);
      if (!entry) continue;
      const score = cosine(vector, policyVector);
      if (score >= dense.DEFAULT_MIN_COSINE) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return scored.slice(0, rerankModule.DEFAULT_POOL);
  };

  const rerankedRank = (c) => {
    const row = rerankStore.scores[c.q];
    if (!row) {
      throw new Error(
        `no precomputed rerank scores for query ${JSON.stringify(c.q)} `
        + '-- run `npm run rerank:build`',
      );
    }
    // Mirrors rerank.js exactly, including that the floor gates the answer
    // rather than filtering the list -- see the note there. If these two ever
    // disagree the eval stops measuring the service.
    const ranked = densePool(c)
      .map((x) => ({ entry: x.entry, score: row[x.entry.id], retrievalScore: x.score }))
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    if (ranked.length === 0 || ranked[0].score < rerankModule.DEFAULT_MIN_LOGIT) {
      return [];
    }
    return ranked.slice(0, TOP_K);
  };

  const methods = [
    ['lexical', lexicalRank],
    ['dense', denseRank],
    ['hybrid', hybridRank],
    ['reranked', rerankedRank],
  ];

  const results = {};
  for (const [name, rank] of methods) {
    for (const set of ['A', 'B']) {
      for (const half of ['dev', 'report']) {
        results[`${name} ${set}/${half}`] = scoreRanked(splits[set][half], rank);
      }
    }
  }

  // Graded scoring, Set B only. Set A is deliberately not judged: its queries
  // are the corpus's own question fields, so a graded view of Set A would
  // measure the same contamination the strict view already shows.
  const qrels = loadQrels(setB, kbById);
  const graded = {};
  for (const [name, rank] of methods) {
    for (const half of ['dev', 'report']) {
      graded[`${name} B/${half}`] = scoreGraded(splits.B[half], rank, qrels);
    }
  }

  console.log('');
  console.log('HR policy retrieval');
  console.log(`corpus: ${kb.length} policies    top-k: ${TOP_K}    `
    + `dense model: ${store.model}`);
  console.log(`dense min cosine: ${dense.DEFAULT_MIN_COSINE}    RRF k: ${dense.RRF_K}`);
  console.log('');
  console.log('Set A -- each policy\'s own `question` field. The easiest possible test:');
  console.log('         query and answer were authored together. The dense vectors embed');
  console.log('         that same question field, so Set A flatters dense even more than');
  console.log('         it flatters lexical. Set B is the fair comparison.');
  for (const [name] of methods) {
    printRow(`${name} A/dev`, results[`${name} A/dev`]);
    printRow(`${name} A/report`, results[`${name} A/report`]);
  }
  console.log('');
  console.log('Set B -- paraphrases avoiding the literal keywords. All answerable from');
  console.log('         the same corpus. This is the honest number.');
  for (const [name] of methods) {
    printRow(`${name} B/dev`, results[`${name} B/dev`]);
    printRow(`${name} B/report`, results[`${name} B/report`]);
  }

  console.log('');
  console.log('Set B graded -- eval/policy_qrels.json, 2 = answers it, 1 = useful but');
  console.log('         incomplete, 0 = irrelevant. nDCG@5 uses gain 2^g-1 against each');
  console.log('         query\'s own ideal ranking. "top-1 rel" is how often the first');
  console.log('         result is relevant at all; "top-1 ans" how often it answers.');
  for (const [name] of methods) {
    for (const half of ['dev', 'report']) {
      const g = graded[`${name} B/${half}`];
      console.log(
        `  ${`${name} B/${half}`.padEnd(20)} n=${String(g.n).padStart(3)}   `
        + `nDCG@${TOP_K} ${fmt(g.ndcg)}   top-1 rel ${fmt(g.p1Relevant)}   `
        + `top-1 ans ${fmt(g.p1Answers)}`,
      );
    }
  }

  if (verbose) {
    const r = graded['reranked B/report'];
    const strict = results['reranked B/report'];
    console.log('');
    console.log('Where the two scorings disagree -- reranked, Set B report half.');
    console.log(`  strict misses ${strict.misses.length}, of which `
      + `${r.rescued.length} returned a document graded 2 (it answers the question).`);
    for (const x of r.rescued) {
      console.log(`      LABEL "${x.q}"`);
      console.log(`           gold ${x.want}  returned ${x.got}  `
        + '(graded 2: also answers it)');
    }
    if (r.rescued.length === 0) {
      console.log('      none -- every strict miss is a genuine ranking error.');
    }
  }

  if (verbose) {
    console.log('');
    console.log('Set B report-half misses, by method:');
    for (const [name] of methods) {
      const r = results[`${name} B/report`];
      console.log(`\n  --- ${name} (${r.misses.length} miss(es)) ---`);
      printMisses(r);
    }
  }

  // -------------------------------------------------------------------------
  // Abstention: what the service refuses to answer.
  //
  // Scored on the `reranked` method, because that is the configured production
  // path and the one both thresholds belong to. A retriever that always returns
  // its closest guess has no way to say "no company policy covers that", and a
  // top-1 score cannot tell you whether it can.
  // -------------------------------------------------------------------------
  const outOfScope = loadJson(OUT_OF_SCOPE_PATH).cases;
  const abstention = {};
  for (const tier of ['easy', 'hard']) {
    const tierCases = outOfScope.filter((c) => c.tier === tier);
    const leaked = [];
    for (const c of tierCases) {
      const ranked = rerankedRank({ q: c.q, id: null });
      if (ranked.length > 0) leaked.push({ q: c.q, got: ranked[0].entry.id });
    }
    abstention[tier] = {
      n: tierCases.length,
      rejected: tierCases.length - leaked.length,
      leaked,
    };
  }

  // The other half of the same question: do the thresholds keep the real ones?
  const inScopeSurvivors = setB.filter((c) => rerankedRank(c).length > 0).length;
  const inScopeRate = inScopeSurvivors / setB.length;

  console.log('');
  console.log('Abstention -- out-of-scope queries that should return nothing');
  console.log(`         thresholds: cosine >= ${dense.DEFAULT_MIN_COSINE}   `
    + `rerank logit >= ${rerankModule.DEFAULT_MIN_LOGIT}`);
  for (const tier of ['easy', 'hard']) {
    const a = abstention[tier];
    console.log(`  ${tier.padEnd(6)} rejected ${a.rejected}/${a.n}`);
  }
  console.log(`  in-scope kept ${inScopeSurvivors}/${setB.length} `
    + `(both Set B halves; a threshold must not drop real questions)`);

  if (verbose && abstention.hard.leaked.length) {
    console.log('');
    console.log('  hard-tier leaks -- HR-shaped questions the corpus does not answer.');
    console.log('  These are reported, not gated away: the corpus is *about* these');
    console.log('  topics and simply does not answer them, which no similarity');
    console.log('  threshold can detect. See the ABSTENTION note in rerank.js.');
    for (const l of abstention.hard.leaked) {
      console.log(`      LEAK "${l.q}"`);
      console.log(`           returned ${l.got}`);
    }
  }

  console.log('');
  const failures = [];
  for (const [key, floor] of Object.entries(QUALITY_GATES)) {
    const actual = results[key].top1;
    const ok = actual >= floor;
    console.log(
      `  gate ${key.padEnd(20)} floor ${fmt(floor)}  actual ${fmt(actual)}  `
      + `${ok ? 'ok' : 'FAIL'}`,
    );
    if (!ok) failures.push(`${key} ${fmt(actual)} < floor ${fmt(floor)}`);
  }

  for (const [key, floor] of Object.entries(GRADED_GATES)) {
    const actual = graded[key].ndcg;
    const ok = actual >= floor;
    console.log(
      `  gate nDCG ${key.padEnd(15)} floor ${fmt(floor)}  actual ${fmt(actual)}  `
      + `${ok ? 'ok' : 'FAIL'}`,
    );
    if (!ok) failures.push(`nDCG ${key} ${fmt(actual)} < floor ${fmt(floor)}`);
  }

  for (const [tier, floor] of Object.entries(ABSTENTION_GATES)) {
    const actual = abstention[tier].rejected;
    const ok = actual >= floor;
    console.log(
      `  gate abstain ${tier.padEnd(13)} floor ${String(floor).padStart(6)}  `
      + `actual ${String(actual).padStart(6)}  ${ok ? 'ok' : 'FAIL'}`,
    );
    if (!ok) {
      failures.push(
        `abstention ${tier} rejected ${actual} < floor ${floor} `
        + '-- the thresholds have drifted loose',
      );
    }
  }
  {
    const ok = inScopeRate >= IN_SCOPE_MUST_SURVIVE;
    console.log(
      `  gate in-scope kept       floor ${fmt(IN_SCOPE_MUST_SURVIVE)}  `
      + `actual ${fmt(inScopeRate)}  ${ok ? 'ok' : 'FAIL'}`,
    );
    if (!ok) {
      failures.push(
        `in-scope survival ${fmt(inScopeRate)} < ${fmt(IN_SCOPE_MUST_SURVIVE)} `
        + '-- the abstention thresholds are dropping real questions',
      );
    }
  }

  const lexB = results['lexical B/report'].top1;
  if (lexB >= IMPLAUSIBLE_LEXICAL_B) {
    console.log(`  gate lexical B ceiling   top-1 ${fmt(lexB)} `
      + `>= ${fmt(IMPLAUSIBLE_LEXICAL_B)}  FAIL`);
    failures.push(
      `lexical B/report ${fmt(lexB)} is implausibly high for a lexical retriever `
      + '-- check whether the eval queries have leaked into the keyword lists',
    );
  }

  console.log('');
  if (gate && failures.length) {
    console.error('retrieval quality gate failed:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();
