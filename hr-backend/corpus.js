'use strict';

/**
 * Governance for the policy corpus: who owns it, when it was last checked, and
 * whether it still matches what this repository thinks it is.
 *
 * WHY THIS IS WORTH CODE RATHER THAN A PARAGRAPH
 *
 * A retrieval score that drops is visible in an eval. A policy statement that
 * went out of date eighteen months ago retrieves perfectly and is still wrong,
 * and nothing in this repository would notice -- every test asserts internal
 * consistency, which a stale corpus satisfies completely.
 *
 * So the parts that CAN be checked mechanically are checked here, and the part
 * that cannot -- whether the text is true of a real employer -- is stated as
 * unverifiable rather than implied to be handled.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_META_PATH = path.resolve(
  __dirname, '..', 'assets', 'hr_knowledge_base.meta.json',
);

/**
 * The same digest scripts/build_embeddings.js commits, computed the same way:
 * SHA-256 over the serialised corpus, first 16 hex characters.
 *
 * It must be byte-identical in method, not merely similar. The first version of
 * this hashed `[id, question, answer]` triples instead of the whole entry, which
 * produced a different value from the one in eval/embeddings.json -- so the
 * governance file and the vector file would each have been internally consistent
 * and disagreed with each other, which is exactly the class of drift this check
 * exists to catch. A test asserts the two agree.
 *
 * Deliberately duplicated rather than imported: the point is to confirm that two
 * independently maintained files agree about the corpus, and a shared helper both
 * called would keep agreeing even if the helper itself were wrong.
 */
function digestOf(kb) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(kb))
    .digest('hex')
    .slice(0, 16);
}

function loadMeta(file = DEFAULT_META_PATH) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Validate the corpus against its declared schema, and the metadata against the
 * corpus. Returns a list of problems; empty means it validates.
 *
 * Every check corresponds to a way the corpus could go wrong without any test
 * failing:
 *
 *   missing field     an entry with no `answer` retrieves and returns nothing
 *   duplicate id      two entries with one id -- the second wins in kbById and the
 *                     first becomes unreachable while still occupying a vector
 *   unknown category  the category is part of the text the cross-encoder scores,
 *                     so a typo degrades retrieval invisibly. The list is closed
 *                     for that reason.
 *   empty source      the citation shown to the user comes from here; an empty
 *                     one renders as "Source: " and looks like a bug
 *   digest mismatch   the corpus was edited and the governance file was not, so
 *                     the review date now refers to different text
 */
function validate(kb, meta) {
  const problems = [];
  if (!meta) return ['no hr_knowledge_base.meta.json -- the corpus has no governance record'];

  const { required, categories } = meta.schema;
  const seen = new Set();

  for (const entry of kb) {
    const label = entry.id || '(entry with no id)';
    for (const field of required) {
      const value = entry[field];
      const empty = value === undefined || value === null || value === ''
        || (Array.isArray(value) && value.length === 0);
      if (empty) problems.push(`${label}: missing or empty ${field}`);
    }
    if (seen.has(entry.id)) problems.push(`${entry.id}: duplicate id`);
    seen.add(entry.id);
    if (entry.category && !categories.includes(entry.category)) {
      problems.push(
        `${label}: category ${JSON.stringify(entry.category)} is not in the declared list`,
      );
    }
  }

  const digest = digestOf(kb);
  if (meta.content_digest !== digest) {
    problems.push(
      `content_digest is ${meta.content_digest} but the corpus hashes to ${digest} `
      + '-- the corpus changed and the governance record did not, so last_reviewed '
      + 'refers to different text',
    );
  }

  return problems;
}

/**
 * Governance status, for GET /health and the eval banner.
 *
 * `review_overdue` is reported and NOT gated. A build that turns red because a
 * date passed fails on a pull request that did not touch the corpus, for a reason
 * unconnected to the change, and the predictable outcome is that someone disables
 * the check. Reporting it puts it in front of a reader on every run; failing on it
 * puts it in front of nobody after the first month.
 *
 * `owner` reads UNASSIGNED on purpose. An invented name would read as
 * accountability while providing none.
 */
function status(kb, metaPath = DEFAULT_META_PATH) {
  const meta = loadMeta(metaPath);
  if (!meta) return { governed: false, reason: 'no metadata file' };

  const lastReviewed = new Date(meta.review.last_reviewed);
  const ageDays = Math.floor((Date.now() - lastReviewed.getTime()) / 86400000);
  const overdue = ageDays > meta.review.cadence_days;

  return {
    governed: true,
    version: meta.corpus_version,
    entries: kb.length,
    digest_matches: meta.content_digest === digestOf(kb),
    owner: meta.owner.name,
    owner_assigned: meta.owner.name !== 'UNASSIGNED',
    last_reviewed: meta.review.last_reviewed,
    review_age_days: ageDays,
    cadence_days: meta.review.cadence_days,
    review_overdue: overdue,
    // The part no code can check, said every time rather than once in a file
    // somebody has to go and open.
    provenance: 'synthetic demonstration content; not any organisation\'s real policy',
  };
}

module.exports = { DEFAULT_META_PATH, digestOf, loadMeta, validate, status };
