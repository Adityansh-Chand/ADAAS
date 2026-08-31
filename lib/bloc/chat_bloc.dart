import 'dart:async';
import 'package:adaas/Model/chat_message_model.dart';
import 'package:adaas/repo/chat_repo.dart';
import 'package:adaas/repo/leave_api_repo.dart';
import 'package:adaas/repo/leave_application_repo.dart';
import 'package:adaas/services/intent_router.dart';
import 'package:bloc/bloc.dart';
import 'package:meta/meta.dart';

part 'chat_event.dart';
part 'chat_state.dart';

/// Until there is an identity provider this is the only employee the app can
/// act as. Named rather than inlined twice, so the assumption is visible.
const String kDemoEmployeeId = '1001';

class ChatBloc extends Bloc<ChatEvent, ChatState> {
  ChatBloc() : super(ChatSuccessState(messages: const [])) {
    on<ChatGenerateNewTextMessageEvent>(chatGenerateNewTextMessageEvent);
  }

  FutureOr<void> chatGenerateNewTextMessageEvent(
      ChatGenerateNewTextMessageEvent event, Emitter<ChatState> emit) async {
    final String userMessage = event.inputMessage.trim();
    if (userMessage.isEmpty) return;

    final currentState = state;
    final messages = <AppMessageModel>[
      if (currentState is ChatSuccessState) ...currentState.messages,
      AppMessageModel(
        role: 'user',
        type: MessageType.text,
        text: userMessage,
      ),
    ];

    emit(ChatSuccessState(messages: messages, isGenerating: true));

    final reply = await _handle(userMessage);

    emit(ChatSuccessState(
      messages: [...messages, reply],
      isGenerating: false,
    ));
  }

  Future<AppMessageModel> _handle(String userMessage) async {
    switch (IntentRouter.route(userMessage)) {
      case HRIntent.leaveBalance:
        return _balanceReply();
      case HRIntent.applyLeave:
        return _applyReply(userMessage);
      case HRIntent.policyQuestion:
        return _policyReply(userMessage);
    }
  }

  Future<AppMessageModel> _balanceReply() async {
    final result = await LeaveApiRepo.fetchLeaveBalance(kDemoEmployeeId);
    switch (result) {
      case LeaveBalanceLoaded(balance: final balance):
        return AppMessageModel(
          role: 'model',
          type: MessageType.table,
          leaveBalance: balance,
        );
      case LeaveBalanceUnavailable(reason: final reason):
        return AppMessageModel(
          role: 'model',
          type: MessageType.failure,
          text: "I couldn't fetch your leave balance because $reason.",
        );
    }
  }

  Future<AppMessageModel> _applyReply(String userMessage) async {
    final result =
        await LeaveApplicationRepo.applyForLeave(kDemoEmployeeId, userMessage);

    // Every branch here states plainly whether anything was filed. There is no
    // longer a path that reports success without a server having said so.
    switch (result) {
      case LeaveApplicationSubmitted(
          message: final message,
          referenceId: final referenceId,
        ):
        final reference =
            referenceId == null ? '' : '\n\nReference: $referenceId';
        return AppMessageModel(
          role: 'model',
          type: MessageType.text,
          text: '$message$reference',
        );
      case LeaveApplicationRejected(reason: final reason):
        return AppMessageModel(
          role: 'model',
          type: MessageType.failure,
          text: reason,
        );
      case LeaveApplicationFailed(reason: final reason):
        return AppMessageModel(
          role: 'model',
          type: MessageType.failure,
          text: reason,
        );
    }
  }

  Future<AppMessageModel> _policyReply(String userMessage) async {
    final result = await ChatRepo.askPolicyQuestion(userMessage);
    switch (result) {
      case PolicyAnswer(answer: final answer, sources: final sources):
        return AppMessageModel(
          role: 'model',
          type: MessageType.text,
          text: answer,
          sources: sources,
        );
      case PolicyNotFound():
        return AppMessageModel(
          role: 'model',
          type: MessageType.text,
          text: "I couldn't find a company policy covering that. "
              "You may want to raise it with HR directly.",
        );
      case PolicyLookupFailed(reason: final reason):
        return AppMessageModel(
          role: 'model',
          type: MessageType.failure,
          text: "I couldn't look that policy up because $reason.",
        );
    }
  }
}
