import 'package:adaas/Model/leave_balance_model.dart';
import 'package:adaas/theme/app_theme.dart';
import 'package:flutter/material.dart';

/// Leave balance shown as remaining out of entitlement.
///
/// Two rows, not three. Annual and sick leave are a single shared pool in the
/// policy corpus -- policy_003_el_sl grants "18 days per year (Combined
/// Annual/Earned/Sick)" -- so listing them as separate balances was the reason
/// the displayed numbers could never be reconciled with the policy the same app
/// quotes. Showing the entitlement next to the remainder makes the figure
/// checkable.
///
/// Colours come from the theme. This widget previously hardcoded `Colors.white`,
/// `Colors.white70`, `Colors.white54`, `Colors.white60` and a 60%-alpha black
/// ground, all of which were chosen to sit on a dark photograph and none of which
/// are legible on a white surface.
class LeaveSummaryTable extends StatelessWidget {
  final LeaveBalanceModel balance;

  const LeaveSummaryTable({super.key, required this.balance});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final chat = ChatColors.of(context);

    // Numbers are compared down the column, so they need to line up. Proportional
    // digits make "15" and "18" different widths and the column reads ragged.
    final figure = theme.textTheme.bodyMedium?.copyWith(
      fontSize: 13.5,
      fontFeatures: const [FontFeature.tabularFigures()],
      color: chat.assistantInk,
    );
    final mutedFigure = figure?.copyWith(color: scheme.onSurfaceVariant);
    final label = theme.textTheme.bodyMedium?.copyWith(
      fontSize: 13.5,
      color: chat.assistantInk,
    );

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.95,
        ),
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          color: chat.assistantBubble,
          border: Border.all(color: scheme.outlineVariant),
        ),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Your Leave Balance:', style: theme.textTheme.titleMedium),
            const SizedBox(height: 14),
            // Margins and spacing are tightened from the Material defaults (24
            // and 24) so all three columns fit a 375pt phone without scrolling.
            // The scroll view stays as the fallback: at smaller widths, or with a
            // large system font, a DataTable overflows and paints a debug stripe
            // rather than adapting.
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: DataTable(
                horizontalMargin: 12,
                columnSpacing: 14,
                headingRowHeight: 40,
                dataRowMinHeight: 40,
                dataRowMaxHeight: 44,
                border: TableBorder.all(
                  width: 1,
                  color: scheme.outlineVariant,
                  borderRadius: BorderRadius.circular(8),
                ),
                columns: const [
                  DataColumn(label: Text('Leave Type')),
                  DataColumn(label: Text('Remaining'), numeric: true),
                  DataColumn(label: Text('Entitlement'), numeric: true),
                ],
                rows: [
                  DataRow(cells: [
                    DataCell(Text('Casual Leave', style: label)),
                    DataCell(Text(balance.casualRemaining.toString(),
                        style: figure)),
                    DataCell(Text(balance.casualEntitlement.toString(),
                        style: mutedFigure)),
                  ]),
                  DataRow(cells: [
                    DataCell(Text('Annual / Sick (shared)', style: label)),
                    DataCell(Text(balance.combinedRemaining.toString(),
                        style: figure)),
                    DataCell(Text(balance.combinedEntitlement.toString(),
                        style: mutedFigure)),
                  ]),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Text(
              'Annual, earned and sick leave draw on one shared pool.',
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}
