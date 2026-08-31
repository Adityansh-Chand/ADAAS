'use strict';

/**
 * Optional LLM answer generation.
 *
 * Provider-agnostic on purpose. The previous version hardcoded
 * `gemini-2.5-flash`, read `GEMINI_API_KEY`, put the key in the URL query
 * string, and had no timeout -- so a stalled provider stalled the request, which
 * in turn stalled the app. The five services in the portfolio all read
 * LLM_PROVIDER / LLM_API_KEY / LLM_MODEL / LLM_BASE_URL, and this is now the
 * sixth.
 *
 * Default is `none`: with no configuration, policy answers come straight from
 * the retrieved policy text. That is the mode the repository is meant to be
 * reviewed in.
 */

const DEFAULT_TIMEOUT_MS = 8000;

const PROVIDERS = {
  none: null,
  gemini: {
    // Gemini's REST API takes the key as a header; the query-string form used
    // previously logs the key into any intermediary that records URLs.
    buildRequest({ apiKey, model, baseUrl, prompt }) {
      const host = baseUrl || 'https://generativelanguage.googleapis.com';
      const name = model || 'gemini-2.5-flash';
      return {
        url: `${host}/v1beta/models/${name}:generateContent`,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        },
      };
    },
    extract(data) {
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    },
  },
  openai: {
    // Also covers any OpenAI-compatible endpoint via LLM_BASE_URL.
    buildRequest({ apiKey, model, baseUrl, prompt }) {
      const host = baseUrl || 'https://api.openai.com';
      return {
        url: `${host}/v1/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: model || 'gpt-4o-mini',
          temperature: 0.2,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        },
      };
    },
    extract(data) {
      return data?.choices?.[0]?.message?.content || null;
    },
  },
  anthropic: {
    buildRequest({ apiKey, model, baseUrl, prompt }) {
      const host = baseUrl || 'https://api.anthropic.com';
      return {
        url: `${host}/v1/messages`,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model: model || 'claude-sonnet-5',
          max_tokens: 1024,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        },
      };
    },
    extract(data) {
      const block = (data?.content || []).find((c) => c.type === 'text');
      return block?.text || null;
    },
  },
};

/**
 * Read configuration at call time, not import time.
 *
 * A module-level constant cannot be reconfigured after import, which is exactly
 * the bug that shipped in the operations service: the timeout could not be
 * changed at runtime and a test caught it only by hanging for the full duration.
 */
function readConfig(env = process.env) {
  const legacyGeminiKey = env.GEMINI_API_KEY;
  let provider = (env.LLM_PROVIDER || '').trim().toLowerCase();
  let apiKey = env.LLM_API_KEY;

  if (!provider && legacyGeminiKey) {
    provider = 'gemini';
    apiKey = apiKey || legacyGeminiKey;
  }

  if (!provider) provider = 'none';

  const timeoutMs = Number.parseInt(env.LLM_TIMEOUT_MS || '', 10);

  return {
    provider,
    apiKey,
    model: env.LLM_MODEL,
    baseUrl: (env.LLM_BASE_URL || '').replace(/\/$/, '') || undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS,
    usedLegacyKey: Boolean(!env.LLM_PROVIDER && legacyGeminiKey),
  };
}

function isConfigured(config = readConfig()) {
  return config.provider !== 'none'
    && Boolean(PROVIDERS[config.provider])
    && Boolean(config.apiKey);
}

function buildPrompt(question, context) {
  return [
    'You are ADAAS, a corporate HR assistant.',
    'Answer only from the provided context. Cite the source. If the context '
      + 'does not contain the answer, say so rather than guessing.',
    `Context:\n${context}`,
    `Question: ${question}`,
  ].join('\n\n');
}

/**
 * Generate an answer. Never throws and never hangs: returns
 * `{ text, reason }` where `text` is null on any failure and `reason` names it,
 * so the caller can fall back to the retrieved policy text and say why.
 */
async function generate(question, context, { env = process.env, fetchImpl = fetch } = {}) {
  const config = readConfig(env);

  if (!isConfigured(config)) {
    return { text: null, reason: 'not_configured' };
  }

  const provider = PROVIDERS[config.provider];
  const request = provider.buildRequest({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    prompt: buildPrompt(question, context),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { text: null, reason: `provider_status_${response.status}` };
    }

    const data = await response.json();
    const text = provider.extract(data);
    return text
      ? { text, reason: 'ok' }
      : { text: null, reason: 'empty_response' };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { text: null, reason: 'timeout' };
    }
    return { text: null, reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  PROVIDERS,
  readConfig,
  isConfigured,
  buildPrompt,
  generate,
};
