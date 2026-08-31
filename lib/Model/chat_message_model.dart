import 'package:adaas/Model/leave_balance_model.dart';

/// What the UI should build for a message.
///
/// [failure] exists so that a message reporting something going wrong cannot be
/// rendered as an ordinary assistant reply. [notice] is for something HR did
/// while the employee was away -- an approval or rejection -- which is neither a
/// reply to what they just asked nor a failure. Previously the state carried no
/// notion of failure at all, so a fabricated leave confirmation, a real one, and
/// a connection error all arrived in the same bubble with the same styling.
enum MessageType { text, table, failure, notice }

/// A message shown in the UI. The BLoC state holds a `List<AppMessageModel>`.
class AppMessageModel {
  final String role;
  final MessageType type;
  final String? text;
  final LeaveBalanceModel? leaveBalance;

  /// Where a policy answer came from, shown under the answer so the user can
  /// see the citation. Empty for everything else.
  final List<String> sources;

  AppMessageModel({
    required this.role,
    this.type = MessageType.text,
    this.text,
    this.leaveBalance,
    this.sources = const [],
  }) : assert(
            (text != null && leaveBalance == null) ||
                (text == null && leaveBalance != null),
            "A message must have either text or leaveBalance, but not both.");

  bool get isFailure => type == MessageType.failure;

  bool get isNotice => type == MessageType.notice;
}
