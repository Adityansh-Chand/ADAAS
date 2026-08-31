import 'package:adaas/services/app_config.dart';
import 'package:dio/dio.dart';

/// Single place where the HR API client is constructed.
///
/// Every call the app makes is bounded. Dio's default `connectTimeout` and
/// `receiveTimeout` are both null, which means "wait forever" -- a backend that
/// accepts the socket and then stalls used to leave the chat spinning with no
/// way out but restarting the app. There is no code path here that builds a Dio
/// without these set.
class HrHttpClient {
  static const Duration connectTimeout = Duration(seconds: 3);
  static const Duration receiveTimeout = Duration(seconds: 8);
  static const Duration sendTimeout = Duration(seconds: 5);

  /// Timeouts are deliberately not `const` fields on a shared instance: tests
  /// need to drive a deadline shorter than a stalled server's response, so they
  /// pass their own.
  static Dio create({
    Duration? connect,
    Duration? receive,
    Duration? send,
  }) {
    return Dio(BaseOptions(
      headers: AppConfig.authHeaders,
      connectTimeout: connect ?? connectTimeout,
      receiveTimeout: receive ?? receiveTimeout,
      sendTimeout: send ?? sendTimeout,
      // Let non-2xx responses come back as responses rather than exceptions so
      // callers can tell "the service said no" apart from "the service is gone".
      validateStatus: (_) => true,
    ));
  }

  /// Human-readable reason for a Dio failure, for display in the chat.
  static String describe(Object error) {
    if (error is DioException) {
      switch (error.type) {
        case DioExceptionType.connectionTimeout:
        case DioExceptionType.sendTimeout:
        case DioExceptionType.receiveTimeout:
          return 'the HR service did not respond in time';
        case DioExceptionType.connectionError:
          return 'the HR service could not be reached';
        case DioExceptionType.badCertificate:
          return 'the HR service presented an invalid certificate';
        case DioExceptionType.cancel:
          return 'the request was cancelled';
        case DioExceptionType.badResponse:
        case DioExceptionType.unknown:
          return 'the HR service returned an unexpected response';
      }
    }
    return 'the HR service could not be reached';
  }
}
