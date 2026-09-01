'use strict';

/**
 * Bootstrap confidence intervals for the eval scripts.
 *
 * WHY THIS EXISTS
 *
 * Every headline number in this project is computed on 18 to 36 cases. On an
 * 18-case report half one query is worth 5.6 points, so "0.8333 against 0.7778"
 * is one case, and several findings reported in the README sit inside that gap --
 * hybrid losing to dense on MRR, one reranker edging another. They were reported
 * as measured, which was correct, and read as differences, which was not.
 *
 * A confidence interval fixes the reading rather than the number. Printed beside
 * every score, it says plainly how much of the difference is resolution and how
 * much is signal, and it makes the sample size impossible to overlook -- which
 * matters more here than any individual metric, because the corpus is 26
 * documents and no amount of method work changes that.
 *
 * WHY THE PERCENTILE BOOTSTRAP
 *
 * The metrics are means over per-case scores (top-1 is a mean of 0/1, nDCG a mean
 * of per-query nDCG), and resampling cases with replacement estimates the
 * sampling distribution of that mean without assuming it is normal. A normal
 * approximation is wrong at the edges, and every interesting score here is near
 * an edge: a Wald interval around 1.0000 recall extends above 1, which is not a
 * possible value.
 *
 * The interval answers exactly one question: if a different set of queries had
 * been written in the same way, how much would this number move? It says nothing
 * about whether the queries are representative of what employees ask, which is a
 * separate and larger limitation stated in the README.
 *
 * DETERMINISTIC ON PURPOSE
 *
 * `Math.random` would make CI output differ run to run, and a gate cannot be set
 * against a number that moves on its own. mulberry32 with a fixed seed gives the
 * same interval on every machine, so a changed interval means changed data.
 */

const RESAMPLES = 2000;
const SEED = 0x9e3779b9;

/** mulberry32 -- small, fast, and good enough for resampling indices. */
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

/**
 * Percentile bootstrap over per-case scores.
 *
 * `perCase` is one number per evaluation case -- 1 or 0 for top-1, a fraction for
 * nDCG. Returns the 95% interval of their mean, and the half-width, which is the
 * number worth quoting: "0.8333 +/- 0.17" makes the resolution obvious in a way
 * that a bracket does not.
 */
function interval(perCase, { resamples = RESAMPLES, seed = SEED } = {}) {
  const n = perCase.length;
  if (n === 0) return { lo: 0, hi: 0, half: 0, n: 0 };

  const random = rng(seed);
  const means = new Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += perCase[Math.floor(random() * n)];
    }
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);

  const lo = means[Math.floor(resamples * 0.025)];
  const hi = means[Math.min(resamples - 1, Math.floor(resamples * 0.975))];
  const mean = perCase.reduce((a, b) => a + b, 0) / n;
  return { lo, hi, half: Math.max(hi - mean, mean - lo), n };
}

/**
 * Do two measurements on the SAME cases differ?
 *
 * Paired, because the alternative -- comparing two independent intervals and
 * checking whether they overlap -- is both wrong and conservative here. Two
 * methods are scored on identical queries, so their errors are correlated: a
 * query that is hard for one is usually hard for the other. Resampling the
 * per-case DIFFERENCES cancels that shared difficulty and is far more sensitive
 * than comparing the two intervals by eye.
 *
 * Returns the interval of the difference. If it contains zero, the two methods
 * are not distinguishable on this many cases -- which is a real and reportable
 * finding, not a failure to measure.
 */
function difference(perCaseA, perCaseB, options = {}) {
  if (perCaseA.length !== perCaseB.length) {
    throw new Error('paired bootstrap needs the same cases on both sides');
  }
  const deltas = perCaseA.map((a, i) => a - perCaseB[i]);
  const ci = interval(deltas, options);
  return { ...ci, mean: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    separated: (ci.lo > 0 && ci.hi > 0) || (ci.lo < 0 && ci.hi < 0) };
}

/** "0.8333 [0.6667, 0.9444]" */
function format(mean, ci) {
  return `${mean.toFixed(4)} [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]`;
}

module.exports = { RESAMPLES, SEED, interval, difference, format };
