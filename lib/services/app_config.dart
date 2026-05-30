import 'package:flutter/foundation.dart' show kIsWeb;

class AppConfig {
  static const String _configuredApiBaseUrl =
      String.fromEnvironment('HR_API_BASE_URL');

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
}
