import 'package:adaas/Features/Prompt/UI/create_prompt.dart';
import 'package:flutter/material.dart';
import 'package:adaas/services/app_config.dart';
import 'package:flutter_test/flutter_test.dart';

/// End-to-end flow through the real screen, BLoC, router and repositories.
///
/// This replaces integration_test/app_flow_test.dart, which asserted
///   expect(find.byType(Container), findsWidgets)
/// -- true of any Material app, so it could not fail -- and never ran anyway,
/// because CI invokes `flutter test`, which reads `test/` and not
/// `integration_test/`.
///
/// No server is reachable here: flutter_test installs an HttpClient that answers
/// every request with a 400. That is exactly the condition worth asserting on,
/// because it is the condition under which the old build fabricated a leave
/// confirmation with a made-up reference ID.
void main() {
  Future<void> send(WidgetTester tester, String message) async {
    await tester.enterText(find.byType(TextField), message);
    await tester.pump();
    await tester.tap(find.byKey(const Key('send')));
    // Let the request fail and the failure state land.
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
  }

  testWidgets('a leave application with no backend reports failure, not success',
      (tester) async {
    await tester.pumpWidget(const MaterialApp(home: CreatePromptScreen()));
    await tester.pump();

    await send(tester, 'apply for 1 day casual leave');

    // The user's own message is echoed.
    expect(find.text('apply for 1 day casual leave'), findsOneWidget);

    // And the reply is unmistakably a failure.
    expect(find.byKey(const Key('failure-message')), findsOneWidget);
    expect(find.text('NOT COMPLETED'), findsOneWidget);

    // Most importantly: no fabricated confirmation and no invented reference.
    expect(find.textContaining('Success!'), findsNothing);
    expect(find.textContaining('LMS-'), findsNothing);
    expect(find.textContaining('has been submitted for approval'), findsNothing);
  });

  testWidgets('a policy question with no backend says so rather than guessing',
      (tester) async {
    await tester.pumpWidget(const MaterialApp(home: CreatePromptScreen()));
    await tester.pump();

    await send(tester, 'What is the remote work policy?');

    expect(find.byKey(const Key('failure-message')), findsOneWidget);
    // The old client answered this from its own divergent copy of the corpus,
    // and returned the Attendance policy rather than Flexible Work.
    expect(find.textContaining('Attendance'), findsNothing);
  });

  testWidgets('with no backend, routing fails rather than guessing locally',
      (tester) async {
    // Intent classification moved to the backend, and there is deliberately no
    // local fallback: every intent needs the service anyway, so routing here
    // could only produce a confidently wrong answer from the weaker of two
    // implementations. The app says it could not work out the question.
    await tester.pumpWidget(const MaterialApp(home: CreatePromptScreen()));
    await tester.pump();

    await send(tester, 'anything at all');

    expect(find.byKey(const Key('failure-message')), findsOneWidget);
    expect(find.textContaining("couldn't work out what you were asking"),
        findsOneWidget);
  });

  testWidgets('a balance lookup with no backend reports failure', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: CreatePromptScreen()));
    await tester.pump();

    await send(tester, 'show my leave balance');

    expect(find.byKey(const Key('failure-message')), findsOneWidget);
    expect(find.byType(DataTable), findsNothing);
  });

  testWidgets('the send button is disabled while a request is in flight',
      (tester) async {
    await tester.pumpWidget(const MaterialApp(home: CreatePromptScreen()));
    await tester.pump();

    await tester.enterText(find.byType(TextField), 'show my leave balance');
    await tester.pump();
    await tester.tap(find.byKey(const Key('send')));
    await tester.pump();

    // By key, not by type: the header now also holds a theme-mode button, so
    // `find.byType(IconButton)` matches two widgets and would throw.
    final button = tester.widget<IconButton>(find.byKey(const Key('send')));
    expect(button.onPressed, isNull);

    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
  });

  testWidgets('the screen shows which employee it is acting as', (tester) async {
    // A demo identity that is not displayed is indistinguishable from a
    // hardcoded one. The employee id was previously a string literal inlined
    // twice in the BLoC with no way to change or see it.
    await tester.pumpWidget(const MaterialApp(home: CreatePromptScreen()));
    await tester.pump();

    expect(find.byKey(const Key('acting-as')), findsOneWidget);
    expect(find.textContaining(AppConfig.employeeId), findsOneWidget);
  });
}
