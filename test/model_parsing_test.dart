import 'package:adaas/Model/leave_balance_model.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('LeaveBalanceModel parsing', () {
    test('parses remaining and entitlement', () {
      final model = LeaveBalanceModel.fromJson(const {
        'employee_id': '1001',
        'entitlements': {
          'casual_leave': 4,
          'combined_annual_sick_leave': 18,
        },
        'used': {'casual_leave': 1, 'combined_annual_sick_leave': 3},
        'casual_leave_balance': 3,
        'combined_annual_sick_leave_balance': 15,
      });

      expect(model.casualRemaining, 3);
      expect(model.casualEntitlement, 4);
      expect(model.combinedRemaining, 15);
      expect(model.combinedEntitlement, 18);
      expect(model.casualUsed, 1);
      expect(model.combinedUsed, 3);
    });

    test('defaults to 0 for missing keys rather than throwing', () {
      final model = LeaveBalanceModel.fromJson(const {
        'casual_leave_balance': 3,
      });

      expect(model.casualRemaining, 3);
      expect(model.casualEntitlement, 0);
      expect(model.combinedRemaining, 0);
      expect(model.combinedEntitlement, 0);
    });

    test('handles nulls, doubles and numeric strings', () {
      final model = LeaveBalanceModel.fromJson(const {
        'entitlements': {'casual_leave': '4', 'combined_annual_sick_leave': 18.0},
        'casual_leave_balance': null,
        'combined_annual_sick_leave_balance': 15.4,
      });

      expect(model.casualRemaining, 0);
      expect(model.casualEntitlement, 4);
      expect(model.combinedRemaining, 15);
      expect(model.combinedEntitlement, 18);
    });

    test('used never goes negative when the API is inconsistent', () {
      // Remaining above entitlement should not produce a negative "used".
      final model = LeaveBalanceModel.fromJson(const {
        'entitlements': {'casual_leave': 4, 'combined_annual_sick_leave': 18},
        'casual_leave_balance': 9,
        'combined_annual_sick_leave_balance': 99,
      });

      expect(model.casualUsed, 0);
      expect(model.combinedUsed, 0);
    });
  });
}
