import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:adaas/repo/intent_repo.dart';
import 'package:adaas/repo/notification_repo.dart';
import 'package:adaas/services/http_client.dart';
import 'package:flutter_test/flutter_test.dart';

/// A real HTTP server, so the failure paths are exercised rather than mocked
/// into agreeing with whatever the code happens to do.
class _FakeHr {
  _FakeHr(this._server);
  final HttpServer _server;
  String get baseUrl => 'http://127.0.0.1:${_server.port}';

  static Future<_FakeHr> serve(
      FutureOr<void> Function(HttpRequest) handler) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      try {
        await handler(request);
      } catch (_) {
        // The client is under test, not the harness.
      }
    });
    return _FakeHr(server);
  }

  Future<void> close() => _server.close(force: true);
}

Future<void> _json(HttpRequest request, int status, Object body) async {
  request.response.statusCode = status;
  request.response.headers.contentType = ContentType.json;
  request.response.write(jsonEncode(body));
  await request.response.close();
}

void main() {
  group('IntentRepo', () {
    test('parses a classified intent and the deciding method', () async {
      final server = await _FakeHr.serve((r) => _json(r, 200, {
            'intent': 'leaveBalance',
            'method': 'embedding',
            'confidence': 0.4933,
          }));

      final result =
          await IntentRepo.classify('do I still have days', baseUrl: server.baseUrl);
      await server.close();

      expect(result, isA<IntentClassified>());
      final classified = result as IntentClassified;
      expect(classified.intent, HRIntent.leaveBalance);
      expect(classified.method, 'embedding');
      expect(classified.confidence, closeTo(0.4933, 1e-6));
    });

    test('an unknown intent string is a failure, not a guess', () async {
      // Forward compatibility: if the backend grows a fourth intent, the client
      // must say it does not understand rather than silently pick one of three.
      final server = await _FakeHr.serve(
          (r) => _json(r, 200, {'intent': 'bookMeetingRoom', 'method': 'embedding'}));

      final result = await IntentRepo.classify('x', baseUrl: server.baseUrl);
      await server.close();

      expect(result, isA<IntentUnavailable>());
      expect((result as IntentUnavailable).reason, contains('bookMeetingRoom'));
    });

    test('an unreachable backend yields IntentUnavailable', () async {
      // Nothing listens on port 1, so this refuses immediately. There is no
      // local router to fall back to, by design.
      final result = await IntentRepo.classify(
        'do I still have days',
        baseUrl: 'http://127.0.0.1:1',
      );
      expect(result, isA<IntentUnavailable>());
    });

    test('a stalled backend times out rather than hanging', () async {
      final server = await _FakeHr.serve((request) async {
        // Accept and never answer.
      });

      final started = DateTime.now();
      final result = await IntentRepo.classify(
        'x',
        baseUrl: server.baseUrl,
        client: HrHttpClient.create(
          connect: const Duration(milliseconds: 400),
          receive: const Duration(milliseconds: 400),
          send: const Duration(milliseconds: 400),
        ),
      );
      final elapsed = DateTime.now().difference(started);
      await server.close();

      expect(result, isA<IntentUnavailable>());
      expect(elapsed.inSeconds, lessThan(5));
    });

    test('a 401 is reported as unauthorised', () async {
      final server = await _FakeHr.serve(
          (r) => _json(r, 401, {'error': 'Invalid API key'}));
      final result = await IntentRepo.classify('x', baseUrl: server.baseUrl);
      await server.close();

      expect(result, isA<IntentUnavailable>());
      expect((result as IntentUnavailable).reason, contains('authorised'));
    });
  });

  group('NotificationRepo', () {
    test('parses unread notifications', () async {
      final server = await _FakeHr.serve((r) => _json(r, 200, {
            'notifications': [
              {'id': 'NTF-1', 'message': 'Your leave was rejected.'},
              {'id': 'NTF-2', 'message': 'Your leave was approved.'},
            ],
            'unread': 2,
          }));

      final unread = await NotificationRepo.unread('1001', baseUrl: server.baseUrl);
      await server.close();

      expect(unread.length, 2);
      expect(unread.first.id, 'NTF-1');
      expect(unread.first.message, contains('rejected'));
    });

    test('malformed entries are skipped rather than crashing the turn', () async {
      final server = await _FakeHr.serve((r) => _json(r, 200, {
            'notifications': [
              {'id': 'NTF-1'},
              {'message': 'no id'},
              {'id': 'NTF-3', 'message': 'valid'},
            ],
          }));

      final unread = await NotificationRepo.unread('1001', baseUrl: server.baseUrl);
      await server.close();

      expect(unread.length, 1);
      expect(unread.single.id, 'NTF-3');
    });

    test('an unreachable notifications endpoint returns empty, not an error',
        () async {
      // The one place swallowing a failure is right: a notification outage must
      // not stop the message the user actually typed from being answered. The
      // notification is still pending on the next interaction.
      final unread =
          await NotificationRepo.unread('1001', baseUrl: 'http://127.0.0.1:1');
      expect(unread, isEmpty);
    });

    test('acknowledging an unreachable endpoint does not throw', () async {
      await expectLater(
        NotificationRepo.acknowledge('NTF-1', baseUrl: 'http://127.0.0.1:1'),
        completes,
      );
    });
  });
}
