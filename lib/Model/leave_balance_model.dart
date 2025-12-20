class LeaveBalanceModel {
  final int casualLeave;
  final int sickLeave;
  final int annualLeave;

  LeaveBalanceModel({
    required this.casualLeave,
    required this.sickLeave,
    required this.annualLeave,
  });

  // Add a fromJson factory if your API returns JSON
  factory LeaveBalanceModel.fromJson(Map<String, dynamic> json) {
    return LeaveBalanceModel(
      // The '?? 0' operator handles cases where the key is missing or the value is null.
      casualLeave: json['casual_leave_balance'] ?? 0,
      sickLeave: json['sick_leave_balance'] ?? 0,
      annualLeave: json['annual_leave_balance'] ?? 0,
    );
  }
}
