enum HRIntent {
  leaveBalance,
  applyLeave,
  policyQuestion,
}

class IntentRouter {
  static HRIntent route(String input) {
    final lower = input.toLowerCase();

    final isLeaveBalanceRequest = lower.contains('leave balance') ||
        lower.contains('my leave') ||
        lower.contains('leave count') ||
        lower.contains('leave status');

    final isApplyLeaveRequest = lower.contains('apply sick leave') ||
        lower.contains('apply casual leave') ||
        lower.contains('apply annual leave') ||
        lower.contains('apply leave') ||
        lower.contains('apply for') ||
        (lower.contains('take') && lower.contains('leave')) ||
        (lower.contains('request') && lower.contains('leave'));

    if (isLeaveBalanceRequest) {
      return HRIntent.leaveBalance;
    }

    if (isApplyLeaveRequest) {
      return HRIntent.applyLeave;
    }

    return HRIntent.policyQuestion;
  }
}
