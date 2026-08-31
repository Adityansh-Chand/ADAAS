import 'dart:async';
import 'package:adaas/Model/chat_message_model.dart';
import 'package:adaas/repo/chat_repo.dart';
import 'package:adaas/repo/intent_repo.dart';
import 'package:adaas/repo/leave_api_repo.dart';
import 'package:adaas/repo/leave_application_repo.dart';
import 'package:adaas/repo/notification_repo.dart';
import 'package:adaas/services/app_config.dart';
import 'package:bloc/bloc.dart';
import 'package:meta/meta.dart';

part 'chat_event.dart';
part 'chat_state.dart';

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

    // Decisions the employee has not been shown yet come first, so a rejected
    // application is announced rather than left to be inferred from a balance
    // that quietly moved.
    final pending = await _pendingNotices();
    final reply = await _handle(userMessage);

    emit(ChatSuccessState(
      messages: [...messages, ...pending, reply],
      isGenerating: false,
    ));
  }

  Future<List<AppMessageModel>> _pendingNotices() async {
    final notifications = await NotificationRepo.unread(AppConfig.employeeId);
    final notices = <AppMessageModel>[];
    for (final notification in notifications) {
      notices.add(AppMessageModel(
        role: 'model',
        type: MessageType.notice,
        text: notification.message,
      ));
      await NotificationRepo.acknowledge(notification.id);
    }
    return notices;
  }

  Future<AppMessageModel> _handle(String userMessage) async {
    final classified = await IntentRepo.classify(userMessage);

    switch (classified) {
      case IntentUnavailable(reason: final reason):
        // No local fallback, on purpose. Every intent needs the backend, so
        // routing locally could only ever produce a confidently wrong answer
        // from the weaker of two implementations.
        return AppMessageModel(
          role: 'model',
          type: MessageType.failure,
          text: "I couldn't work out what you were asking because $reason.",
        );
      case IntentClassified(intent: final intent):
        switch (intent) {
          case HRIntent.leaveBalance:
            return _balanceReply();
          case HRIntent.applyLeave:
            return _applyReply(userMessage);
          case HRIntent.policyQuestion:
            return _policyReply(userMessage);
        }
    }
  }

  Future<AppMessageModel> _balanceReply() async {
    final result = await LeaveApiRepo.fetchLeaveBalance(AppConfig.employeeId);
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
    final result = await LeaveApplicationRepo.applyForLeave(
        AppConfig.employeeId, userMessage);

    // Every branch states plainly whether anything was filed. There is no path
    // that reports success without a server having said so.
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
