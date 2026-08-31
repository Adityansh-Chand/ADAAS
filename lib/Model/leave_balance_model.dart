/// A leave balance, expressed as remaining against entitlement.
///
/// The API used to report three independent balances -- casual, sick and annual
/// -- which could not be reconciled with the policy corpus at all, because
/// policy_003_el_sl grants "18 days per year (Combined Annual/Earned/Sick)": one
/// shared pool, not two. Showing remaining alongside the entitlement it came
/// from is what makes the number checkable against the policy the same app
/// quotes.
class LeaveBalanceModel {
  final int casualRemaining;
  final int casualEntitlement;
  final int combinedRemaining;
  final int combinedEntitlement;

  const LeaveBalanceModel({
    required this.casualRemaining,
    required this.casualEntitlement,
    required this.combinedRemaining,
    required this.combinedEntitlement,
  });

  factory LeaveBalanceModel.fromJson(Map<String, dynamic> json) {
    final entitlements = json['entitlements'];
    final entitlementMap =
        entitlements is Map ? entitlements.cast<String, dynamic>() : const {};

    return LeaveBalanceModel(
      casualRemaining: _asInt(json['casual_leave_balance']),
      casualEntitlement: _asInt(entitlementMap['casual_leave']),
      combinedRemaining: _asInt(json['combined_annual_sick_leave_balance']),
      combinedEntitlement:
          _asInt(entitlementMap['combined_annual_sick_leave']),
    );
  }

  /// Tolerates missing keys, nulls, and numbers arriving as strings or doubles.
  static int _asInt(Object? value) {
    if (value is int) return value;
    if (value is double) return value.round();
    if (value is String) return int.tryParse(value) ?? 0;
    return 0;
  }

  int get casualUsed => (casualEntitlement - casualRemaining).clamp(0, 1 << 30);
  int get combinedUsed =>
      (combinedEntitlement - combinedRemaining).clamp(0, 1 << 30);
}
