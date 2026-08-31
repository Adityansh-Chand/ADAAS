import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:adaas/repo/leave_application_repo.dart';
import 'package:adaas/services/http_client.dart';
import 'package:flutter_test/flutter_test.dart';

/// Spins up a real HTTP server so the failure paths are exercised for real
/// rather than through a mock that agrees with whatever the code does.
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
        // The client is asserting on behaviour, not on the harness.
      }
    });
    return _FakeHr(server);
  }

  Future<void> close() => _server.close(force: true);
}

void main() {
  group('determineLeaveType', () {
    test('identifies sick leave', () {
      expect(
          LeaveApplicationRepo.determineLeaveType(
              'I need to take sick leave tomorrow'),
          equals('Sick Leave'));
    });

    test('identifies annual and earned leave', () {
      expect(
          LeaveApplicationRepo.determineLeaveType(
              'Apply for annual leave next week'),
          equals('Annual Leave'));
      expect(LeaveApplicationRepo.determineLeaveType('Requesting earned leave'),
          equals('Annual Leave'));
    });

    test('defaults to casual leave', () {
      expect(LeaveApplicationRepo.determineLeaveType('I am taking leave today'),
          equals('Casual Leave'));
    });

    test('is case insensitive', () {
      expect(LeaveApplicationRepo.determineLeaveType('APPLY FOR SICK LEAVE'),
          equals('Sick Leave'));
    });
  });

  group('applyForLeave -- a failed request is never reported as success', () {
    // This is the regression guard for the worst defect in the previous build.
    // `applyForLeave` answered every failure -- an unreachable host, a timeout,
    // a 401, a 500 -- with a locally generated
    //   "Success! Your request for **Casual Leave** has been submitted for
    //    approval. Reference ID: LMS-123456"
    // while nothing was persisted anywhere and the reference ID was a slice of
    // the current timestamp. Nothing in the UI could tell it apart from a real
    // confirmation.

    test('an unreachable backend yields a failure, not a reference ID',
        () async {
      // Port 1 on loopback: nothing listens, so this refuses immediately.
      final result = await LeaveApplicationRepo.applyForLeave(
        '1001',
        'apply for 1 day casual leave',
        baseUrl: 'http://127.0.0.1:1',
      );

      expect(result, isA<LeaveApplicationFailed>());
      final failed = result as LeaveApplicationFailed;
      expect(failed.reason.toLowerCase(), contains('not submitted'));
      expect(failed.reason, isNot(contains('LMS-')));
      expect(failed.reason.toLowerCase(), isNot(contains('success')));
    });

    test('a stalled backend times out instead of hanging forever', () async {
      // Dio's default connect and receive timeouts are null, meaning wait
      // forever. Before HrHttpClient existed, this test would never return.
      final server = await _FakeHr.serve((request) async {
        // Accept the connection and then never answer.
      });

      final started = DateTime.now();
      final result = await LeaveApplicationRepo.applyForLeave(
        '1001',
        'apply for 1 day casual leave',
        baseUrl: server.baseUrl,
        client: HrHttpClient.create(
          connect: const Duration(milliseconds: 400),
          receive: const Duration(milliseconds: 400),
          send: const Duration(milliseconds: 400),
        ),
      );
      final elapsed = DateTime.now().difference(started);

      await server.close();

      expect(result, isA<LeaveApplicationFailed>());
      expect(elapsed.inSeconds, lessThan(5),
          reason: 'the deadline should have fired, not the test timeout');
    });

    test('a 401 is reported as rejected, not submitted', () async {
      final server = await _FakeHr.serve((request) async {
        request.response.statusCode = 401;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({'error': 'Invalid API key'}));
        await request.response.close();
      });

      final result = await LeaveApplicationRepo.applyForLeave(
        '1001',
        'apply for 1 day casual leave',
        baseUrl: server.baseUrl,
      );
      await server.close();

      expect(result, isA<LeaveApplicationRejected>());
      expect((result as LeaveApplicationRejected).reason.toLowerCase(),
          contains('nothing has been submitted'));
    });

    test('a 422 surfaces the reason HR gave', () async {
      final server = await _FakeHr.serve((request) async {
        request.response.statusCode = 422;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({
          'error': 'Casual Leave allows a maximum of 2 consecutive days',
        }));
        await request.response.close();
      });

      final result = await LeaveApplicationRepo.applyForLeave(
        '1001',
        'apply for 400 days casual leave',
        baseUrl: server.baseUrl,
      );
      await server.close();

      expect(result, isA<LeaveApplicationRejected>());
      expect((result as LeaveApplicationRejected).reason,
          contains('maximum of 2 consecutive days'));
    });

    test('a 500 is reported as rejected, not submitted', () async {
      final server = await _FakeHr.serve((request) async {
        request.response.statusCode = 500;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({'error': 'Internal server error'}));
        await request.response.close();
      });

      final result = await LeaveApplicationRepo.applyForLeave(
        '1001',
        'apply for 1 day casual leave',
        baseUrl: server.baseUrl,
      );
      await server.close();

      expect(result, isA<LeaveApplicationRejected>());
    });

    test('only a real 200 produces a submitted result with the server reference',
        () async {
      final server = await _FakeHr.serve((request) async {
        request.response.statusCode = 200;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({
          'employee_id': '1001',
          'leave_type': 'Casual Leave',
          'days': 1,
          'reference_id': 'LMS-ABC12345',
          'status': 'submitted',
          'message': 'Submitted 1 day(s) of Casual Leave for approval.',
        }));
        await request.response.close();
      });

      final result = await LeaveApplicationRepo.applyForLeave(
        '1001',
        'apply for 1 day casual leave',
        baseUrl: server.baseUrl,
      );
      await server.close();

      expect(result, isA<LeaveApplicationSubmitted>());
      final submitted = result as LeaveApplicationSubmitted;
      // The reference must come from the server, never be minted locally.
      expect(submitted.referenceId, equals('LMS-ABC12345'));
      expect(submitted.message, isNot(contains('**')));
    });
  });
}
