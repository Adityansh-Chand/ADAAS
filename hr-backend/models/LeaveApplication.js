const mongoose = require('mongoose');

const LeaveApplicationSchema = new mongoose.Schema(
  {
    employeeId: { type: String, required: true, index: true },
    leaveType: { type: String, required: true },
    requestText: { type: String, required: true },
    referenceId: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['submitted', 'approved', 'rejected'],
      default: 'submitted',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeaveApplication', LeaveApplicationSchema);
