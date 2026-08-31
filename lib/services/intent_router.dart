enum HRIntent {
  leaveBalance,
  applyLeave,
  policyQuestion,
}

/// Rule-based intent router.
///
/// History, because it explains the shape:
///
/// The original version tested raw substrings in a flat `||` chain. "Can I take
/// maternity leave?" was filed as a leave application because it contains `take`
/// and `leave`; "I want to apply for my leave" returned a balance because
/// `my leave` was checked before `apply`. It scored 0.50 on a hand-labelled set.
///
/// The rewrite orders the checks by what the sentence is *doing* rather than
/// which words it contains: an unambiguous filing verb means file it; otherwise
/// a question about how much is left means balance; otherwise an interrogative
/// about the rules means policy -- and that ordering is what rescues "Can I take
/// maternity leave?", because asking whether you may do a thing is not doing it.
///
/// That version scored 1.00 on the 48 cases in eval/intent_queries.json and
/// 0.42 on eval/held_out_intent_queries.json, which was written afterwards. The
/// gap was the point: the first number only said the rules covered the cases
/// their author had thought of. Every held-out failure fell through to the
/// policy default, and two were plain bugs rather than missing vocabulary --
/// `balances` did not match the keyword `balance` because nothing stemmed
/// plurals, and "have I used" did not match a hardcoded `i have` phrase.
///
/// Those two are fixed generally: matching now stems, and first person is
/// detected as a property of the sentence instead of an enumerated list. The
/// vocabulary lists were also widened with ordinary filing and balance idioms.
/// See eval/held_out_intent_queries_2.json for the number measured after this
/// change, on a set written after it was frozen.
class IntentRouter {
  /// Verbs that only ever mean "file this for me". Checked first, so they win
  /// even in question form ("Can you apply leave for me?").
  static const List<String> _filingVerbs = [
    'apply',
    'submit',
    'file',
    'book',
    'raise',
    'put in',
    'put me down',
    'sign me off',
    'sign me out',
    'mark me',
    'leave application',
  ];

  /// Unambiguous balance vocabulary -- no possessive needed.
  static const List<String> _balanceStrong = [
    'leave balance',
    'balance',
    'leave count',
    'leave status',
    'leave summary',
  ];

  /// Words that directly denote what is left of an allowance. These mean a
  /// balance whenever the sentence is about the speaker.
  ///
  /// Deliberately NOT extended with `tally`, `figures`, `spent` or `remain`.
  /// Those four were added at one point and then removed, because all four were
  /// lifted straight out of eval/held_out_intent_queries_2.json after its score
  /// had been seen. Adding them lifted that set from 0.4167 to 0.5833, which
  /// would have been a fabricated measurement -- the set would have been scoring
  /// vocabulary copied from itself. Words only enter this list from
  /// eval/intent_queries.json or from ordinary usage, never from a set being
  /// reported on.
  static const List<String> _remainderMarkers = [
    'remaining',
    'left',
    'usage',
    'used',
    'still have',
    'got left',
    'so far',
  ];

  /// Bare quantity openers. These are far weaker: "how much notice must I give
  /// to take leave?" is a policy question that happens to contain a quantity
  /// word, first person, and the word "leave". Treating them like remainder
  /// words routed it to the balance lookup. They only count when the quantity
  /// attaches directly to something countable.
  static const List<String> _bareQuantityOpeners = ['how many', 'how much'];

  static const List<String> _countableNouns = [
    'leave',
    'leaves',
    'day',
    'days',
    'holiday',
    'holidays',
    'casual',
    'annual',
    'sick',
  ];

  /// Openings that mark a question about the rules rather than a request.
  static const List<String> _policyInterrogatives = [
    'what is',
    'what are',
    'what happens',
    'whats the',
    'what s the',
    // `how much` but deliberately not `how many`: this one is restored because
    // "How much notice must I give to take leave?" regressed on
    // eval/intent_queries.json, which the rules are allowed to be fitted to.
    // `how many` would have been lifted from a set being reported on.
    'how much',
    'how long',
    'how do i',
    'how does',
    'is there',
    'am i allowed',
    'can i',
    'could i',
    'may i',
    'do i need',
    'do we',
    'does',
    'who',
    'when is',
    'why',
    'explain',
    'tell me about',
    'remind me',
  ];

  /// Weaker apply signals: an intent to be away, without a filing verb.
  static const List<String> _softApplyVerbs = [
    'take',
    'taking',
    'need',
    'want',
    'go on',
    'going on',
    'request',
    'requesting',
    'would like',
  ];

  static const List<String> _leaveNouns = [
    'leave',
    'day off',
    'days off',
    'time off',
    'holiday',
    'half day',
    'vacation',
  ];

  /// Notifying HR of an absence is an application even with no leave vocabulary
  /// and no filing verb: "I'll be away Thursday" is a leave request.
  static const List<String> _absencePhrases = [
    'will not come in',
    'wont come in',
    'will not be in',
    'wont be in',
    'not coming in',
    'will be out',
    'be away',
    'be out',
    'away on',
    'stay home',
    'staying home',
    'work from home today',
    'absent',
    'off sick',
    'out of office',
  ];

