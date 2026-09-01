import 'package:adaas/Features/Prompt/UI/create_prompt.dart';
import 'package:adaas/Model/chat_message_model.dart';
import 'package:adaas/Model/leave_balance_model.dart';
import 'package:adaas/theme/app_theme.dart';
import 'package:adaas/widgets/leave_summary_table.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  _sourceLabelTests();
  testWidgets('LeaveSummaryTable shows remaining against entitlement',
      (tester) async {
    await tester.pumpWidget(_host(const LeaveSummaryTable(
      balance: LeaveBalanceModel(
        casualRemaining: 3,
        casualEntitlement: 4,
        combinedRemaining: 15,
        combinedEntitlement: 18,
      ),
    )));

    expect(find.text('Your Leave Balance:'), findsOneWidget);
    expect(find.text('Casual Leave'), findsOneWidget);
    expect(find.text('Annual / Sick (shared)'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(find.text('4'), findsOneWidget);
    expect(find.text('15'), findsOneWidget);
    expect(find.text('18'), findsOneWidget);
  });

  testWidgets('the table does not present annual and sick as separate pools',
      (tester) async {
    // Three independent balances could not be reconciled with policy_003_el_sl,
    // which grants one shared 18-day pool.
    await tester.pumpWidget(_host(const LeaveSummaryTable(
      balance: LeaveBalanceModel(
        casualRemaining: 3,
        casualEntitlement: 4,
        combinedRemaining: 15,
        combinedEntitlement: 18,
      ),
    )));

    expect(find.text('Sick Leave'), findsNothing);
    expect(find.text('Annual Leave'), findsNothing);
  });

  testWidgets('a failure message is visually distinct from an answer',
      (tester) async {
    // The other half of removing the fabricated success: the app must be able
    // to say nothing was filed, and the user must be able to see it.
    await tester.pumpWidget(_host(
      CreatePromptScreen(
        key: const Key('screen'),
      ),
    ));
    await tester.pump();

    // Render the two message kinds side by side through the real bubble widget.
    await tester.pumpWidget(_host(Column(children: [
      MessageBubble(
        message: AppMessageModel(
          role: 'model',
          type: MessageType.text,
          text: 'Casual leave entitlement is 4 days per year.',
          sources: const ['Leave Policy Guidelines, Section 3.1'],
        ),
        isUserMessage: false,
        maxWidth: 400,
      ),
      MessageBubble(
        message: AppMessageModel(
          role: 'model',
          type: MessageType.failure,
          text: 'Your leave request was not submitted because the HR service '
              'could not be reached. Nothing has been filed.',
        ),
        isUserMessage: false,
        maxWidth: 400,
      ),
    ])));
    await tester.pump();

    expect(find.byKey(const Key('failure-message')), findsOneWidget);
    expect(find.text('NOT COMPLETED'), findsOneWidget);
    expect(find.byIcon(Icons.error_outline), findsOneWidget);
    // The successful answer cites its source.
    expect(find.textContaining('Leave Policy Guidelines'), findsOneWidget);
  });

  testWidgets('a notice is distinct from both an answer and a failure',
      (tester) async {
    // Three visually distinct kinds: an answer, something HR did while the
    // employee was away, and something that did not happen.
    await tester.pumpWidget(_host(Column(children: [
      MessageBubble(
        message: AppMessageModel(
          role: 'model',
          type: MessageType.text,
          text: 'Casual leave entitlement is 4 days per year.',
        ),
        isUserMessage: false,
        maxWidth: 400,
      ),
      MessageBubble(
        message: AppMessageModel(
          role: 'model',
          type: MessageType.notice,
          text: 'Your request for 2 day(s) of Casual Leave was rejected.',
        ),
        isUserMessage: false,
        maxWidth: 400,
      ),
      MessageBubble(
        message: AppMessageModel(
          role: 'model',
          type: MessageType.failure,
          text: 'Nothing has been filed.',
        ),
        isUserMessage: false,
        maxWidth: 400,
      ),
    ])));
    await tester.pump();

    expect(find.byKey(const Key('notice-message')), findsOneWidget);
    expect(find.byKey(const Key('failure-message')), findsOneWidget);
    expect(find.text('WHILE YOU WERE AWAY'), findsOneWidget);
    expect(find.text('NOT COMPLETED'), findsOneWidget);
    expect(find.byIcon(Icons.notifications_none), findsOneWidget);
    expect(find.byIcon(Icons.error_outline), findsOneWidget);
  });
}

// ---------------------------------------------------------------------------
// What the source line claims
// ---------------------------------------------------------------------------

void _sourceLabelTests() {
  testWidgets('extra retrieved policies are not labelled as sources', (tester) async {
    // The bubble used to print "Sources: a; b; c; d; e" whenever retrieval
    // returned five policies -- one produced the answer and four were the rest
    // of the top five, all under a word that means "this is where the answer
    // came from". A reader could only conclude that five documents informed it.
    //
    // Caught by looking at a committed screenshot, not by a test, which is why
    // there is now a test.
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: MessageBubble(
          message: AppMessageModel(
            role: 'model',
            type: MessageType.text,
            text: 'Remote work requires manager approval.',
            sources: const [
              'Flexible Work Arrangement Policy',
              'Employee Handbook, Section 4: Attendance',
              'Leave Policy Guidelines, Section 3.5',
            ],
          ),
          isUserMessage: false,
          maxWidth: 600,
        ),
      ),
    ));
    await tester.pump();

    expect(find.text('Source: Flexible Work Arrangement Policy'), findsOneWidget);
    expect(
      find.textContaining('Also retrieved, not used:'),
      findsOneWidget,
      reason: 'the other retrieved policies must say what they are',
    );
    // The plural heading is the specific claim being retired.
    expect(find.textContaining('Sources:'), findsNothing);
  });

  testWidgets('a single source keeps the plain label', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: MessageBubble(
          message: AppMessageModel(
            role: 'model',
            type: MessageType.text,
            text: 'Smoking is prohibited on premises.',
            sources: const ['Workplace Safety Policy'],
          ),
          isUserMessage: false,
          maxWidth: 600,
        ),
      ),
    ));
    await tester.pump();

    expect(find.text('Source: Workplace Safety Policy'), findsOneWidget);
    expect(find.textContaining('Also retrieved'), findsNothing);
  });
}
