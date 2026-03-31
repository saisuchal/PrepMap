import Anthropic from "@anthropic-ai/sdk";

const anthropicApiKey =
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
const anthropicBaseUrl =
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;

function getClient(): Anthropic {
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return new Anthropic({
    apiKey: anthropicApiKey,
    baseURL: anthropicBaseUrl,
  });
}

const REQUEST_INTERVAL_MS = Number(process.env.ANTHROPIC_REQUEST_INTERVAL_MS ?? "3500");
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

export async function askClaude(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 4000
): Promise<string> {
  return rateLimitedRequest(async () => {
    const response = await getClient().messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text;
    return "";
  });
}

export async function askClaudeWithImage(
  systemPrompt: string,
  textMessage: string,
  imageBase64: string,
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp",
  maxTokens = 4000
): Promise<string> {
  return rateLimitedRequest(async () => {
    const response = await getClient().messages.create({
      model: "claude-sonnet-4-5",
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
