import 'package:adaas/services/app_config.dart';
import 'package:adaas/services/http_client.dart';
import 'package:dio/dio.dart';

/// A decision the employee has not yet been shown.
class HrNotification {
  final String id;
  final String message;

  const HrNotification({required this.id, required this.message});
}

/// Pending decisions on this employee's leave applications.
///
/// A decision the applicant is never told about is not a workflow. Approvals and
/// rejections previously changed a balance silently, leaving the employee to
/// notice the number had moved.
///
/// Failures here are swallowed on purpose, and this is the one place in the app
/// where that is right: an unreachable notification endpoint must not stop the
/// message the user actually typed from being answered. Nothing is lost -- an
/// unacknowledged notification is still pending on the next interaction.
class NotificationRepo {
  static Future<List<HrNotification>> unread(
    String employeeId, {
    Dio? client,
    String? baseUrl,
  }) async {
    final dio = client ?? HrHttpClient.create();
    final root = baseUrl ?? AppConfig.hrApiBaseUrl;

    try {
      final response = await dio.get(
        '$root/notifications',
        queryParameters: {'employee_id': employeeId, 'unread': 'true'},
      );

      if (response.statusCode != 200) return const [];
      final body = response.data;
      if (body is! Map || body['notifications'] is! List) return const [];

      return (body['notifications'] as List)
          .whereType<Map>()
          .where((n) => n['id'] is String && n['message'] is String)
          .map((n) => HrNotification(
                id: n['id'] as String,
                message: n['message'] as String,
              ))
          .toList();
    } catch (_) {
      return const [];
    }
  }

  /// Mark a notification as seen. Failure is not surfaced: the worst case is the
  /// employee is told twice, which is better than not being told at all.
  static Future<void> acknowledge(
    String id, {
    Dio? client,
    String? baseUrl,
  }) async {
    final dio = client ?? HrHttpClient.create();
    final root = baseUrl ?? AppConfig.hrApiBaseUrl;

    try {
      await dio.post('$root/notifications/$id/ack', data: const {});
    } catch (_) {
      // Intentionally ignored -- see above.
    }
  }
}
