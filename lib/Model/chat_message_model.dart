import 'dart:convert';
import 'package:adaas/Model/leave_balance_model.dart';

// -----------------------------------------------------------------
// 1. Enum to define what the UI should build
// -----------------------------------------------------------------
enum MessageType { text, table }

// -----------------------------------------------------------------
// 2. Model for our BLoC State (what the UI will display)
// -----------------------------------------------------------------
/// This model represents a message shown in the UI.
/// The BLoC state will hold a `List<AppMessageModel>`.
class AppMessageModel {
  final String role;
  final MessageType type;
  final String? text; // Used for text messages
  final LeaveBalanceModel? leaveBalance; // Used for table messages

  AppMessageModel({
    required this.role,
    this.type = MessageType.text, // Default to text
    this.text,
    this.leaveBalance,
  }) : assert(
            // An AppMessageModel must have EITHER text OR leaveBalance.
            (text != null && leaveBalance == null) ||
                (text == null && leaveBalance != null),
            "A message must have either text or leaveBalance, but not both.");
}

// -----------------------------------------------------------------
// 3. Models for building the Gemini API Request
// -----------------------------------------------------------------
/// This model represents the message format we send TO the Gemini API.
/// Our `ChatRepo` will build a `List<GeminiRequestMessage>` for the API call.
class GeminiRequestMessage {
  final String role;
  final List<GeminiRequestPart> parts;
  GeminiRequestMessage({
    required this.role,
    required this.parts,
  });

  Map<String, dynamic> toMap() {
    return {
      'role': role,
      'parts': parts.map((x) => x.toMap()).toList(),
    };
  }

  factory GeminiRequestMessage.fromMap(Map<String, dynamic> map) {
    return GeminiRequestMessage(
      role: map['role'] ?? '',
      parts: List<GeminiRequestPart>.from(
          map['parts']?.map((x) => GeminiRequestPart.fromMap(x))),
    );
  }

  String toJson() => json.encode(toMap());

  factory GeminiRequestMessage.fromJson(String source) =>
      GeminiRequestMessage.fromMap(json.decode(source));
}

/// This model represents a "part" of a Gemini API request.
class GeminiRequestPart {
  final String text;
  GeminiRequestPart({
    required this.text,
  });

  Map<String, dynamic> toMap() {
    return {
      'text': text,
    };
  }

  factory GeminiRequestPart.fromMap(Map<String, dynamic> map) {
    return GeminiRequestPart(
      text: map['text'] ?? '',
    );
  }

  String toJson() => json.encode(toMap());

  factory GeminiRequestPart.fromJson(String source) =>
      GeminiRequestPart.fromMap(json.decode(source));
}
