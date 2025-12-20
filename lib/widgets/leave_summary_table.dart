import 'package:flutter/material.dart';
import 'package:adaas/Model/leave_balance_model.dart';

class LeaveSummaryTable extends StatelessWidget {
  final LeaveBalanceModel balance;

  const LeaveSummaryTable({super.key, required this.balance});

  @override
  Widget build(BuildContext context) {
    const textStyle = TextStyle(color: Colors.white, fontSize: 14);

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          // In tests, MediaQuery might need a default, but this is safe
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
                    label: Text('Balance', style: textStyle), numeric: true),
              ],
              rows: [
                DataRow(cells: [
                  DataCell(Text('Casual Leave', style: textStyle)),
                  DataCell(
                      Text(balance.casualLeave.toString(), style: textStyle)),
                ]),
                DataRow(cells: [
                  DataCell(Text('Sick Leave', style: textStyle)),
                  DataCell(
                      Text(balance.sickLeave.toString(), style: textStyle)),
                ]),
                DataRow(cells: [
                  DataCell(Text('Annual Leave', style: textStyle)),
                  DataCell(
                      Text(balance.annualLeave.toString(), style: textStyle)),
                ]),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
