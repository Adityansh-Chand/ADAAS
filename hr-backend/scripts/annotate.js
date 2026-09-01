'use strict';

/**
 * Blind relevance annotation, and the agreement statistics for a second opinion.
 *
 *   npm run annotate           print a blank annotation sheet
 *   npm run annotate -- --agree eval/policy_qrels.second.json
 *
 * WHY THIS EXISTS AND WHAT IT CANNOT DO
 *
 * eval/policy_qrels.json grades all 26 documents against each of the 36 Set B
 * queries, and the README lists its weakness as the highest-value open item: the
 * judgements were written by the person who tuned the retriever, who had already
 * seen which cases the eval printed as misses. That is the definition of a
 * conflicted annotator.
 *
 * This does not fix that, and nothing written by the same party can. What it
 * removes is every OTHER excuse for not getting a second opinion: the sheet, the
 * blinding, the ordering, and the arithmetic all exist now, so producing a second
 * set of judgements is an afternoon of reading rather than a project.
 *
 * WHAT "BLIND" MEANS HERE, CONCRETELY
 *
 * The sheet an annotator receives has, per row, a query and a policy -- and
 * nothing else. Specifically it does NOT carry:
 *
 *   - the policy id, which is a strong hint: policy_003_cl next to a question
 *     about casual leave answers itself
 *   - the existing grade from policy_qrels.json, which would anchor the second
 *     annotator to the first
 *   - the single gold label from policy_queries.json, same reason
 *   - any retrieval score, rank or position, which is the specific contamination
 *     the first set could not avoid
 *
 * Pairs are shuffled with a fixed seed, so consecutive rows are not the same
 * query and the annotator cannot infer "this is the fifth document for this
 * question, so it is probably the irrelevant one". The seed is fixed so two
 * annotators get the same sheet and their rows can be compared directly.
 *
 * WHY IT IS NOT ALL 936 PAIRS
 *
 * 36 queries x 26 documents is 936 judgements, almost all of them obviously
 * irrelevant, and an annotator asked for 936 will produce careless work by row
 * 200. The sheet therefore covers the pairs where a judgement is actually
 * contested: every document either side already grades non-zero, plus every
 * document in the same near-duplicate family as one of those, plus a fixed
 * sample of the rest so the sheet is not composed entirely of near-misses. The
 * sampled remainder is what makes disagreement about "obviously irrelevant"
 * measurable rather than assumed.
 *
 * AGREEMENT
 *
 * `--agree` reads a second file in the same shape and reports raw agreement,
 * Cohen's kappa on the three-way grade, and -- the number that matters for this
 * project -- how the two sets differ on the pairs that decide a metric. Kappa
 * corrects for the agreement two annotators would reach by chance, which on a
 * sheet dominated by zeroes is most of it; raw agreement alone would read as
 * 0.95 and mean nothing.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const KB_PATH = path.join(ROOT, 'assets', 'hr_knowledge_base.json');
const EVAL_DIR = path.join(ROOT, 'eval');
const QRELS_PATH = path.join(EVAL_DIR, 'policy_qrels.json');
const SHEET_PATH = path.join(EVAL_DIR, 'annotation_sheet.json');
// The row -> (query, policy id) mapping. Deliberately a SEPARATE file: the row
// key on the sheet used to be `${query} ${id}`, which put the policy id in front
// of the annotator on every line and undid the blinding the rest of this script
// goes to trouble to arrange. An id like policy_003_cl beside a question about
// casual leave answers the question by itself. The annotator gets the sheet; the
// key stays behind and is only read when scoring agreement.
const KEY_PATH = path.join(EVAL_DIR, 'annotation_key.json');

const SEED = 0x5f3759df;
const SAMPLE_PER_QUERY = 4;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Policies sharing a `policy_003` / `policy_016` style prefix. */
function family(id) {
  const m = /^(policy_\d+)/.exec(id);
  return m ? m[1] : id;
}

function buildSheet() {
  const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  const queries = JSON.parse(
    fs.readFileSync(path.join(EVAL_DIR, 'policy_queries.json'), 'utf8'),
  ).cases;
  const qrels = JSON.parse(fs.readFileSync(QRELS_PATH, 'utf8')).judgements;
  const random = rng(SEED);
  const byId = new Map(kb.map((e) => [e.id, e]));

  const pairs = [];
  for (const c of queries) {
    const graded = Object.keys(qrels[c.q] || {});
    const families = new Set(graded.map(family));
    const contested = new Set(graded);
    for (const e of kb) if (families.has(family(e.id))) contested.add(e.id);

    const rest = shuffle(kb.map((e) => e.id).filter((id) => !contested.has(id)), random)
      .slice(0, SAMPLE_PER_QUERY);

    for (const id of [...contested, ...rest]) {
      const entry = byId.get(id);
      pairs.push({
        // Filled in below with an opaque id. Nothing identifying the document
        // travels on the row itself -- this used to be the query and the policy
        // id joined together, which printed `policy_003_cl` next to a question
        // about casual leave and undid the blinding on every line.
        row: null,
        query: c.q,
        policy: `${entry.question}\n${entry.answer}`,
        grade: null,
        _id: id,
      });
    }
  }

  const shuffled = shuffle(pairs, random);
  const key = {};
  shuffled.forEach((p, i) => {
    p.row = `r${String(i + 1).padStart(4, '0')}`;
    key[p.row] = { query: p.query, id: p._id };
    delete p._id;
  });

  return {
    key,
    sheet: {
    about: 'Blind relevance annotation sheet. Fill in `grade` on every row: '
      + '2 = this document answers the question, 1 = useful but incomplete, '
      + '0 = not relevant. Do not consult eval/policy_qrels.json, and do not run '
      + 'the retriever -- the point of a second opinion is that it is formed '
      + 'without either. Save as eval/policy_qrels.second.json and run '
      + '`npm run annotate -- --agree eval/policy_qrels.second.json`.',
    rubric: {
      2: 'Answers it. A reader given only this document would have what they asked for.',
      1: 'Useful but incomplete: addresses the topic, does not contain the fact asked for.',
      0: 'Not relevant.',
    },
    blinding: 'Policy ids, existing grades, gold labels and retrieval scores are '
      + 'all withheld, and rows are shuffled with a fixed seed so consecutive '
      + 'rows are not the same query.',
    seed: SEED,
    pairs: shuffled,
    },
  };
}

