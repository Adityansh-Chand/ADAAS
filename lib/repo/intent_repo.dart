import 'package:adaas/services/app_config.dart';
import 'package:adaas/services/http_client.dart';
import 'package:dio/dio.dart';

/// The three things a message can be.
enum HRIntent {
  leaveBalance,
  applyLeave,
  policyQuestion,
}

sealed class IntentResult {
  const IntentResult();
}

class IntentClassified extends IntentResult {
  final HRIntent intent;

  /// `embedding`, `rules_fallback` or `rules` -- which implementation decided.
  final String method;
  final double? confidence;

  const IntentClassified({
    required this.intent,
    required this.method,
    this.confidence,
  });
}

class IntentUnavailable extends IntentResult {
  final String reason;

  const IntentUnavailable(this.reason);
}

/// Intent classification lives in the backend.
///
/// It used to live here, in `lib/services/intent_router.dart`, as a rule-based
/// router. It was removed for the same reason the client-side retriever was: all
/// three intents require the backend, so a client-side router was pure
/// duplication, and two copies of a decision drift apart. The client-side
/// retriever had already demonstrated exactly that -- it disagreed with the
/// server on which policy answered a query, and only ran when nobody was
/// watching.
///
/// The backend also has something this could not: a k-NN classifier over
/// sentence embeddings, which reaches 0.9667 on held-out phrasing against the
/// rules' 0.5667. Keeping a copy of the weaker implementation here would have
/// meant shipping the worse answer whenever the network hiccuped, and calling it
/// resilience.
class IntentRepo {
  static Future<IntentResult> classify(
    String message, {
    Dio? client,
    String? baseUrl,
  }) async {
    final dio = client ?? HrHttpClient.create();
    final root = baseUrl ?? AppConfig.hrApiBaseUrl;

    try {
      final response = await dio.post(
        '$root/intent',
        data: {'message': message},
      );

      final status = response.statusCode ?? 0;
      final body = response.data;

      if (status == 200 && body is Map && body['intent'] is String) {
        final parsed = _parse(body['intent'] as String);
        if (parsed == null) {
          return IntentUnavailable(
              'the HR service returned an unknown intent "${body['intent']}"');
        }
        final rawConfidence = body['confidence'];
        return IntentClassified(
          intent: parsed,
          method: (body['method'] as String?) ?? 'unknown',
          confidence: rawConfidence is num ? rawConfidence.toDouble() : null,
        );
      }

      if (status == 401 || status == 403) {
        return const IntentUnavailable(
            'this app is not authorised to use the HR service');
      }

      return IntentUnavailable(
          'the HR service returned an unexpected response (status $status)');
    } catch (error) {
      return IntentUnavailable(HrHttpClient.describe(error));
    }
  }

  static HRIntent? _parse(String raw) {
    switch (raw) {
      case 'leaveBalance':
        return HRIntent.leaveBalance;
      case 'applyLeave':
        return HRIntent.applyLeave;
      case 'policyQuestion':
        return HRIntent.policyQuestion;
    }
    return null;
  }
}
