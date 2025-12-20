const mongoose = require('mongoose');

const LeaveBalanceSchema = new mongoose.Schema({
  employeeId: { type: String, required: true, unique: true },
  casual_leave_balance: Number,
  sick_leave_balance: Number,
  annual_leave_balance: Number
});

module.exports = mongoose.model('LeaveBalance', LeaveBalanceSchema);