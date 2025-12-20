import 'dart:async';
import 'package:adaas/Model/chat_message_model.dart';
import 'package:adaas/Model/leave_balance_model.dart';
import 'package:adaas/repo/chat_repo.dart';
import 'package:adaas/repo/leave_api_repo.dart';
import 'package:adaas/repo/leave_application_repo.dart';
import 'package:bloc/bloc.dart';
import 'package:meta/meta.dart';

part 'chat_event.dart';
part 'chat_state.dart';

class ChatBloc extends Bloc<ChatEvent, ChatState> {
  ChatBloc() : super(ChatSuccessState(messages: const [])) {
    // Load the knowledge base when the BLoC is created
    ChatRepo.loadKnowledgeBase();
    on<ChatGenerateNewTextMessageEvent>(chatGenerateNewTextMessageEvent);
  }

  FutureOr<void> chatGenerateNewTextMessageEvent(
      ChatGenerateNewTextMessageEvent event, Emitter<ChatState> emit) async {
    final String userMessage = event.inputMessage;
    if (userMessage.isEmpty) return;

    // --- 1. Get current messages from the state ---
    final currentState = state;
    List<AppMessageModel> currentMessages = [];
    if (currentState is ChatSuccessState) {
      currentMessages = List.from(currentState.messages);
    }

    // --- 2. Add user's message ---
    currentMessages.add(AppMessageModel(
      role: "user",
      type: MessageType.text,
      text: userMessage,
    ));

    // --- 3. Emit "generating" state ---
    emit(ChatSuccessState(
      messages: currentMessages,
      isGenerating: true,
    ));

    // Small delay for UI smoothness
    await Future.delayed(const Duration(milliseconds: 100));

    // --- 4. INTENT ROUTING LOGIC ---
    String userTextLower = userMessage.toLowerCase();

    // Check for "Leave Balance" intent
    bool isLeaveBalanceRequest = userTextLower.contains("leave balance") ||
        userTextLower.contains("my leave") ||
        userTextLower.contains("leave count");

    // Check for "Apply Leave" intent
    bool isApplyLeaveRequest = userTextLower.contains("apply sick leave") ||
        userTextLower.contains("apply casual leave") ||
        userTextLower.contains("apply annual leave") ||
        (userTextLower.contains("apply") && userTextLower.contains("leave")) ||
        (userTextLower.contains("take") && userTextLower.contains("leave")) ||
        (userTextLower.contains("request") && userTextLower.contains("leave"));

    if (isLeaveBalanceRequest) {
      // --- ROUTE 1: FETCH LEAVE BALANCE (REST API) ---
      // ignore: avoid_print
      print("BLoC: Matched intent 'Leave Balance'. Calling LeaveApiRepo...");
      LeaveBalanceModel? balance =
          await LeaveApiRepo.fetchLeaveBalance("1001"); // Using user 1001

      if (balance != null) {
        currentMessages.add(AppMessageModel(
          role: 'model',
          type: MessageType.table,
          leaveBalance: balance,
        ));
      } else {
        currentMessages.add(AppMessageModel(
          role: 'model',
          text: "Sorry, I couldn't fetch your leave balance right now.",
        ));
      }
    } else if (isApplyLeaveRequest) {
      // --- ROUTE 2: APPLY FOR LEAVE (LMS MOCK) ---
      // ignore: avoid_print
      print(
          "BLoC: Matched intent 'Apply Leave'. Calling LeaveApplicationRepo...");

      String? result =
          await LeaveApplicationRepo.applyForLeave("1001", userMessage);

      if (result != null) {
        currentMessages.add(AppMessageModel(
          role: 'model',
          text: result, // This displays the success message
        ));
      } else {
        currentMessages.add(AppMessageModel(
          role: 'model',
          text:
              "I encountered an error submitting your leave request. Please try again later.",
        ));
      }
    } else {
      // --- ROUTE 3: POLICY QUESTION (RAG) ---
      // ignore: avoid_print
      print(
          "BLoC: Matched intent 'Policy Question'. Calling ChatRepo (RAG)...");
      String generatedText =
          await ChatRepo.chatTextGenerationRepo(currentMessages);

      if (generatedText.isNotEmpty) {
        currentMessages
            .add(AppMessageModel(role: 'model', text: generatedText));
      } else {
        currentMessages.add(AppMessageModel(
            role: 'model',
            text: "Sorry, I'm having trouble connecting. Please try again."));
      }
    }

    // --- 5. Emit final state ---
    emit(ChatSuccessState(
      messages: currentMessages,
      isGenerating: false,
    ));
  }
}
