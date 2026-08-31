import 'dart:async';
import 'package:adaas/services/app_config.dart';
import 'package:adaas/services/http_client.dart';
import 'package:dio/dio.dart';

/// Outcome of trying to file a leave application.
///
/// This is a sealed type on purpose. Submitting leave is the only write this app
/// performs, and there must be no path from "the request failed" to a value that
/// looks like a confirmation. Previously the repo answered every failure --
/// including a 401 and an unreachable host -- with a locally generated "Success!
/// ... Reference ID: LMS-123456" while nothing was persisted anywhere. A sealed
/// result makes that class of bug unrepresentable rather than merely fixed:
/// there is no constructor that produces a reference ID without a server.
sealed class LeaveApplicationResult {
  const LeaveApplicationResult();
}

/// The server accepted the application and issued a reference.
class LeaveApplicationSubmitted extends LeaveApplicationResult {
  final String message;
  final String? referenceId;
  final String? leaveType;

  const LeaveApplicationSubmitted({
    required this.message,
    this.referenceId,
    this.leaveType,
  });
}

/// The server rejected the application and said why. The request reached HR;
/// nothing was filed.
class LeaveApplicationRejected extends LeaveApplicationResult {
  final String reason;

  const LeaveApplicationRejected(this.reason);
}

/// The application never reached HR. Nothing was filed.
class LeaveApplicationFailed extends LeaveApplicationResult {
  final String reason;

  const LeaveApplicationFailed(this.reason);
}

class LeaveApplicationRepo {
  /// Kept for the leave-type label shown in the UI, and still unit tested.
  /// It no longer participates in deciding whether anything was submitted.
  static String determineLeaveType(String requestText) {
    final lower = requestText.toLowerCase();
    if (lower.contains("sick")) {
      return "Sick Leave";
    } else if (lower.contains("annual") || lower.contains("earned")) {
      return "Annual Leave";
    }
    return "Casual Leave";
  }

  static Future<LeaveApplicationResult> applyForLeave(
    String employeeId,
    String requestText, {
    Dio? client,
    String? baseUrl,
  }) async {
    final dio = client ?? HrHttpClient.create();
    final root = baseUrl ?? AppConfig.hrApiBaseUrl;

    try {
      final response = await dio.post(
        '$root/leave-application',
        data: {
          'employee_id': employeeId,
          'request_text': requestText,
        },
      );

      final status = response.statusCode ?? 0;
      final body = response.data;

      if (status == 200 && body is Map && body['message'] is String) {
        return LeaveApplicationSubmitted(
          message: body['message'] as String,
          referenceId: body['reference_id'] as String?,
          leaveType: body['leave_type'] as String?,
        );
      }

      // The service answered, so we know the outcome: it was not filed.
      if (status == 401 || status == 403) {
        return const LeaveApplicationRejected(
            'HR rejected the request because this app is not authorised. '
            'Nothing has been submitted.');
      }

      if (body is Map && body['error'] is String) {
        return LeaveApplicationRejected(
            'HR rejected the request: ${body['error']}. '
            'Nothing has been submitted.');
      }

      return LeaveApplicationRejected(
          'HR returned an unexpected response (status $status). '
          'Nothing has been submitted.');
    } catch (error) {
      // Timeout, DNS failure, connection refused, malformed payload. We do not
      // know whether HR saw the request, so we must not claim it was filed.
      return LeaveApplicationFailed(
          'Your leave request was not submitted because '
          '${HrHttpClient.describe(error)}. Nothing has been filed -- '
          'please try again.');
    }
  }
}
