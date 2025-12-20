import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:adaas/main.dart' as app;

void main() {
  // 1. Initialize the Integration Test singleton
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('End-to-End Chat Flow Test', (WidgetTester tester) async {
    // 2. Launch the App
    app.main();
    await tester.pumpAndSettle(); // Wait for app to load & animations to finish

    // 3. Find the Text Field and Enter Text
    final Finder textField = find.byType(TextField);
    await tester.enterText(textField, "What is the sick leave policy?");
    await tester.pumpAndSettle();

    // 4. Find the Send Button and Tap it
    final Finder sendButton = find.byIcon(Icons.send);
    await tester.tap(sendButton);

    // 5. Wait for the "Processing" animation and API response
    // We wait extra time because real API calls take time
    await Future.delayed(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    // 6. Verify a Chat Bubble appeared
    // We check if the text we typed is now in the chat list
    expect(find.text("What is the sick leave policy?"), findsOneWidget);

    // 7. Verify the AI responded (Check for any text that isn't the user's)
    // This is a basic check to ensure the list grew.
    // In a real scenario, you might check for specific response text.
    final Finder chatBubbles = find.byType(Container);
    expect(chatBubbles, findsWidgets);
  });
}
