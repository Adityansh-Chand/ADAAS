import 'dart:async';

class LeaveApplicationRepo {
  /// Simulates applying for leave via an LMS API.
  /// Returns a success message or null if failed.

  /// // --- NEW HELPER METHOD FOR TESTING ---
  // We extract the logic so we can test it instantly
  static String determineLeaveType(String requestText) {
    String lower = requestText.toLowerCase();
    if (lower.contains("sick")) {
      return "Sick Leave";
    } else if (lower.contains("annual") || lower.contains("earned")) {
      return "Annual Leave";
    }
    return "Casual Leave"; // Default
  }

  // -------------------------------------
  static Future<String?> applyForLeave(
      String employeeId, String requestText) async {
    // ignore: avoid_print
    print("Applying for leave for user: $employeeId. Request: $requestText");

    try {
      // ** SIMULATING A 1.5-SECOND NETWORK DELAY **
      await Future.delayed(const Duration(milliseconds: 1500));

      // Use the helper method here
      String leaveType = determineLeaveType(requestText);

      // ** MOCK SUCCESS RESPONSE **
      return "✅ Success! Your request for **$leaveType** has been submitted for approval. Reference ID: LMS-${DateTime.now().millisecondsSinceEpoch.toString().substring(8)}";
    } catch (e) {
      // ignore: avoid_print
      print("Leave Application Error: $e");
      return null;
    }
  }
}
