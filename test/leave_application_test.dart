import 'package:flutter_test/flutter_test.dart';
import 'package:adaas/repo/leave_application_repo.dart';

void main() {
  group('Leave Application Logic', () {
    // 1. Test Sick Leave Detection
    test('should identify "sick" leave requests', () {
      String result = LeaveApplicationRepo.determineLeaveType(
          "I need to take sick leave tomorrow");
      expect(result, equals("Sick Leave"));
    });

    // 2. Test Annual Leave Detection
    test('should identify "annual" leave requests', () {
      String result = LeaveApplicationRepo.determineLeaveType(
          "Apply for annual leave next week");
      expect(result, equals("Annual Leave"));
    });

    // 3. Test Earned Leave (Synonym for Annual)
    test('should identify "earned" leave as Annual Leave', () {
      String result =
          LeaveApplicationRepo.determineLeaveType("Requesting earned leave");
      expect(result, equals("Annual Leave"));
    });

    // 4. Test Default Case (Casual Leave)
    test('should default to Casual Leave if unspecified', () {
      String result =
          LeaveApplicationRepo.determineLeaveType("I am taking leave today");
      expect(result, equals("Casual Leave"));
    });

    // 5. Test Case Insensitivity
    test('should handle uppercase inputs', () {
      String result =
          LeaveApplicationRepo.determineLeaveType("APPLY FOR SICK LEAVE");
      expect(result, equals("Sick Leave"));
    });
  });
}
