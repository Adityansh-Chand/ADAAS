'use strict';

/**
 * Scores policy retrieval and prints the numbers.
 *
 *   npm run eval          all methods, both eval sets, with the misses listed
 *   npm run eval:gate     the same, exiting non-zero if a gate trips (CI uses this)
 *
 * Three methods are compared on identical splits:
 *
 *   lexical   whole-phrase keyword matching, IDF-weighted, length-normalised
 *   dense     cosine over MiniLM sentence embeddings
 *   hybrid    reciprocal rank fusion of the two
 *
 * Set A is derived from the corpus's own `question` fields and is the easiest
 * possible test -- the query was authored alongside its answer. Set B is
 * paraphrased and is the number that matters. Every score is printed, including
 * the bad ones and including cases where a more sophisticated method loses. A
 * comparison in which every technique helped would be a comparison whose
 * evaluation cannot fail.
 *
 * Dense scoring uses the precomputed vectors in eval/embeddings.json, so this
 * runs with no model download and is deterministic. `npm run embed:verify`
 * checks those vectors still match the corpus.
 */

const fs = require('fs');
const path = require('path');

const { buildIndex, retrieve } = require('../retrieval');
const { cosine } = require('../embeddings');
const dense = require('../dense');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const QUERIES_PATH = path.join(ROOT, 'eval', 'policy_queries.json');

const TOP_K = 5;

// Floors, not targets, set below measured values so a real regression trips them
// and ordinary noise does not. Only the report halves are gated: the dev halves
// are what the tunables were fitted against, and gating those would be circular.
const QUALITY_GATES = {
  'lexical A/report': 0.85,
  'lexical B/report': 0.08,
  'dense A/report': 0.85,
  'dense B/report': 0.50,
  'hybrid A/report': 0.85,
  'hybrid B/report': 0.50,
};

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

  const methods = [['lexical', lexicalRank], ['dense', denseRank], ['hybrid', hybridRank]];

  const results = {};
  for (const [name, rank] of methods) {
    for (const set of ['A', 'B']) {
      for (const half of ['dev', 'report']) {
        results[`${name} ${set}/${half}`] = scoreRanked(splits[set][half], rank);
      }
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

  if (verbose) {
    console.log('');
    console.log('Set B report-half misses, by method:');
    for (const [name] of methods) {
      const r = results[`${name} B/report`];
      console.log(`\n  --- ${name} (${r.misses.length} miss(es)) ---`);
      printMisses(r);
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
