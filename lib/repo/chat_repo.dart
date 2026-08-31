import 'package:adaas/services/app_config.dart';
import 'package:adaas/services/http_client.dart';
import 'package:dio/dio.dart';

/// Outcome of asking a policy question.
sealed class PolicyAnswerResult {
  const PolicyAnswerResult();
}

/// The service answered from the HR knowledge base.
class PolicyAnswer extends PolicyAnswerResult {
  final String answer;
  final List<String> sources;

  const PolicyAnswer({required this.answer, this.sources = const []});
}

/// The service was reached and had no policy covering the question. This is a
/// real answer, not a failure -- it is distinguished from [PolicyLookupFailed]
/// because "we have no policy on that" and "we could not ask" are different
/// facts and the user is entitled to know which one happened.
class PolicyNotFound extends PolicyAnswerResult {
  const PolicyNotFound();
}

/// The question never reached the service.
class PolicyLookupFailed extends PolicyAnswerResult {
  final String reason;

  const PolicyLookupFailed(this.reason);
}

/// Policy questions are answered by the backend, which owns the only retrieval
/// implementation in the system.
///
/// This class used to carry a second, different retriever: it loaded the same
/// knowledge base into the client and scored it by unranked substring match,
/// taking whichever entry appeared first in the JSON file. It disagreed with the
/// backend -- on "What is the remote work policy?" the backend returned the
/// Flexible Work Arrangement Policy and the client returned Attendance -- and it
/// ran precisely when the backend was unreachable and nobody was watching. Two
/// rankers that disagree is not a bug that can be fixed, only picked between, so
/// the client-side one is gone.
class ChatRepo {
  static Future<PolicyAnswerResult> askPolicyQuestion(
    String userMessage, {
    Dio? client,
    String? baseUrl,
  }) async {
    final dio = client ?? HrHttpClient.create();
    final root = baseUrl ?? AppConfig.hrApiBaseUrl;

    try {
      final response = await dio.post(
        '$root/chat',
        data: {'message': userMessage},
      );

      final status = response.statusCode ?? 0;
      final body = response.data;

      if (status == 200 && body is Map && body['answer'] is String) {
        final answer = body['answer'] as String;
        final rawSources = body['sources'];
        final sources = rawSources is List
            ? rawSources.map((s) => s.toString()).toList()
            : const <String>[];

        if (sources.isEmpty && answer.startsWith("I couldn't find")) {
          return const PolicyNotFound();
        }

        return PolicyAnswer(answer: answer, sources: sources);
      }

      if (status == 401 || status == 403) {
        return const PolicyLookupFailed(
            'this app is not authorised to query HR policy');
      }

      return PolicyLookupFailed(
          'the HR service returned an unexpected response (status $status)');
    } catch (error) {
      return PolicyLookupFailed(HrHttpClient.describe(error));
    }
  }
}
