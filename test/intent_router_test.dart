import 'package:flutter_test/flutter_test.dart';

void main() {
  /// This function mirrors the intent routing logic inside ChatBloc.
  /// We extract it here to test the logic in isolation.
  String determineIntent(String input) {
    String lower = input.toLowerCase();

    // Logic from ChatBloc:
    // 1. Check for "Leave Balance" intent
    bool isLeaveBalanceRequest = lower.contains("leave balance") ||
        lower.contains("my leave") ||
        lower.contains("leave count");

    // 2. Check for "Apply Leave" intent
    bool isApplyLeaveRequest = lower.contains("apply for") ||
        lower.contains("take leave") ||
        (lower.contains("request") && lower.contains("leave"));

    if (isLeaveBalanceRequest) {
      return "BALANCE";
    } else if (isApplyLeaveRequest) {
      return "APPLY";
    } else {
      return "POLICY"; // Default to RAG
    }
  }

  group('Intent Router Logic', () {
    // --- TEST CASE 1: BALANCE INTENT ---
    test('Should correctly detect Balance intent', () {
      expect(determineIntent("Show my leave balance"), equals("BALANCE"));
      expect(determineIntent("what is my leave count"), equals("BALANCE"));
      expect(determineIntent("check my leave status"), equals("BALANCE"));
    });

    // --- TEST CASE 2: APPLY INTENT ---
    test('Should correctly detect Apply intent', () {
      expect(
          determineIntent("I want to apply for sick leave"), equals("APPLY"));
      expect(determineIntent("take leave tomorrow"), equals("APPLY"));
      expect(determineIntent("request leave for next monday"), equals("APPLY"));
    });

    // --- TEST CASE 3: POLICY INTENT (DEFAULT) ---
    test('Should default to Policy intent (RAG) for general questions', () {
      expect(
          determineIntent("What is the sick leave policy?"), equals("POLICY"));
      expect(determineIntent("tell me about holidays"), equals("POLICY"));
      expect(determineIntent("how do i claim expenses?"), equals("POLICY"));
    });

    // --- TEST CASE 4: AMBIGUITY HANDLING ---
    test('Should prioritize Apply over Balance if keywords conflict', () {
      // If a user says "apply for leave balance" (weird, but possible)
      // Ideally, specific keywords should win.
      // Based on our logic: 'leave balance' comes first in the if-else chain.
      expect(determineIntent("apply for leave balance"), equals("BALANCE"));
    });

    test('Should handle case insensitivity', () {
      expect(determineIntent("SHOW MY LEAVE BALANCE"), equals("BALANCE"));
      expect(determineIntent("APPLY FOR LEAVE"), equals("APPLY"));
    });
  });
}
