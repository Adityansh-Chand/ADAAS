import 'dart:async';
import 'package:dio/dio.dart';
// Import the file where LeaveBalanceModel is defined
import 'package:adaas/Model/leave_balance_model.dart';
import 'package:adaas/services/app_config.dart';

class LeaveApiRepo {
  /// Fetches the user's leave balance from the HR REST API.
  static Future<LeaveBalanceModel?> fetchLeaveBalance(String userId) async {
    // ignore: avoid_print
    print("Attempting to fetch leave balance for user: $userId");

    try {
      // ============================================================
      // OPTION 1: MOCK DATA (Commented out for now)
      // ============================================================
      /*
      await Future.delayed(const Duration(seconds: 1));
      final mockData = {
        "casual_leave_balance": 5,
        "sick_leave_balance": 8,
        "annual_leave_balance": 12
      };
      return LeaveBalanceModel.fromJson(mockData);
      */

      // ============================================================
      // OPTION 2: REAL API CALL (Active)
      // ============================================================

      final dio = Dio();

      final apiUrl =
          '${AppConfig.hrApiBaseUrl}/leave-balance?employee_id=$userId';

      // ignore: avoid_print
      print("Calling Real API: $apiUrl");

      final response = await dio.get(apiUrl);

      if (response.statusCode == 200) {
        // ignore: avoid_print
        print("API Response: ${response.data}");
        return LeaveBalanceModel.fromJson(response.data);
      } else {
        // ignore: avoid_print
        print("API Error: ${response.statusCode}");
        return null;
      }
    } catch (e) {
      // ignore: avoid_print
      print("Leave API Error: $e");
      return null;
    }
  }
}
