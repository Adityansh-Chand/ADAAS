import 'package:flutter/material.dart';
import 'package:adaas/Model/leave_balance_model.dart';

/// Leave balance shown as remaining out of entitlement.
///
/// Two rows, not three. Annual and sick leave are a single shared pool in the
/// policy corpus -- policy_003_el_sl grants "18 days per year (Combined
/// Annual/Earned/Sick)" -- so listing them as separate balances was the reason
/// the displayed numbers could never be reconciled with the policy the same app
/// quotes. Showing the entitlement next to the remainder makes the figure
/// checkable.
class LeaveSummaryTable extends StatelessWidget {
  final LeaveBalanceModel balance;

  const LeaveSummaryTable({super.key, required this.balance});

  @override
  Widget build(BuildContext context) {
    const textStyle = TextStyle(color: Colors.white, fontSize: 14);
    const mutedStyle = TextStyle(color: Colors.white70, fontSize: 14);

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.85,
        ),
        margin: const EdgeInsets.only(bottom: 10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          color: Colors.black.withAlpha((255 * 0.6).toInt()),
        ),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              "Your Leave Balance:",
              style: TextStyle(
                  color: Colors.white,
                  fontSize: 16,
                  fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            DataTable(
              headingRowColor:
                  WidgetStateProperty.all(Colors.white.withAlpha(20)),
              border: TableBorder.all(
                width: 1.0,
                color: Colors.white54,
                borderRadius: BorderRadius.circular(8),
              ),
              columns: const [
                DataColumn(label: Text('Leave Type', style: textStyle)),
                DataColumn(
                    label: Text('Remaining', style: textStyle), numeric: true),
                DataColumn(
                    label: Text('Entitlement', style: textStyle),
                    numeric: true),
              ],
              rows: [
                DataRow(cells: [
                  const DataCell(Text('Casual Leave', style: textStyle)),
                  DataCell(Text(balance.casualRemaining.toString(),
                      style: textStyle)),
                  DataCell(Text(balance.casualEntitlement.toString(),
                      style: mutedStyle)),
                ]),
                DataRow(cells: [
                  const DataCell(
                      Text('Annual / Sick (shared)', style: textStyle)),
                  DataCell(Text(balance.combinedRemaining.toString(),
                      style: textStyle)),
                  DataCell(Text(balance.combinedEntitlement.toString(),
                      style: mutedStyle)),
                ]),
              ],
            ),
            const SizedBox(height: 10),
            const Text(
              'Annual, earned and sick leave draw on one shared pool.',
              style: TextStyle(color: Colors.white60, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}
