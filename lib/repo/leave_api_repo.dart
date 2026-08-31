import 'dart:async';
import 'package:adaas/Model/leave_balance_model.dart';
import 'package:adaas/services/app_config.dart';
import 'package:adaas/services/http_client.dart';
import 'package:dio/dio.dart';

/// Outcome of a leave-balance lookup.
sealed class LeaveBalanceResult {
  const LeaveBalanceResult();
}

class LeaveBalanceLoaded extends LeaveBalanceResult {
  final LeaveBalanceModel balance;

  const LeaveBalanceLoaded(this.balance);
}

class LeaveBalanceUnavailable extends LeaveBalanceResult {
  final String reason;

  const LeaveBalanceUnavailable(this.reason);
}

class LeaveApiRepo {
  static Future<LeaveBalanceResult> fetchLeaveBalance(
    String employeeId, {
    Dio? client,
    String? baseUrl,
  }) async {
    final dio = client ?? HrHttpClient.create();
    final root = baseUrl ?? AppConfig.hrApiBaseUrl;

    try {
      final response = await dio.get(
        '$root/leave-balance',
        queryParameters: {'employee_id': employeeId},
      );

      final status = response.statusCode ?? 0;
      final body = response.data;

      if (status == 200 && body is Map<String, dynamic>) {
        return LeaveBalanceLoaded(LeaveBalanceModel.fromJson(body));
      }

      if (status == 404) {
        return const LeaveBalanceUnavailable(
            'HR has no leave record for this employee');
      }

      if (status == 401 || status == 403) {
        return const LeaveBalanceUnavailable(
            'this app is not authorised to read leave balances');
      }

      return LeaveBalanceUnavailable(
          'the HR service returned an unexpected response (status $status)');
    } catch (error) {
      return LeaveBalanceUnavailable(HrHttpClient.describe(error));
    }
  }
}
