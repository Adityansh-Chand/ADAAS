import 'dart:convert';
import 'dart:developer';
import 'package:adaas/Model/chat_message_model.dart';
import 'package:adaas/services/app_config.dart';
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';

class ChatRepo {
  static List<Map<String, dynamic>> _knowledgeBase = [];

  static Future<void> loadKnowledgeBase() async {
    try {
      final String jsonString =
          await rootBundle.loadString('assets/hr_knowledge_base.json');
      _knowledgeBase =
          (jsonDecode(jsonString) as List).cast<Map<String, dynamic>>();
      log('Knowledge base loaded successfully. ${_knowledgeBase.length} entries.');
    } catch (e) {
      log('Error loading knowledge base: $e');
    }
  }

  static String retrieveContext(
      String userMessage, List<Map<String, dynamic>> kb) {
    String context = "";
    if (userMessage.isNotEmpty) {
      for (var entry in kb) {
        List<String> keywords = (entry['keywords'] as List).cast<String>();
        for (var keyword in keywords) {
          if (userMessage.toLowerCase().contains(keyword.toLowerCase())) {
            context += "Source: ${entry['source']}\n";
            context += "Policy Details: ${entry['answer']}\n\n";
            break;
          }
        }
      }
    }
    if (context.isEmpty) {
      return "No specific company policy information was found for this query. Answer based on general knowledge.";
    }
    return context;
  }

  static Future<String> chatTextGenerationRepo(
      List<AppMessageModel> previousMessages) async {
    final userMessage = previousMessages.last.text ?? "";
    final context = retrieveContext(userMessage, _knowledgeBase);

    try {
      final response = await Dio().post(
        '${AppConfig.hrApiBaseUrl}/chat',
        data: {
          'message': userMessage,
        },
      );

      if (response.statusCode == 200 && response.data['answer'] is String) {
        return response.data['answer'] as String;
      }

      return _localAnswer(context);
    } catch (e) {
      log("Backend chat unavailable, using local RAG fallback: $e");
      return _localAnswer(context);
    }
  }

  static String _localAnswer(String context) {
    if (context.startsWith("No specific company policy")) {
      return "I couldn't find a matching company policy for that question.";
    }

    final firstSource = RegExp(r"Source: (.+)").firstMatch(context)?.group(1);
    final firstPolicy = RegExp(r"Policy Details: ([\s\S]+?)(?:\n\n|$)")
        .firstMatch(context)
        ?.group(1);

    if (firstPolicy == null) {
      return "I couldn't find a matching company policy for that question.";
    }

    final citation = firstSource == null ? "" : "\n\nSource: $firstSource";
    return "$firstPolicy$citation";
  }
}
