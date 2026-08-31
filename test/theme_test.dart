import 'dart:math' as math;

import 'package:adaas/Features/Prompt/UI/create_prompt.dart';
import 'package:adaas/Model/chat_message_model.dart';
import 'package:adaas/main.dart';
import 'package:adaas/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// WCAG 2.1 relative luminance.
double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/// WCAG contrast ratio, 1.0 (identical) to 21.0 (black on white).
double _contrast(Color a, Color b) {
  final la = _luminance(a);
  final lb = _luminance(b);
  final hi = math.max(la, lb);
  final lo = math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  // ---------------------------------------------------------------------------
  // Contrast
  //
  // This is the test the old screen could not have passed and did not have. Its
  // colours were `Colors.white` on a photograph, so "is the text legible" had no
  // answer -- it depended on which part of the image was underneath. Now every
  // pairing is a pair of opaque colours from the theme, so the question has a
  // number, and the number can fail the build.
  //
  // 4.5:1 is the WCAG AA threshold for normal-size text. The badge labels are
  // 11px bold, which AA would let through at 3:1 as "large" only above 14px
  // bold, so they are held to the stricter number too.
  // ---------------------------------------------------------------------------
  const minRatio = 4.5;

  final themes = <String, ThemeData>{
    'light': AppTheme.light(),
    'dark': AppTheme.dark(),
  };

  for (final entry in themes.entries) {
    final name = entry.key;
    final theme = entry.value;
    final chat = theme.extension<ChatColors>()!;
    final scheme = theme.colorScheme;

    test('$name: every message kind is legible on its own ground', () {
      final pairs = <String, List<Color>>{
        'answer text': [chat.assistantInk, chat.assistantBubble],
        'user text': [chat.userInk, chat.userBubble],
        'failure text': [chat.failureInk, chat.failureGround],
        'failure badge': [chat.failureEdge, chat.failureGround],
        'notice text': [chat.noticeInk, chat.noticeGround],
        'notice badge': [chat.noticeEdge, chat.noticeGround],
      };

      // Collected, not asserted one at a time. `expect` throws on the first
      // failure, so a single bad pairing hid the rest -- when this test was
      // first run it reported the failure badge at 3.16:1 and said nothing
      // about the notice badge, which was worse at 2.79:1. Both were real.
      final failures = <String>[];
      pairs.forEach((label, colors) {
        final ratio = _contrast(colors[0], colors[1]);
        if (ratio < minRatio) {
          failures.add('$label ${ratio.toStringAsFixed(2)}:1');
        }
      });

      expect(
        failures,
        isEmpty,
        reason: '$name: below $minRatio:1 -- ${failures.join(', ')}',
      );
    });

    test('$name: body and muted text are legible on the page surface', () {
      // `onSurfaceVariant` carries the source citations, the hint text and the
      // employee label. Muted is not an excuse for unreadable.
      expect(_contrast(scheme.onSurface, scheme.surface),
          greaterThanOrEqualTo(minRatio));
      expect(_contrast(scheme.onSurfaceVariant, scheme.surface),
          greaterThanOrEqualTo(minRatio));
      expect(_contrast(scheme.onSurfaceVariant, scheme.surfaceContainer),
          greaterThanOrEqualTo(minRatio));
      expect(_contrast(scheme.onPrimary, scheme.primary),
          greaterThanOrEqualTo(minRatio));
    });

    test('$name: the four message grounds are distinguishable from each other',
        () {
      // Distinct semantics need distinct grounds. If failure and notice were
      // near-identical, the contrast tests above would still pass while the
      // user could not tell "nothing was filed" from "HR decided something".
      final grounds = {
        'assistant': chat.assistantBubble,
        'user': chat.userBubble,
        'failure': chat.failureGround,
        'notice': chat.noticeGround,
      };
      final names = grounds.keys.toList();
      for (var i = 0; i < names.length; i++) {
        for (var j = i + 1; j < names.length; j++) {
          final a = grounds[names[i]]!;
          final b = grounds[names[j]]!;
          expect(a.toARGB32(), isNot(b.toARGB32()),
              reason: '$name: ${names[i]} and ${names[j]} share a ground');
        }
      }
    });

    test('$name: the surface is opaque', () {
      // A translucent surface would put the old problem back: what is legible
      // becomes a function of whatever is behind the app.
      expect(scheme.surface.a, 1.0);
      expect(chat.assistantBubble.a, 1.0);
      expect(chat.userBubble.a, 1.0);
      expect(chat.failureGround.a, 1.0);
      expect(chat.noticeGround.a, 1.0);
    });
  }

  test('light and dark are actually different brightnesses', () {
    final light = AppTheme.light();
    final dark = AppTheme.dark();
    expect(light.brightness, Brightness.light);
    expect(dark.brightness, Brightness.dark);
    expect(_luminance(light.colorScheme.surface),
        greaterThan(_luminance(dark.colorScheme.surface)));
  });

  test('ChatColors falls back rather than returning null without a theme', () {
    // Widget tests build bare MaterialApps. A null lookup there would turn every
    // one of them into a crash about the theme instead of a failure about the
    // thing under test.
    expect(ChatColors.fallback.assistantInk, isNotNull);
  });

  // ---------------------------------------------------------------------------
  // The mode control
  // ---------------------------------------------------------------------------

  testWidgets('the theme control cycles system, light, dark and back',
      (tester) async {
    final original = themeModeNotifier.value;
    addTearDown(() => themeModeNotifier.value = original);

    themeModeNotifier.value = ThemeMode.system;
    await tester.pumpWidget(const AdaasApp());
    await tester.pump();

    // System first, so the app follows the OS unless told otherwise.
    expect(themeModeNotifier.value, ThemeMode.system);

    for (final expected in [ThemeMode.light, ThemeMode.dark, ThemeMode.system]) {
      await tester.tap(find.byKey(const Key('theme-toggle')));
      await tester.pump();
      expect(themeModeNotifier.value, expected);
    }
  });

  testWidgets('a failure bubble renders in both themes without an exception',
      (tester) async {
    for (final theme in [AppTheme.light(), AppTheme.dark()]) {
      await tester.pumpWidget(MaterialApp(
        theme: theme,
        home: Scaffold(
          body: MessageBubble(
            message: AppMessageModel(
              role: 'model',
              type: MessageType.failure,
              text: 'Nothing has been filed.',
            ),
            isUserMessage: false,
            maxWidth: 400,
          ),
        ),
      ));
      await tester.pump();
      expect(find.byKey(const Key('failure-message')), findsOneWidget);
      expect(tester.takeException(), isNull);
    }
  });
}
