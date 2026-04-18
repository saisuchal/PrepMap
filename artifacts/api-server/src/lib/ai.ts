import Anthropic from "@anthropic-ai/sdk";

type AiProvider = "anthropic" | "openai";
type AskAiOptions = {
  requireJson?: boolean;
};

function resolveProvider(raw: string | undefined): AiProvider {
  const value = (raw || "anthropic").toLowerCase();
  if (value === "anthropic" || value === "openai") return value;
  throw new Error(`Invalid AI_PROVIDER "${raw}". Use "anthropic" or "openai".`);
}

function parseIntervalMs(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

const aiProvider = resolveProvider(process.env.AI_PROVIDER);
const aiModel = process.env.AI_MODEL || (aiProvider === "openai" ? "gpt-5-mini" : "claude-sonnet-4-5");

const anthropicApiKey =
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
const anthropicBaseUrl =
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;

const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const REQUEST_INTERVAL_MS = parseIntervalMs(
  process.env.AI_REQUEST_INTERVAL_MS,
  parseIntervalMs(
    aiProvider === "openai"
      ? process.env.OPENAI_REQUEST_INTERVAL_MS
      : process.env.ANTHROPIC_REQUEST_INTERVAL_MS,
    aiProvider === "openai" ? 0 : 3500
  )
);

let lastRequestTime = 0;

async function rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (REQUEST_INTERVAL_MS > 0 && elapsed < REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
  return fn();
}

function getAnthropicClient(): Anthropic {
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return new Anthropic({
    apiKey: anthropicApiKey,
    baseURL: anthropicBaseUrl,
  });
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

async function callOpenAiChatCompletions(
  systemPrompt: string,
  userContent: string | OpenAiContentPart[],
  maxTokens: number,
  options?: AskAiOptions
): Promise<string> {
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not set");

  const basePayload = {
    model: aiModel,
    ...(options?.requireJson ? { response_format: { type: "json_object" as const } } : {}),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  const requestWithPayload = async (payload: object) =>
    fetch(`${openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify(payload),
    });

  // Newer OpenAI models (including GPT-5 family) expect max_completion_tokens.
  let response = await requestWithPayload({
    ...basePayload,
    max_completion_tokens: maxTokens,
  });

  // Backward-compat fallback for endpoints/models that still require max_tokens.
  if (!response.ok) {
    const errorText = await response.text();
    if (
      response.status === 400 &&
      /max_completion_tokens/i.test(errorText) &&
      /(unsupported|unknown|invalid)/i.test(errorText)
    ) {
      response = await requestWithPayload({
        ...basePayload,
        max_tokens: maxTokens,
      });
    } else {
      throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        refusal?: string | null;
        parsed?: unknown;
        content?:
          | string
          | Array<{ type?: string; text?: string | { value?: string }; value?: string; json?: unknown }>;
      };
    }>;
  };

  const firstChoice = data.choices?.[0];
  const message = firstChoice?.message;
  const parsed = message?.parsed;
  if (parsed != null) {
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  }
  const content = message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed) return trimmed;
  }
  if (Array.isArray(content)) {
    const merged = content
      .map((part) => {
        if (!part) return "";
        if (typeof part.text === "string") return part.text;
        if (part.text && typeof part.text === "object" && typeof part.text.value === "string") return part.text.value;
        if (typeof part.value === "string") return part.value;
        if (part.json != null) return typeof part.json === "string" ? part.json : JSON.stringify(part.json);
        return "";
      })
      .join("")
      .trim();
    if (merged) return merged;
  }

  const refusal = typeof message?.refusal === "string" ? message.refusal.trim() : "";
  const finishReason = firstChoice?.finish_reason || "unknown";
  if (refusal) {
    throw new Error(`OpenAI refusal: ${refusal}`);
  }
  throw new Error(`OpenAI returned empty content (finish_reason=${finishReason})`);
}

export async function askAI(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 4000,
  options?: AskAiOptions
): Promise<string> {
  return rateLimitedRequest(async () => {
    if (aiProvider === "openai") {
      return callOpenAiChatCompletions(systemPrompt, userMessage, maxTokens, options);
    }

    const response = await getAnthropicClient().messages.create({
      model: aiModel,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = response.content[0];
    if (block.type === "text") return block.text;
    return "";
  });
}

export async function askAIWithImage(
  systemPrompt: string,
  textMessage: string,
  imageBase64: string,
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp",
  maxTokens = 4000,
  options?: AskAiOptions
): Promise<string> {
  return rateLimitedRequest(async () => {
    if (aiProvider === "openai") {
      const dataUrl = `data:${mediaType};base64,${imageBase64}`;
      return callOpenAiChatCompletions(
        systemPrompt,
        [
          { type: "text", text: textMessage },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
        maxTokens,
        options
      );
    }

    const response = await getAnthropicClient().messages.create({
      model: aiModel,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: imageBase64 },
            },
            { type: "text", text: textMessage },
          ],
        },
      ],
    });

    const block = response.content[0];
    if (block.type === "text") return block.text;
    return "";
  });
}
