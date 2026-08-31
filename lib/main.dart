import 'package:adaas/Features/Prompt/UI/create_prompt.dart';
import 'package:adaas/theme/app_theme.dart';
import 'package:flutter/material.dart';

void main() {
  runApp(const AdaasApp());
}

/// Which theme the app is showing.
///
/// Defaults to [ThemeMode.system], so the app follows the OS rather than
/// insisting. The in-app control cycles system -> light -> dark and back, which
/// keeps "follow the system" reachable instead of stranding the user in whichever
/// of the two they last picked.
///
/// Not persisted across launches. Doing that needs a storage dependency
/// (`shared_preferences` or equivalent) and this is the one place in the app where
/// losing state costs the user a single tap, so the dependency is not worth it.
/// Stated here rather than left as a surprise.
final ValueNotifier<ThemeMode> themeModeNotifier =
    ValueNotifier<ThemeMode>(ThemeMode.system);

class AdaasApp extends StatelessWidget {
  const AdaasApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: themeModeNotifier,
      builder: (context, mode, _) => MaterialApp(
        title: 'ADAAS',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        darkTheme: AppTheme.dark(),
        themeMode: mode,
        home: const CreatePromptScreen(),
      ),
    );
  }
}
