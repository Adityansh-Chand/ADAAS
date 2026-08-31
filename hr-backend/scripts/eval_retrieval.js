'use strict';

/**
 * Scores policy retrieval against both eval sets and prints the numbers.
 *
 * Run with `npm run eval`. Add `--gate` to make it exit non-zero when a score
 * falls below the floors in QUALITY_GATES, which is how CI uses it.
 *
 * Set A is derived from the corpus's own `question` fields and is the easiest
 * possible test. Set B is paraphrased and is the number that matters. Both are
 * printed always, including when Set B is bad -- a lexical retriever is
 * expected to struggle on paraphrases, and hiding that would defeat the point
 * of having the harness.
 */

const fs = require('fs');
const path = require('path');

const { buildIndex, retrieve } = require('../retrieval');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const QUERIES_PATH = path.join(ROOT, 'eval', 'policy_queries.json');

// Floors, not targets. Set deliberately below current measured values so a real
// regression trips them and ordinary noise does not. The Set B floor is low
// because lexical retrieval genuinely cannot do much better on paraphrases;
// raising it would mean fitting to the reporting half.
const QUALITY_GATES = {
  'A/report': 0.85,
  'B/report': 0.08,
};

// A score this high on paraphrases would mean the eval set had leaked into the
// keyword lists. Failing upward is as informative as failing downward.
const IMPLAUSIBLE_B_TOP1 = 0.90;

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function splitByIndex(cases) {
  const dev = [];
  const report = [];
  cases.forEach((c, i) => (i % 2 === 0 ? dev : report).push(c));
  return { dev, report };
}

function score(cases, index, topK) {
  let top1 = 0;
  let inTopK = 0;
  let empty = 0;
  let reciprocalRankTotal = 0;
  const misses = [];

  for (const testCase of cases) {
    const ranked = retrieve(testCase.q, index, { topK });
    if (ranked.length === 0) {
      empty += 1;
      misses.push({ q: testCase.q, want: testCase.id, got: '(nothing)', rank: -1 });
      continue;
    }
    const rank = ranked.findIndex((r) => r.entry.id === testCase.id);
    if (rank === 0) {
      top1 += 1;
    } else {
      misses.push({
        q: testCase.q,
        want: testCase.id,
        got: ranked[0].entry.id,
        rank,
      });
    }
    if (rank >= 0) {
      inTopK += 1;
      reciprocalRankTotal += 1 / (rank + 1);
    }
  }

  const n = cases.length;
  return {
    n,
    top1: top1 / n,
    recallAtK: inTopK / n,
    mrr: reciprocalRankTotal / n,
    empty,
    misses,
  };
}

function fmt(value) {
  return value.toFixed(4);
}

function printSet(label, result, { showMisses }) {
  console.log(
    `  ${label.padEnd(16)} n=${String(result.n).padStart(3)}   ` +
    `top-1 ${fmt(result.top1)}   recall@k ${fmt(result.recallAtK)}   ` +
    `MRR ${fmt(result.mrr)}   returned-nothing ${result.empty}`,
  );
  if (showMisses && result.misses.length) {
    for (const miss of result.misses) {
      const at = miss.rank < 0 ? 'not retrieved' : `gold at rank ${miss.rank}`;
      console.log(`      MISS "${miss.q}"`);
      console.log(`           want ${miss.want}  got ${miss.got}  (${at})`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const gate = args.includes('--gate');
  const verbose = args.includes('--verbose') || !gate;
  const topK = 5;

  const kb = loadJson(KB_PATH);
  const queries = loadJson(QUERIES_PATH);
  const index = buildIndex(kb);

  // Set A: every policy's own question, labelled with its own id.
  const setA = kb
    .filter((entry) => entry.question && entry.id)
    .map((entry) => ({ q: entry.question, id: entry.id }));
  const setB = queries.cases;

  const aSplit = splitByIndex(setA);
  const bSplit = splitByIndex(setB);

  const results = {
    'A/dev': score(aSplit.dev, index, topK),
    'A/report': score(aSplit.report, index, topK),
    'B/dev': score(bSplit.dev, index, topK),
    'B/report': score(bSplit.report, index, topK),
  };

  console.log('');
  console.log('HR policy retrieval -- lexical baseline');
  console.log(`corpus: ${kb.length} policies    top-k: ${topK}`);
  console.log('');
  console.log('Set A -- each policy\'s own `question` field (easiest possible test;');
  console.log('         query and answer were authored together)');
  printSet('A/dev', results['A/dev'], { showMisses: false });
  printSet('A/report', results['A/report'], { showMisses: verbose });
  console.log('');
  console.log('Set B -- paraphrases avoiding the literal keywords (the honest test;');
  console.log('         all answerable from the same corpus)');
  printSet('B/dev', results['B/dev'], { showMisses: false });
  printSet('B/report', results['B/report'], { showMisses: verbose });
  console.log('');

  const failures = [];
  for (const [key, floor] of Object.entries(QUALITY_GATES)) {
    const actual = results[key].top1;
    const ok = actual >= floor;
    console.log(
      `  gate ${key.padEnd(16)} floor ${fmt(floor)}  actual ${fmt(actual)}  ` +
      `${ok ? 'ok' : 'FAIL'}`,
    );
    if (!ok) failures.push(`${key} ${fmt(actual)} < floor ${fmt(floor)}`);
  }

  if (results['B/report'].top1 >= IMPLAUSIBLE_B_TOP1) {
    console.log(
      `  gate B/report ceiling   top-1 ${fmt(results['B/report'].top1)} ` +
      `>= ${fmt(IMPLAUSIBLE_B_TOP1)}  FAIL`,
    );
    failures.push(
      `B/report top-1 ${fmt(results['B/report'].top1)} is implausibly high for ` +
      'a lexical retriever -- check whether the eval queries have leaked into ' +
      'the keyword lists',
    );
  }

  console.log('');

  if (gate && failures.length) {
    console.error('retrieval quality gate failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
}

main();
