import 'dart:convert';
import 'dart:developer';
import 'package:flutter/services.dart'; // For rootBundle (to load JSON)
import 'package:adaas/Model/chat_message_model.dart'; // This has all models
import 'package:adaas/utils/constants.dart'; // For our apiKey
import 'package:dio/dio.dart';

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
          if (userMessage.toLowerCase().contains(keyword)) {
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
    try {
      final userMessage = previousMessages.last.text ?? "";
      String context = retrieveContext(userMessage, _knowledgeBase);

      List<GeminiRequestMessage> apiMessages = previousMessages
          .where((msg) => msg.type == MessageType.text)
          .map((msg) => GeminiRequestMessage(
                role: msg.role,
                parts: [GeminiRequestPart(text: msg.text ?? "")],
              ))
          .toList();

      GeminiRequestMessage originalUserMessage = apiMessages.removeLast();
      String augmentedPrompt = """
      You are "ADAAS," a corporate HR assistant.
      Based ONLY on the following context, answer the user's question.
      IMPORTANT: You must cite the 'Source' provided in the context at the end of your answer.
      Do not make up information. If the context is not relevant, say you cannot help.

      ---CONTEXT---
      $context
      ---END CONTEXT---

      User's Question: "${originalUserMessage.parts.first.text}"
      """;

      apiMessages.add(GeminiRequestMessage(
        role: "user",
        parts: [GeminiRequestPart(text: augmentedPrompt)],
      ));

      apiMessages.add(GeminiRequestMessage(
        role: "model",
        parts: [
          GeminiRequestPart(
              text: "Okay, based on that policy, here is the answer:")
        ],
      ));

      Dio dio = Dio();
      final response = await dio.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$apiKey',
        data: {
          "contents": apiMessages.map((e) => e.toMap()).toList(),
          "generationConfig": {
            "temperature": 0.9,
            "topK": 1,
            "topP": 1,
            "maxOutputTokens": 2048,
            "stopSequences": []
          },
          "safetySettings": [
            {
              "category": "HARM_CATEGORY_HARASSMENT",
              "threshold": "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              "category": "HARM_CATEGORY_HATE_SPEECH",
              "threshold": "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              "threshold": "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
              "threshold": "BLOCK_MEDIUM_AND_ABOVE"
            }
          ]
        },
      );

      log(response.toString());

      if (response.statusCode == 200) {
        var data = response.data;
        if (data != null &&
            data['candidates'] != null &&
            data['candidates'].isNotEmpty &&
            data['candidates'][0]['content'] != null &&
            data['candidates'][0]['content']['parts'] != null &&
            data['candidates'][0]['content']['parts'].isNotEmpty) {
          String generatedText =
              data['candidates'][0]['content']['parts'][0]['text'];
          return generatedText;
        }
      }

      return "No response from the model.";
    } catch (e) {
      log("Error in chatTextGenerationRepo: $e");
      return "An error occurred while generating a response.";
    }
  }
}
