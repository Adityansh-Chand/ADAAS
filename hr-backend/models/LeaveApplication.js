const mongoose = require('mongoose');

const LeaveApplicationSchema = new mongoose.Schema(
  {
    employeeId: { type: String, required: true, index: true },
    leaveType: { type: String, required: true },
    requestText: { type: String, required: true },
    referenceId: { type: String, required: true, unique: true },
    days: { type: Number, required: true, min: 0.5 },
    status: {
      type: String,
      enum: ['submitted', 'approved', 'rejected'],
      default: 'submitted',
    },
    // Who decided, and when. Without these an application could only ever be
    // `submitted`, which is what it was before the decision endpoint existed.
    decidedBy: { type: String },
    decidedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeaveApplication', LeaveApplicationSchema);
