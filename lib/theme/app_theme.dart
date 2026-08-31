import 'package:flutter/material.dart';

/// Chat-specific colours that a [ColorScheme] has no slot for.
///
/// The message bubbles need six semantic grounds -- an answer, the user's own
/// message, something HR decided while the employee was away, and something that
/// did not happen -- and each needs a ground, an edge and an ink that stay legible
/// against each other in both themes. Material's scheme has `error` and nothing
/// else that fits, so they live here as a [ThemeExtension] rather than as
/// constants inside the widget.
///
/// Constants inside the widget is what this replaced, and the reason it had to go
/// is that they were all chosen against a dark photographic background: three
/// `Colors.white`s, a `Colors.black.withAlpha(0.6)` and a hardcoded `0xCC5A1A16`.
/// Every one of them is illegible on white. Colour that lives in the theme can be
/// swapped per brightness; colour that lives in a widget cannot.
@immutable
class ChatColors extends ThemeExtension<ChatColors> {
  const ChatColors({
    required this.userBubble,
    required this.userInk,
    required this.assistantBubble,
    required this.assistantInk,
    required this.failureGround,
    required this.failureEdge,
    required this.failureInk,
    required this.noticeGround,
    required this.noticeEdge,
    required this.noticeInk,
  });

  final Color userBubble;
  final Color userInk;
  final Color assistantBubble;
  final Color assistantInk;
  final Color failureGround;
  final Color failureEdge;
  final Color failureInk;
  final Color noticeGround;
  final Color noticeEdge;
  final Color noticeInk;

  /// The light set, and the fallback.
  ///
  /// Widget tests build bare `MaterialApp(home: ...)` widgets with no theme, so
  /// a lookup that returned null there would turn every one of them into a crash
  /// about an unrelated concern. Falling back keeps the tests testing what they
  /// are about.
  static const ChatColors fallback = _light;

  static const ChatColors _light = ChatColors(
    userBubble: Color(0xFF0F6E63),
    userInk: Color(0xFFFFFFFF),
    assistantBubble: Color(0xFFF3F5F5),
    assistantInk: Color(0xFF1A1D1D),
    failureGround: Color(0xFFFDF1F0),
    failureEdge: Color(0xFFA94A42),
    failureInk: Color(0xFF7F1D18),
    noticeGround: Color(0xFFECF7F8),
    noticeEdge: Color(0xFF356A70),
    noticeInk: Color(0xFF0D4448),
  );

  static const ChatColors _dark = ChatColors(
    userBubble: Color(0xFF2A5751),
    userInk: Color(0xFFDCF5F0),
    assistantBubble: Color(0xFF1D2121),
    assistantInk: Color(0xFFECEFEF),
    failureGround: Color(0xFF2E1613),
    failureEdge: Color(0xFFC98D86),
    failureInk: Color(0xFFFFD9D4),
    noticeGround: Color(0xFF122E30),
    noticeEdge: Color(0xFF69B3B9),
    noticeInk: Color(0xFFD6ECEF),
  );

  /// The set for the current theme, or the light set if no theme provides one.
  static ChatColors of(BuildContext context) =>
      Theme.of(context).extension<ChatColors>() ?? fallback;

  @override
  ChatColors copyWith({
    Color? userBubble,
    Color? userInk,
    Color? assistantBubble,
    Color? assistantInk,
    Color? failureGround,
    Color? failureEdge,
    Color? failureInk,
    Color? noticeGround,
    Color? noticeEdge,
    Color? noticeInk,
  }) {
    return ChatColors(
      userBubble: userBubble ?? this.userBubble,
      userInk: userInk ?? this.userInk,
      assistantBubble: assistantBubble ?? this.assistantBubble,
      assistantInk: assistantInk ?? this.assistantInk,
      failureGround: failureGround ?? this.failureGround,
      failureEdge: failureEdge ?? this.failureEdge,
      failureInk: failureInk ?? this.failureInk,
      noticeGround: noticeGround ?? this.noticeGround,
      noticeEdge: noticeEdge ?? this.noticeEdge,
      noticeInk: noticeInk ?? this.noticeInk,
    );
  }

  @override
  ChatColors lerp(ThemeExtension<ChatColors>? other, double t) {
    if (other is! ChatColors) return this;
    return ChatColors(
      userBubble: Color.lerp(userBubble, other.userBubble, t)!,
      userInk: Color.lerp(userInk, other.userInk, t)!,
      assistantBubble: Color.lerp(assistantBubble, other.assistantBubble, t)!,
      assistantInk: Color.lerp(assistantInk, other.assistantInk, t)!,
      failureGround: Color.lerp(failureGround, other.failureGround, t)!,
      failureEdge: Color.lerp(failureEdge, other.failureEdge, t)!,
      failureInk: Color.lerp(failureInk, other.failureInk, t)!,
      noticeGround: Color.lerp(noticeGround, other.noticeGround, t)!,
      noticeEdge: Color.lerp(noticeEdge, other.noticeEdge, t)!,
      noticeInk: Color.lerp(noticeInk, other.noticeInk, t)!,
    );
  }
}