function kappa(a, b) {
  // Cohen's kappa over the three grades. Raw agreement on a sheet that is mostly
  // zeroes reads high no matter what, so the chance correction is the whole
  // point of quoting this rather than the percentage.
  const labels = [0, 1, 2];
  const n = a.length;
  let observed = 0;
  for (let i = 0; i < n; i += 1) if (a[i] === b[i]) observed += 1;
  observed /= n;

  let expected = 0;
  for (const l of labels) {
    const pa = a.filter((x) => x === l).length / n;
    const pb = b.filter((x) => x === l).length / n;
    expected += pa * pb;
  }
  return { observed, expected, kappa: (observed - expected) / (1 - expected) };
}

function reportAgreement(secondPath) {
  const mine = JSON.parse(fs.readFileSync(QRELS_PATH, 'utf8')).judgements;
  if (!fs.existsSync(KEY_PATH)) {
    console.error(`no ${path.relative(ROOT, KEY_PATH)} -- run \`npm run annotate\` `
      + 'to build the sheet and its key together');
    process.exit(1);
  }
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const second = JSON.parse(fs.readFileSync(secondPath, 'utf8'));
  const rows = second.pairs || second;

  const a = [];
  const b = [];
  const disagreements = [];
  for (const row of rows) {
    if (row.grade === null || row.grade === undefined) continue;
    // Resolved through the key, which the annotator never saw. The row itself
    // carries an opaque id precisely so the identity of the document could not
    // travel with it.
    const entry = key[row.row];
    if (!entry) {
      console.error(`row ${row.row} is not in ${path.relative(ROOT, KEY_PATH)} `
        + '-- the sheet and the key are from different runs of `npm run annotate`');
      process.exit(1);
    }
    const { query, id } = entry;
    const ours = (mine[query] || {})[id] || 0;
    const theirs = Number(row.grade);
    a.push(ours);
    b.push(theirs);
    if (ours !== theirs) disagreements.push({ query, id, ours, theirs });
  }

  if (a.length === 0) {
    console.error('no graded rows found in the second sheet');
    process.exit(1);
  }

  const k = kappa(a, b);
  console.log('');
  console.log(`Agreement over ${a.length} judged pairs`);
  console.log(`  raw agreement   ${k.observed.toFixed(4)}`);
  console.log(`  expected by chance ${k.expected.toFixed(4)}`);
  console.log(`  Cohen's kappa   ${k.kappa.toFixed(4)}`);
  console.log('');
  console.log('  Kappa reads roughly: below 0.40 poor, 0.40-0.60 moderate,');
  console.log('  0.60-0.80 substantial, above 0.80 near-identical. Anything in the');
  console.log('  first two bands means the graded metrics carry annotator noise of');
  console.log('  the same size as the differences they are being used to detect,');
  console.log('  and nDCG should be reported with that stated.');
  console.log('');

  // The disagreements that would actually move a score: a document one annotator
  // calls the answer and the other calls irrelevant.
  const severe = disagreements.filter((d) => Math.abs(d.ours - d.theirs) === 2);
  console.log(`  disagreements ${disagreements.length}, of which `
    + `${severe.length} are 2-vs-0 -- one annotator's answer is the other's `
    + 'irrelevant');
  for (const d of severe.slice(0, 20)) {
    console.log(`      ${d.id.padEnd(28)} ours ${d.ours} theirs ${d.theirs}  "${d.query}"`);
  }
  console.log('');
}

function main() {
  const args = process.argv.slice(2);
  const agreeAt = args.indexOf('--agree');
  if (agreeAt !== -1) {
    const file = args[agreeAt + 1];
    if (!file) {
      console.error('--agree needs a path to the second annotator\'s file');
      process.exit(1);
    }
    reportAgreement(path.resolve(ROOT, file));
    return;
  }

  const { key, sheet } = buildSheet();
  fs.writeFileSync(SHEET_PATH, `${JSON.stringify(sheet, null, 2)}\n`);
  fs.writeFileSync(KEY_PATH, `${JSON.stringify(key, null, 2)}\n`);
  console.log('');
  console.log(`wrote ${path.relative(ROOT, SHEET_PATH)}`);
  console.log(`  and ${path.relative(ROOT, KEY_PATH)} -- the annotator does NOT get this`);
  console.log(`  ${sheet.pairs.length} pairs to judge, from `
    + '36 queries x 26 documents = 936 possible');
  console.log('  Policy ids, existing grades and retrieval output are all withheld.');
  console.log('');
  console.log('  Hand it to someone who has not tuned the retriever, then:');
  console.log('    npm run annotate -- --agree eval/policy_qrels.second.json');
  console.log('');
}

main();
