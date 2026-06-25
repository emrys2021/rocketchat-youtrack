import { fetchJson } from './http.js';

export class LlmClient {
  constructor(options) {
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature ?? 0.2;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.maxOutputTokens = options.maxOutputTokens ?? 1600;
  }

  async chat(messages, tools = undefined) {
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxOutputTokens
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const response = await fetchJson(
      this.apiUrl,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      },
      this.timeoutMs
    );

    const message = response?.choices?.[0]?.message;
    if (!message) {
      throw new Error('LLM response did not include choices[0].message');
    }

    return message;
  }
}

export function parseToolArguments(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