  static HRIntent route(String input) {
    final normalised = _normalise(input);
    final padded = ' $normalised ';
    final stemmed = ' ${_stemAll(normalised)} ';

    // 1. An unambiguous filing verb settles it.
    if (_containsAny(padded, stemmed, _filingVerbs)) {
      return HRIntent.applyLeave;
    }

    // 2. Asking how much is left.
    if (_containsAny(padded, stemmed, _balanceStrong)) {
      return HRIntent.leaveBalance;
    }
    if (_isBalanceQuery(padded, stemmed)) {
      return HRIntent.leaveBalance;
    }

    // 3. Asking what the rules say. Deliberately ahead of the soft apply verbs:
    //    "Do I need to request leave in advance?" is a question, not a request.
    if (_containsAny(padded, stemmed, _policyInterrogatives) ||
        _containsAny(padded, stemmed, const ['policy', 'process']) ||
        _startsWithAuxiliary(normalised)) {
      return HRIntent.policyQuestion;
    }

    // 4. Weaker signals of wanting to be away.
    if (_containsAny(padded, stemmed, _absencePhrases)) {
      return HRIntent.applyLeave;
    }
    if (_containsAny(padded, stemmed, _softApplyVerbs) &&
        _mentionsLeave(padded, stemmed)) {
      return HRIntent.applyLeave;
    }

    return HRIntent.policyQuestion;
  }

  // -------------------------------------------------------------------------
  // Matching
  // -------------------------------------------------------------------------

  /// Lowercase, strip anything that is not a letter, digit or `&`, collapse
  /// whitespace. Apostrophes are dropped rather than spaced so that `I've`
  /// becomes `ive` and `what's` becomes `whats`, both of which are then matched
  /// as whole words.
  static String _normalise(String input) {
    final lower = input.toLowerCase().replaceAll(RegExp(r"['’]"), '');
    return lower.replaceAll(RegExp(r'[^a-z0-9&]+'), ' ').trim();
  }

  /// Crude plural stripping, applied to every token.
  ///
  /// This is what makes `balances` match the keyword `balance` and `leaves`
  /// match `leave`. Its absence was a real bug, not a gap in the word lists.
  static String _stemAll(String normalised) {
    if (normalised.isEmpty) return '';
    return normalised.split(' ').map(_stem).join(' ');
  }

  static String _stem(String word) {
    if (word.length > 3 && word.endsWith('ies')) {
      return '${word.substring(0, word.length - 3)}y';
    }
    if (word.length > 3 && word.endsWith('ses')) {
      return word.substring(0, word.length - 2);
    }
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
      return word.substring(0, word.length - 1);
    }
    return word;
  }

  /// Is the sentence about the speaker?
  ///
  /// Detected as a property of the sentence rather than an enumerated list of
  /// phrases. The list version missed "have I used" because it only knew
  /// "i have".
  static bool _isFirstPerson(String padded) {
    for (final pronoun in const ['i', 'me', 'my', 'mine', 'im', 'ive', 'id']) {
      if (padded.contains(' $pronoun ')) return true;
    }
    return false;
  }

  /// Both balance paths require the sentence to be about the speaker. Without
  /// that, "How many sick days does the company allow in total?" -- a question
  /// about the entitlement, not about one person's remainder -- reads as a
  /// balance lookup.
  static bool _isBalanceQuery(String padded, String stemmed) {
    if (!_isFirstPerson(padded)) return false;

    if (_containsAny(padded, stemmed, _remainderMarkers) &&
        _mentionsLeave(padded, stemmed)) {
      return true;
    }

    for (final opener in _bareQuantityOpeners) {
      for (final noun in _countableNouns) {
        if (padded.contains(' $opener $noun ')) return true;
      }
    }
    return false;
  }

  static bool _mentionsLeave(String padded, String stemmed) =>
      _containsAny(padded, stemmed, _leaveNouns);

  static bool _startsWithAuxiliary(String normalised) {
    for (final aux in const [
      'is ', 'are ', 'do ', 'can ', 'will ', 'was ', 'has ', 'should ', 'must '
    ]) {
      if (normalised.startsWith(aux)) return true;
    }
    return false;
  }

  /// Whole-word (or whole-phrase) containment, tried against the raw tokens and
  /// then against their stems.
  ///
  /// The guard the original router lacked. Plain `String.contains` let short
  /// tokens fire inside unrelated words -- the corpus's `cl` keyword matched
  /// `clients` and `el` matched `help` and `travel`. Anchoring on spaces in an
  /// already-tokenised string removes that whole class of false positive.
  static bool _containsAny(
      String padded, String stemmed, List<String> needles) {
    for (final needle in needles) {
      final probe = ' ${_normalise(needle)} ';
      if (probe.trim().isEmpty) continue;
      if (padded.contains(probe)) return true;
      if (stemmed.contains(' ${_stemAll(_normalise(needle))} ')) return true;
    }
    return false;
  }

  /// Exposed for tests asserting that matching is word-bounded.
  static bool containsPhrase(String haystack, String needle) {
    final normalised = _normalise(haystack);
    return _containsAny(' $normalised ', ' ${_stemAll(normalised)} ', [needle]);
  }
}
