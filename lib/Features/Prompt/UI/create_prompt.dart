import 'package:adaas/Model/chat_message_model.dart';
import 'package:adaas/bloc/chat_bloc.dart';
import 'package:adaas/main.dart' show themeModeNotifier;
import 'package:adaas/services/app_config.dart';
import 'package:adaas/theme/app_theme.dart';
import 'package:adaas/widgets/leave_summary_table.dart';
import 'package:adaas/widgets/thinking_indicator.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

/// The conversation.
///
/// Plain surface, no background image. This screen used to stack a full-bleed
/// `assets/images/earth.jpg` under a [BackdropFilter] that blurred harder when the
/// keyboard opened, with every piece of text drawn in white on top. Three problems
/// went with it, and all three are gone rather than worked around:
///
///   Contrast was accidental. Legibility depended on which part of the photograph
///   happened to sit behind a given line of text.
///
///   A light theme was not expressible. Nothing in the widget tree could be
///   recoloured, because the colours were constants chosen against the image.
///
///   It cost a live blur over a full-screen image every frame, re-run on every
///   keyboard metric change, for decoration.
class CreatePromptScreen extends StatefulWidget {
  const CreatePromptScreen({super.key});

  @override
  State<CreatePromptScreen> createState() => _CreatePromptScreenState();
}

class _CreatePromptScreenState extends State<CreatePromptScreen> {
  final TextEditingController textEditingController = TextEditingController();
  final ChatBloc chatBloc = ChatBloc();
  final ScrollController _scrollController = ScrollController();