/// The app's two themes.
///
/// Plain white and near-black, with one accent. The screen this replaced put a
/// full-bleed photograph of the Earth behind the conversation and ran a
/// [BackdropFilter] blur over it, blurring harder while the keyboard was open.
/// Every piece of text was then white-on-photograph, so contrast depended on
/// which part of the image happened to be underneath it, and a light theme was
/// not expressible at all.
///
/// The accent is a deep teal. It appears on the user's own bubble, the send
/// button, and focus rings -- nowhere else -- because in a chat interface the
/// content is the design and everything else should get out of its way.
class AppTheme {
  const AppTheme._();

  static const Color _seedLight = Color(0xFF0F6E63);
  static const Color _seedDark = Color(0xFF5FD3C4);

  static ThemeData light() => _build(
        Brightness.light,
        const ColorScheme.light(
          primary: _seedLight,
          onPrimary: Color(0xFFFFFFFF),
          secondary: Color(0xFF3E6B66),
          onSecondary: Color(0xFFFFFFFF),
          surface: Color(0xFFFFFFFF),
          onSurface: Color(0xFF1A1D1D),
          surfaceContainerLow: Color(0xFFF8F9F9),
          surfaceContainer: Color(0xFFF3F5F5),
          surfaceContainerHigh: Color(0xFFEDEFEF),
          onSurfaceVariant: Color(0xFF5F6666),
          outline: Color(0xFFB9C0C0),
          outlineVariant: Color(0xFFE1E5E5),
          error: Color(0xFF8C1D18),
          onError: Color(0xFFFFFFFF),
        ),
        ChatColors._light,
      );

  static ThemeData dark() => _build(
        Brightness.dark,
        const ColorScheme.dark(
          primary: _seedDark,
          onPrimary: Color(0xFF00332D),
          secondary: Color(0xFF9CCCC5),
          onSecondary: Color(0xFF12332F),
          surface: Color(0xFF121515),
          onSurface: Color(0xFFECEFEF),
          surfaceContainerLow: Color(0xFF181C1C),
          surfaceContainer: Color(0xFF1D2121),
          surfaceContainerHigh: Color(0xFF242929),
          onSurfaceVariant: Color(0xFFA2AAAA),
          outline: Color(0xFF6C7474),
          outlineVariant: Color(0xFF333939),
          error: Color(0xFFFFB4AB),
          onError: Color(0xFF561E19),
        ),
        ChatColors._dark,
      );

  static ThemeData _build(
    Brightness brightness,
    ColorScheme scheme,
    ChatColors chat,
  ) {
    final base = ThemeData(brightness: brightness, colorScheme: scheme);

    return base.copyWith(
      scaffoldBackgroundColor: scheme.surface,
      extensions: [chat],

      // 15.5 rather than 16, and 1.45 line height: a chat transcript is read in
      // long runs and the default 1.2 packs replies too tightly to scan.
      textTheme: base.textTheme.copyWith(
        bodyMedium: base.textTheme.bodyMedium?.copyWith(
          fontSize: 15.5,
          height: 1.45,
          color: scheme.onSurface,
        ),
        bodySmall: base.textTheme.bodySmall?.copyWith(
          fontSize: 12.5,
          height: 1.35,
          color: scheme.onSurfaceVariant,
        ),
        titleMedium: base.textTheme.titleMedium?.copyWith(
          fontSize: 17,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.2,
          color: scheme.onSurface,
        ),
        // Used for the two bubble badges. Small, wide-tracked and bold, so it
        // reads as a label rather than as part of the message.
        labelSmall: base.textTheme.labelSmall?.copyWith(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.1,
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainer,
        hintStyle: TextStyle(color: scheme.onSurfaceVariant, fontSize: 15.5),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        // A visible focus state, which the old dark screen did not have at all.
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.primary, width: 1.6),
        ),
      ),

      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        thickness: 1,
        space: 1,
      ),

      dataTableTheme: DataTableThemeData(
        headingRowColor: WidgetStateProperty.all(scheme.surfaceContainerHigh),
        headingTextStyle: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: scheme.onSurface,
        ),
        dataTextStyle: TextStyle(fontSize: 13.5, color: scheme.onSurface),
        dividerThickness: 1,
      ),

      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
      ),
    );
  }
}
