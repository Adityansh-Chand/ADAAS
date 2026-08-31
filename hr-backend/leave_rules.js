'use strict';

/**
 * Leave entitlements, transcribed from the policy corpus.
 *
 * These numbers previously existed only as seeded balances that contradicted the
 * knowledge base the same app quotes: the seed granted 5 casual days and 20
 * combined annual/sick days, while policy_003_cl says 4 per year and
 * policy_003_el_sl says 18 combined. Whichever a reviewer checked first, the
 * other was wrong.
 *
 * The corpus is the source of truth and `npm test` asserts these values still
 * match the policy text, so the two halves cannot drift apart again silently.
 *
 * Note that annual and sick leave are one shared pool in the policy -- "18 days
 * per year (Combined Annual/Earned/Sick)" -- not two. The old API reported them
 * as separate balances, which is why they could not be reconciled with the
 * policy at all.
 */

const ENTITLEMENTS = {
  casual_leave: {
    days: 4,
    maxConsecutive: 2,
    policyId: 'policy_003_cl',
    label: 'Casual Leave',
  },
  combined_annual_sick_leave: {
    days: 18,
    maxConsecutive: null,
    certificateAfterDays: 3,
    policyId: 'policy_003_el_sl',
    label: 'Annual / Earned / Sick Leave',
  },
};

/** Which pool a requested leave type draws from. */
const POOL_FOR_TYPE = {
  'Casual Leave': 'casual_leave',
  'Sick Leave': 'combined_annual_sick_leave',
  'Annual Leave': 'combined_annual_sick_leave',
};

function determineLeaveType(requestText) {
  const lower = String(requestText).toLowerCase();
  if (lower.includes('sick')) return 'Sick Leave';
  if (lower.includes('annual') || lower.includes('earned')) return 'Annual Leave';
  return 'Casual Leave';
}

/**
 * How many days the request is for.
 *
 * Returns null when the text gives no explicit count, which the caller treats as
 * a single day rather than guessing. The previous endpoint parsed nothing at
 * all, which is why it accepted "400 days of casual leave starting yesterday"
 * against a 4-day annual entitlement.
 */
function parseRequestedDays(requestText) {
  const lower = String(requestText).toLowerCase();

  const numeric = lower.match(/(\d+)\s*(?:½|\.5)?\s*(?:day|days|working day|working days)\b/);
  if (numeric) {
    const value = Number.parseInt(numeric[1], 10);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const words = {
    half: 0.5, one: 1, a: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  for (const [word, value] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\s+(?:day|days|week|weeks)\\b`).test(lower)) {
      return /week/.test(lower) ? value * 5 : value;
    }
  }

  if (/\bhalf day\b/.test(lower)) return 0.5;
  return null;
}

/**
 * Validate a request against the entitlements and the employee's remaining
 * balance. Returns `{ ok: true, ... }` or `{ ok: false, reason }`.
 */
function validateRequest({ leaveType, requestedDays, remaining }) {
  const pool = POOL_FOR_TYPE[leaveType];
  if (!pool) {
    return { ok: false, reason: `Unknown leave type "${leaveType}".` };
  }

  const rule = ENTITLEMENTS[pool];
  const days = requestedDays == null ? 1 : requestedDays;

  if (days <= 0) {
    return { ok: false, reason: 'A leave request must be for at least half a day.' };
  }

  if (rule.maxConsecutive != null && days > rule.maxConsecutive) {
    return {
      ok: false,
      reason: `${rule.label} allows a maximum of ${rule.maxConsecutive} `
        + `consecutive days at a time (${rule.policyId}); you requested ${days}.`,
    };
  }

  const available = remaining[pool];
  if (available == null) {
    return { ok: false, reason: 'No leave record found for this employee.' };
  }

  if (days > available) {
    return {
      ok: false,
      reason: `You have ${available} day(s) of ${rule.label} remaining and `
        + `requested ${days}.`,
    };
  }

  const notes = [];
  if (rule.certificateAfterDays && days > rule.certificateAfterDays) {
    notes.push(
      `A medical certificate is required for more than `
      + `${rule.certificateAfterDays} consecutive days (${rule.policyId}).`,
    );
  }

  return { ok: true, pool, days, rule, notes };
}

module.exports = {
  ENTITLEMENTS,
  POOL_FOR_TYPE,
  determineLeaveType,
  parseRequestedDays,
  validateRequest,
};