  @override
  void dispose() {
    _scrollController.dispose();
    textEditingController.dispose();
    chatBloc.close();
    super.dispose();
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _submit(ChatSuccessState state) {
    if (state.isGenerating) return;
    final text = textEditingController.text.trim();
    if (text.isEmpty) return;
    chatBloc.add(ChatGenerateNewTextMessageEvent(inputMessage: text));
    textEditingController.clear();
    _scrollToBottom();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // The keyboard is handled by the framework now. The old screen observed
      // window metrics by hand to drive the blur strength; with no blur there is
      // nothing to drive, and `Scaffold` already insets for the keyboard.
      body: SafeArea(
        child: BlocConsumer<ChatBloc, ChatState>(
          bloc: chatBloc,
          listener: (context, state) {
            if (state is ChatSuccessState) _scrollToBottom();
          },
          builder: (context, state) {
            if (state is! ChatSuccessState) {
              return const Center(child: CircularProgressIndicator());
            }

            final messages = state.messages;

            return Column(
              children: [
                const _Header(),
                const Divider(height: 1),
                Expanded(
                  child: messages.isEmpty
                      ? const _EmptyState()
                      : ListView.builder(
                          controller: _scrollController,
                          itemCount: messages.length,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 16, vertical: 16),
                          itemBuilder: (context, index) {
                            final msg = messages[index];
                            if (msg.type == MessageType.table) {
                              return LeaveSummaryTable(
                                  balance: msg.leaveBalance!);
                            }
                            return MessageBubble(
                              message: msg,
                              isUserMessage: msg.role == 'user',
                              maxWidth:
                                  MediaQuery.of(context).size.width * 0.78,
                            );
                          },
                        ),
                ),
                if (state.isGenerating)
                  const Padding(
                    padding: EdgeInsets.fromLTRB(20, 4, 20, 8),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: ThinkingIndicator(),
                    ),
                  ),
                _Composer(
                  controller: textEditingController,
                  isGenerating: state.isGenerating,
                  onSubmit: () => _submit(state),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header();

  /// system -> light -> dark -> system.
  static ThemeMode _next(ThemeMode current) => switch (current) {
        ThemeMode.system => ThemeMode.light,
        ThemeMode.light => ThemeMode.dark,
        ThemeMode.dark => ThemeMode.system,
      };

  static (IconData, String) _affordance(ThemeMode mode) => switch (mode) {
        ThemeMode.system => (Icons.brightness_auto_outlined, 'Theme: system'),
        ThemeMode.light => (Icons.light_mode_outlined, 'Theme: light'),
        ThemeMode.dark => (Icons.dark_mode_outlined, 'Theme: dark'),
      };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 12, 14),
      child: Row(
        children: [
          Text('ADAAS', style: theme.textTheme.titleMedium),
          const SizedBox(width: 10),
          // Which employee the app is acting as. Visible on purpose: it is a demo
          // identity set by --dart-define, not authentication, and hiding that
          // would misrepresent it.
          Text(
            'employee ${AppConfig.employeeId}',
            key: const Key('acting-as'),
            style: theme.textTheme.bodySmall,
          ),
          const Spacer(),
          ValueListenableBuilder<ThemeMode>(
            valueListenable: themeModeNotifier,
            builder: (context, mode, _) {
              final (icon, label) = _affordance(mode);
              return IconButton(
                key: const Key('theme-toggle'),
                icon: Icon(icon, size: 20),
                tooltip: '$label. Tap to change.',
                onPressed: () => themeModeNotifier.value = _next(mode),
              );
            },
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  static const List<String> _examples = [
    'What is my leave balance?',
    'Apply for 2 days of casual leave next Monday',
    'Can I work from home a few days a week?',
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Ask about leave or company policy',
                  style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              Text(
                'Answers about policy are quoted from the company handbook and '
                'cite the section they came from.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 20),
              for (final example in _examples)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    example,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.isGenerating,
    required this.onSubmit,
  });

  final TextEditingController controller;
  final bool isGenerating;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          // Enter sends; Shift+Enter inserts a newline.
          //
          // Handled here, on the text change, rather than as a key shortcut, and
          // both of the tidier approaches were tried in a browser first and
          // failed. `onSubmitted` never fires: a TextField with maxLines > 1 is
          // multiline, and a multiline field treats Enter as content. Wrapping it
          // in `CallbackShortcuts` did nothing either, because Flutter dispatches
          // keys from the focused node upwards -- an ancestor is too late -- and
          // on web the newline does not arrive as a key event at all. The engine
          // hands Flutter a text-editing delta from the browser's own input
          // element, so the only place the Enter is observable is in the text.
          //
          // Shift is read from the live keyboard state instead of from a key
          // event, since there is no event here to read it from.
          Expanded(
            child: TextField(
              controller: controller,
              minLines: 1,
              maxLines: 5,
              textInputAction: TextInputAction.send,
              // Kept: on mobile the on-screen keyboard's send key does go
              // through this, and there the field is not multiline-consuming.
              onSubmitted: (_) => onSubmit(),
              onChanged: (value) {
                if (!value.endsWith('\n')) return;
                if (HardwareKeyboard.instance.isShiftPressed) return;
                controller.text = value.substring(0, value.length - 1);
                controller.selection = TextSelection.collapsed(
                  offset: controller.text.length,
                );
                onSubmit();
              },
              decoration: const InputDecoration(
                hintText: "Ask HR — e.g. 'my leave balance'",
              ),
            ),
          ),
          const SizedBox(width: 10),
          // Disabled while a turn is in flight, so a second request cannot race
          // the first.
          // Keyed rather than found by icon in tests. The tests used to locate
          // this by `find.byIcon(Icons.send)`, which broke the whole app-flow
          // suite the moment the icon changed -- a test coupled to a decorative
          // detail of the thing it is testing.
          IconButton.filled(
            key: const Key('send'),
            onPressed: isGenerating ? null : onSubmit,
            icon: const Icon(Icons.arrow_upward_rounded, size: 20),
            tooltip: 'Send',
            style: IconButton.styleFrom(
              backgroundColor: scheme.primary,
              foregroundColor: scheme.onPrimary,
              disabledBackgroundColor: scheme.surfaceContainerHigh,
              disabledForegroundColor: scheme.onSurfaceVariant,
              minimumSize: const Size(46, 46),
            ),
          ),
        ],
      ),
    );
  }
}

/// A chat bubble.
///
/// Failure messages get their own treatment -- warning-tinted ground, a border,
/// an icon and a label. Before this existed, `ChatState` had no notion of
/// failure, so a fabricated leave confirmation, a real confirmation and a
/// connection error all arrived in an identical bubble. Distinguishing them
/// visually is the other half of the fix in the repositories: the app can now
/// tell the user that nothing was filed, and the user can see it.
///
/// Every colour now comes from [ChatColors] rather than from constants declared
/// here, so all four message kinds stay legible in both themes.
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.message,
    required this.isUserMessage,
    required this.maxWidth,
  });

  final AppMessageModel message;
  final bool isUserMessage;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final chat = ChatColors.of(context);
    final isFailure = message.isFailure;
    final isNotice = message.isNotice;

    final Color ground;
    final Color ink;
    Color? edge;
    if (isFailure) {
      ground = chat.failureGround;
      ink = chat.failureInk;
      edge = chat.failureEdge;
    } else if (isNotice) {
      ground = chat.noticeGround;
      ink = chat.noticeInk;
      edge = chat.noticeEdge;
    } else if (isUserMessage) {
      ground = chat.userBubble;
      ink = chat.userInk;
    } else {
      ground = chat.assistantBubble;
      ink = chat.assistantInk;
    }

    return Align(
      alignment: isUserMessage ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        key: isFailure
            ? const Key('failure-message')
            : isNotice
                ? const Key('notice-message')
                : null,
        constraints: BoxConstraints(maxWidth: maxWidth),
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          color: ground,
          border: edge == null ? null : Border.all(color: edge, width: 1),
        ),
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (isFailure)
              _Badge(
                icon: Icons.error_outline,
                label: 'NOT COMPLETED',
                color: chat.failureEdge,
              ),
            if (isNotice)
              _Badge(
                icon: Icons.notifications_none,
                label: 'WHILE YOU WERE AWAY',
                color: chat.noticeEdge,
              ),
            Text(
              message.text ?? '',
              style: theme.textTheme.bodyMedium?.copyWith(color: ink),
            ),
            // The answer names the one policy it came from, in its own text.
            // Anything else retrieval returned is listed under a heading that
            // says what it is: also retrieved, not also used.
            //
            // It used to read "Sources: a; b; c; d; e" -- five policies under a
            // word that means "this is where the answer came from", when one
            // produced the answer and the other four were the rest of the top
            // five. That is a claim about what the system did, which is the
            // category this project is least willing to be loose about, and it
            // was visible in the first committed screenshot.
            if (message.sources.length == 1) ...[
              const SizedBox(height: 10),
              Text(
                'Source: ${message.sources.first}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: ink.withValues(alpha: 0.72),
                ),
              ),
            ] else if (message.sources.length > 1) ...[
              const SizedBox(height: 10),
              Text(
                'Source: ${message.sources.first}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: ink.withValues(alpha: 0.72),
                ),
              ),
              const SizedBox(height: 2),
              Text(
                'Also retrieved, not used: '
                '${message.sources.skip(1).join('; ')}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: ink.withValues(alpha: 0.55),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.icon, required this.label, required this.color});

  final IconData icon;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 6),
          Text(
            label,
            style: Theme.of(context)
                .textTheme
                .labelSmall
                ?.copyWith(color: color),
          ),
        ],
      ),
    );
  }
}
