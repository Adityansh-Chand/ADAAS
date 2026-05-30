import 'package:adaas/services/intent_router.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Intent Router Logic', () {
    test('should correctly detect balance intent', () {
      expect(IntentRouter.route("Show my leave balance"),
          equals(HRIntent.leaveBalance));
      expect(IntentRouter.route("what is my leave count"),
          equals(HRIntent.leaveBalance));
      expect(IntentRouter.route("check my leave status"),
          equals(HRIntent.leaveBalance));
    });

    test('should correctly detect apply intent', () {
      expect(IntentRouter.route("I want to apply for sick leave"),
          equals(HRIntent.applyLeave));
      expect(IntentRouter.route("take leave tomorrow"),
          equals(HRIntent.applyLeave));
      expect(IntentRouter.route("request leave for next monday"),
          equals(HRIntent.applyLeave));
    });

    test('should default to policy intent for general questions', () {
      expect(IntentRouter.route("What is the sick leave policy?"),
          equals(HRIntent.policyQuestion));
      expect(IntentRouter.route("tell me about holidays"),
          equals(HRIntent.policyQuestion));
      expect(IntentRouter.route("how do i claim expenses?"),
          equals(HRIntent.policyQuestion));
    });

    test('should prioritize balance when keywords conflict', () {
      expect(IntentRouter.route("apply for leave balance"),
          equals(HRIntent.leaveBalance));
    });

    test('should handle case insensitivity', () {
      expect(IntentRouter.route("SHOW MY LEAVE BALANCE"),
          equals(HRIntent.leaveBalance));
      expect(
          IntentRouter.route("APPLY FOR LEAVE"), equals(HRIntent.applyLeave));
    });
  });
}
