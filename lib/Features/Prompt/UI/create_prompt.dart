import 'dart:ui';
import 'package:adaas/Model/chat_message_model.dart';
import 'package:adaas/bloc/chat_bloc.dart';
import 'package:adaas/widgets/leave_summary_table.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:lottie/lottie.dart';

class CreatePromptScreen extends StatefulWidget {
  const CreatePromptScreen({super.key});

  @override
  State<CreatePromptScreen> createState() => _CreatePromptScreenState();
}

class _CreatePromptScreenState extends State<CreatePromptScreen>
    with WidgetsBindingObserver {
  TextEditingController textEditingController = TextEditingController();
  final ChatBloc chatBloc = ChatBloc();
  bool _isKeyboardVisible = false;
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void didChangeMetrics() {
    super.didChangeMetrics();
    final viewInsets = PlatformDispatcher.instance.views.first.viewInsets;
    final bottomInsetPhysical = viewInsets.bottom;
    final devicePixelRatio =
        PlatformDispatcher.instance.views.first.devicePixelRatio;
    final bottomInsetLogical = bottomInsetPhysical / devicePixelRatio;
    setState(() {
      _isKeyboardVisible = bottomInsetLogical > 0;
    });
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: BlocConsumer<ChatBloc, ChatState>(
          bloc: chatBloc,
          listener: (context, state) {
            if (state is ChatSuccessState) {
              _scrollToBottom();
            }
          },
          builder: (context, state) {
            if (state is ChatSuccessState) {
              // The list is of type AppMessageModel
              List<AppMessageModel> message = state.messages;

              return Stack(
                children: [
                  Container(
                    height: MediaQuery.of(context).size.height,
                    width: MediaQuery.of(context).size.width,
                    decoration: const BoxDecoration(
                      image: DecorationImage(
                        image: AssetImage('assets/images/earth.jpg'),
                        fit: BoxFit
                            .cover, // This makes the image fill the screen
                      ),
                    ),
                  ),
                  BackdropFilter(
                    filter: ImageFilter.blur(
                      sigmaX: _isKeyboardVisible ? 6.0 : 2.0,
                      sigmaY: _isKeyboardVisible ? 6.0 : 2.0,
                    ),
                    child: Container(
                      color: Colors.black.withAlpha(
                          (255 * (_isKeyboardVisible ? 0.4 : 0.2)).toInt()),
                    ),
                  ),
                  Column(
                    children: [
                      const SizedBox(height: 60),
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 16.0),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            "ADAAS",
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 26,
                              fontWeight: FontWeight.bold,
                              fontFamily: 'Sixtyfour',
                            ),
                          ),
                        ),
                      ),
                      Expanded(
                        child: ListView.builder(
                          controller: _scrollController,
                          itemCount: message.length,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 16, vertical: 8),
                          itemBuilder: (context, index) {
                            final msg = message[index];
                            bool isUserMessage = msg.role == 'user';

                            if (msg.type == MessageType.table) {
                              // Render the table widget
                              return LeaveSummaryTable(
                                  balance: msg.leaveBalance!);
                            } else {
                              // Render the text bubble
                              return Align(
                                alignment: isUserMessage
                                    ? Alignment.centerRight
                                    : Alignment.centerLeft,
                                child: Container(
                                  constraints: BoxConstraints(
                                    maxWidth:
                                        MediaQuery.of(context).size.width * 0.7,
                                  ),
                                  margin: const EdgeInsets.only(bottom: 10),
                                  decoration: BoxDecoration(
                                    borderRadius: BorderRadius.circular(16),
                                    color: isUserMessage
                                        ? Theme.of(context)
                                            .primaryColor
                                            .withAlpha((255 * 0.9).toInt())
                                        : Colors.black
                                            .withAlpha((255 * 0.6).toInt()),
                                  ),
                                  padding: const EdgeInsets.symmetric(
                                      vertical: 12, horizontal: 16),
                                  child: Text(
                                    msg.text ?? "",
                                    style: TextStyle(
                                      color: isUserMessage
                                          ? Colors.black
                                          : Colors.white,
                                      fontSize: 16,
                                    ),
                                  ),
                                ),
                              );
                            }
                          },
                        ),
                      ),
                      if (state.isGenerating)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              SizedBox(
                                height: 60,
                                width: 60,
                                child: Lottie.asset('assets/loader.json'),
                              ),
                              const SizedBox(width: 12),
                              const Text(
                                "Processing...",
                                style: TextStyle(
                                    color: Colors.white, fontSize: 16),
                              ),
                            ],
                          ),
                        ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            vertical: 12, horizontal: 16),
                        child: Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: textEditingController,
                                style: const TextStyle(color: Colors.white),
                                cursorColor: Colors.white,
                                maxLines: 3,
                                minLines: 1,
                                decoration: InputDecoration(
                                  hintText: "Ask HR (e.g., 'my leave balance')",
                                  hintStyle: TextStyle(
                                      color: Theme.of(context).primaryColor),
                                  filled: true,
                                  fillColor: Colors.black26,
                                  contentPadding: const EdgeInsets.symmetric(
                                      horizontal: 20, vertical: 12),
                                  border: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(12),
                                    borderSide: BorderSide.none,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Container(
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                border: Border.all(
                                    color: Theme.of(context).primaryColor,
                                    width: 2),
                              ),
                              child: CircleAvatar(
                                radius: 24,
                                backgroundColor: Colors.transparent,
                                child: IconButton(
                                  icon: const Icon(Icons.send,
                                      color: Colors.white),
                                  // Check if the BLoC is already working.
                                  // If it is, 'onPressed' will be null, disabling the button.
                                  onPressed: state.isGenerating
                                      ? null
                                      : () {
                                          // Only send an event if not already generating
                                          if (textEditingController
                                              .text.isNotEmpty) {
                                            chatBloc.add(
                                                ChatGenerateNewTextMessageEvent(
                                              inputMessage:
                                                  textEditingController.text,
                                            ));
                                            textEditingController.clear();
                                            _scrollToBottom();
                                          }
                                        },
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              );
            }
            // This is the default case (handles ChatInitial)
            return const Center(child: CircularProgressIndicator());
          }),
    );
  }
}
