part of 'chat_bloc.dart';

@immutable
sealed class ChatState {}

final class ChatInitial extends ChatState {}

class ChatSuccessState extends ChatState {
  // This list now holds AppMessageModel
  final List<AppMessageModel> messages;

  // ---> Debounce / Loading flag lives in state
  final bool isGenerating;

  ChatSuccessState({
    required this.messages,
    this.isGenerating = false, // default
  });
}
