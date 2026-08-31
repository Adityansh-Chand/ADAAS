import 'dart:convert';
import 'dart:io';

import 'package:adaas/services/intent_router.dart';
import 'package:flutter_test/flutter_test.dart';

HRIntent _parseLabel(String label) {
  switch (label) {
    case 'leaveBalance':
      return HRIntent.leaveBalance;
    case 'applyLeave':
      return HRIntent.applyLeave;
    case 'policyQuestion':
      return HRIntent.policyQuestion;
  }
  throw ArgumentError('unknown label: $label');
}

class _Case {
  final String query;
  final HRIntent expected;
  const _Case(this.query, this.expected);
}

List<_Case> _load(String path) {
  final file = File(path);
  if (!file.existsSync()) {
    throw StateError('missing eval fixture: $path');
  }
  final data = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  return (data['cases'] as List)
      .cast<Map<String, dynamic>>()
      .map((c) => _Case(c['q'] as String, _parseLabel(c['label'] as String)))
      .toList();
}

/// Accuracy plus the misroutes, so a regression names the sentence it broke.
({int correct, int total, List<String> misroutes}) _score(List<_Case> cases) {
  var correct = 0;
  final misroutes = <String>[];
  for (final c in cases) {
    final got = IntentRouter.route(c.query);
    if (got == c.expected) {
      correct++;
    } else {
      misroutes.add('"${c.query}"  want ${c.expected.name}, got ${got.name}');
    }
  }
  return (correct: correct, total: cases.length, misroutes: misroutes);
}

void main() {
  group('IntentRouter -- behaviour', () {
    test('an unambiguous filing verb beats balance vocabulary', () {
      // The old router answered this with a balance because it checked
      // "my leave" before "apply".
      expect(IntentRouter.route('I want to apply for my leave'),
          equals(HRIntent.applyLeave));
    });

    test('asking whether you may take leave is a policy question', () {
      // The old router filed these as applications because they contain
      // take/request plus leave.
      expect(IntentRouter.route('Can I take maternity leave?'),
          equals(HRIntent.policyQuestion));
      expect(IntentRouter.route('Do I need to request leave in advance?'),
          equals(HRIntent.policyQuestion));
      expect(IntentRouter.route('How much notice must I give to take leave?'),
          equals(HRIntent.policyQuestion));
    });

    test('an entitlement question is not a balance query', () {
      expect(IntentRouter.route('What is the maternity leave entitlement?'),
          equals(HRIntent.policyQuestion));
      expect(IntentRouter.route('What is my remaining leave'),
          equals(HRIntent.leaveBalance));
    });

    test('matching is word-bounded, not substring', () {
      // The corpus's two-letter keywords used to fire inside unrelated words.
      expect(IntentRouter.containsPhrase('which clients we work with', 'cl'),
          isFalse);
      expect(IntentRouter.containsPhrase('I need help with travel', 'el'),
          isFalse);
      expect(IntentRouter.containsPhrase('which clients we work with', 'client'),
          isTrue);
    });

    test('plurals are stemmed', () {
      // "balances" did not match the keyword "balance" before stemming existed,
      // which is why "can you check my balances" fell through to the default.
      expect(IntentRouter.route('can you check my balances'),
          equals(HRIntent.leaveBalance));
    });

    test('case insensitive', () {
      expect(IntentRouter.route('SHOW MY LEAVE BALANCE'),
          equals(HRIntent.leaveBalance));
      expect(
          IntentRouter.route('APPLY FOR LEAVE'), equals(HRIntent.applyLeave));
    });
  });

  group('IntentRouter -- measured accuracy', () {
    final cases = _load('eval/intent_queries.json');

    // Deterministic split, matching eval/intent_queries.json's split_rule.
    final dev = <_Case>[];
    final report = <_Case>[];
    for (var i = 0; i < cases.length; i++) {
      (i.isEven ? dev : report).add(cases[i]);
    }

    test('fixture is the expected shape', () {
      expect(cases.length, greaterThanOrEqualTo(40));
      expect(dev.length + report.length, equals(cases.length));
    });

    test('dev half', () {
      final s = _score(dev);
      // ignore: avoid_print
      print('intent dev      ${s.correct}/${s.total} = '
          '${(s.correct / s.total).toStringAsFixed(4)}');
      for (final m in s.misroutes) {
        // ignore: avoid_print
        print('  MISROUTE $m');
      }
      expect(s.correct / s.total, greaterThanOrEqualTo(0.85));
    });

    test('report half', () {
      final s = _score(report);
      // ignore: avoid_print
      print('intent report   ${s.correct}/${s.total} = '
          '${(s.correct / s.total).toStringAsFixed(4)}');
      for (final m in s.misroutes) {
        // ignore: avoid_print
        print('  MISROUTE $m');
      }
      expect(s.correct / s.total, greaterThanOrEqualTo(0.85));
    });

    test('held-out set 1 -- BURNED, tuned against', () {
      // Retained as a regression guard, not as evidence. This set was written
      // after the first version of the rules and scored 0.4167 on it. Every
      // failure fell through to the policy default, and two were general bugs:
      // `balances` did not match the keyword `balance` because nothing stemmed
      // plurals, and "have I used" did not match a hardcoded `i have` phrase.
      // Fixing those was informed by this set, so its score is no longer an
      // independent measurement. Set 2 below is.
      final s = _score(_load('eval/held_out_intent_queries.json'));
      // ignore: avoid_print
      print('intent held-out-1 (burned)  ${s.correct}/${s.total} = '
          '${(s.correct / s.total).toStringAsFixed(4)}');
      for (final m in s.misroutes) {
        // ignore: avoid_print
        print('  MISROUTE $m');
      }
      expect(s.correct / s.total, greaterThanOrEqualTo(0.60));
    });

    test('held-out set 2 -- the clean number', () {
      // Written after the stemming and first-person fixes were frozen, and the
      // rules were not changed in response to it. This is the only intent
      // accuracy figure in the repository that measures generalisation rather
      // than coverage of remembered cases.
      //
      // Measured: 0.4167 (10/24). Set 1 scored 0.4167 before it was tuned
      // against and 0.8750 after. Set 2 then landed on exactly the same 0.4167
      // the tuning had started from, which says the tuning bought coverage of
      // remembered phrasings and no generalisation at all. Rule-based routing
      // plateaus here: every miss falls through to the policy default because
      // the sentence uses vocabulary no rule enumerates.
      //
      // The gate sits below the measured value on purpose. Raising it to just
      // under whatever this set scores would make it a target and burn it, which
      // is precisely how set 1 stopped being evidence.
      final s = _score(_load('eval/held_out_intent_queries_2.json'));
      // ignore: avoid_print
      print('intent held-out-2 (clean)   ${s.correct}/${s.total} = '
          '${(s.correct / s.total).toStringAsFixed(4)}');
      for (final m in s.misroutes) {
        // ignore: avoid_print
        print('  MISROUTE $m');
      }
      expect(s.correct / s.total, greaterThanOrEqualTo(0.40));
    });
  });
}
