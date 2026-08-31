import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Three pulsing dots, shown while a turn is in flight.
///
/// Replaces `Lottie.asset('assets/loader.json')` -- a 21-layer, 1000x1000, 41 KB
/// animation whose colours are baked into the JSON. That was survivable against a
/// dark photograph and is not survivable against two themes: there is no way to
/// recolour it per brightness short of shipping two copies. This draws itself
/// from `colorScheme.onSurfaceVariant`, so it is correct in both themes for free,
/// and it removed the `lottie` dependency and the asset with it.
///
/// Honest about what it conveys: it means a request is outstanding, not that
/// anything is being "thought about". The label says the same thing plainly.
class ThinkingIndicator extends StatefulWidget {
  const ThinkingIndicator({super.key, this.label = 'Working'});

  final String label;

  @override
  State<ThinkingIndicator> createState() => _ThinkingIndicatorState();
}

class _ThinkingIndicatorState extends State<ThinkingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Semantics(
      liveRegion: true,
      label: '${widget.label}. Waiting for the HR service.',
      child: Row(
        mainAxisAlignment: MainAxisAlignment.start,
        children: [
          AnimatedBuilder(
            animation: _controller,
            builder: (context, _) => Row(
              children: List.generate(3, (i) {
                // Each dot trails the one before it by a third of a cycle.
                final phase = (_controller.value - i * 0.18) % 1.0;
                final eased = (math.sin(phase * 2 * math.pi) + 1) / 2;
                return Padding(
                  padding: EdgeInsets.only(right: i == 2 ? 0 : 5),
                  child: Opacity(
                    opacity: 0.32 + 0.58 * eased,
                    child: Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: scheme.onSurfaceVariant,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
          const SizedBox(width: 12),
          Text(
            widget.label,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
