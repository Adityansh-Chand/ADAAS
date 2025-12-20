import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:adaas/Model/leave_balance_model.dart';
import 'package:adaas/widgets/leave_summary_table.dart';

void main() {
  testWidgets('LeaveSummaryTable displays correct balance data',
      (WidgetTester tester) async {
    // 1. Setup Test Data
    final testBalance =
        LeaveBalanceModel(casualLeave: 5, sickLeave: 3, annualLeave: 12);

    // 2. Pump the Widget (Render it in the test environment)
    // We wrap it in MaterialApp/Scaffold because typical widgets need context
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LeaveSummaryTable(balance: testBalance),
        ),
      ),
    );

    // 3. Verify the Header exists
    expect(find.text('Your Leave Balance:'), findsOneWidget);

    // 4. Verify the specific numbers are displayed
    expect(find.text('5'), findsOneWidget); // Casual Leave count
    expect(find.text('3'), findsOneWidget); // Sick Leave count
    expect(find.text('12'), findsOneWidget); // Annual Leave count

    // 5. Verify the Labels exist
    expect(find.text('Casual Leave'), findsOneWidget);
    expect(find.text('Sick Leave'), findsOneWidget);
  });
}
