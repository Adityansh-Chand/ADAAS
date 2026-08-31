import 'package:flutter/foundation.dart' show kIsWeb;

class AppConfig {
  static const String _configuredApiBaseUrl =
      String.fromEnvironment('HR_API_BASE_URL');
  static const String _configuredApiKey = String.fromEnvironment('HR_API_KEY');
  static const String _configuredEmployeeId =
      String.fromEnvironment('HR_EMPLOYEE_ID');

  static String get hrApiBaseUrl {
    final configured = _configuredApiBaseUrl.trim();
    if (configured.isNotEmpty) {
      return _withoutTrailingSlash(configured);
    }

    if (kIsWeb) {
      return 'http://localhost:3000';
    }

    return 'http://10.0.2.2:3000';
  }

  static String _withoutTrailingSlash(String value) {
    return value.endsWith('/') ? value.substring(0, value.length - 1) : value;
  }

  /// Which employee the app is acting as.
  ///
  /// Set with `--dart-define=HR_EMPLOYEE_ID=1002`. This is a demo identity, not
  /// authentication: the backend seeds 1001 and 1002 with different balances so
  /// that switching is observably real, but nothing here proves who the user is.
  /// A real identity provider remains an open gap and the README says so.
  static String get employeeId {
    final configured = _configuredEmployeeId.trim();
    return configured.isEmpty ? '1001' : configured;
  }

  static Map<String, String> get authHeaders {
    final apiKey = _configuredApiKey.trim();
    if (apiKey.isEmpty) {
      return const {};
    }

    return {'X-API-Key': apiKey};
  }
}
