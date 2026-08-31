const mongoose = require('mongoose');

/**
 * Days *used*, not days remaining.
 *
 * Remaining is derived from the entitlements in leave_rules.js, which are
 * transcribed from the policy corpus. Storing remaining directly is what let the
 * seeded demo data (5 casual, 20 combined) contradict the policies the same app
 * quotes (4 casual, 18 combined) with nothing to catch it.
 *
 * Annual and sick leave share one pool, matching policy_003_el_sl: "18 days per
 * year (Combined Annual/Earned/Sick)".
 */
const LeaveBalanceSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, unique: true },
  casualLeaveUsed: { type: Number, default: 0, min: 0 },
  combinedAnnualSickLeaveUsed: { type: Number, default: 0, min: 0 },
});

module.exports = mongoose.model('LeaveBalance', LeaveBalanceSchema);
