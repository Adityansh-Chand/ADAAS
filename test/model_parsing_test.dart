import 'package:flutter_test/flutter_test.dart';
import 'package:adaas/Model/leave_balance_model.dart';

void main() {
  group('LeaveBalanceModel Parsing', () {
    // 1. Happy Path: JSON is perfect
    test('should parse valid JSON correctly', () {
      final json = {
        "casual_leave_balance": 5,
        "sick_leave_balance": 8,
        "annual_leave_balance": 12
      };

      final model = LeaveBalanceModel.fromJson(json);

      expect(model.casualLeave, 5);
      expect(model.sickLeave, 8);
      expect(model.annualLeave, 12);
    });

    // 2. Edge Case: JSON has missing keys (Null safety check)
    // Your factory uses '?? 0', so it should default to 0, not crash.
    test('should default to 0 if keys are missing', () {
      final json = {
        "casual_leave_balance": 5,
        // sick_leave_balance is missing
        // annual_leave_balance is missing
      };

      final model = LeaveBalanceModel.fromJson(json);

      expect(model.casualLeave, 5);
      expect(model.sickLeave, 0); // Default
      expect(model.annualLeave, 0); // Default
    });

    // 3. Edge Case: JSON has null values
    test('should handle null values gracefully', () {
      final json = {
        "casual_leave_balance": null,
        "sick_leave_balance": 10,
        "annual_leave_balance": null
      };

      final model = LeaveBalanceModel.fromJson(json);

      expect(model.casualLeave, 0);
      expect(model.sickLeave, 10);
      expect(model.annualLeave, 0);
    });
  });
}
