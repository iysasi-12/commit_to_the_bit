import Anthropic from "@anthropic-ai/sdk";
import { AppError, truncateDetail } from "../errors.ts";
import {
  buildClassifyPrompt,
  buildSummaryPrompt,
  CLASSIFY_SYSTEM,
  classifySchema,
  cleanSpokenText,
  parseClassification,
  SUMMARY_SYSTEM,
  type ClassifyInput,
} from "./prompts.ts";
import type { AiProvider, CategoryForAi, SummaryRequest } from "./types.ts";

export { buildClassifyPrompt, buildSummaryPrompt, CLASSIFY_SYSTEM, cleanSpokenText, SUMMARY_SYSTEM };

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function mapAnthropicError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError("AI_CONFIG", 503, "The AI service rejected this server's API key. The app owner should check ANTHROPIC_API_KEY.", {
      detail: truncateDetail(err.message),
    });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError("AI_BUSY", 429, "The AI service is busy right now. Wait a moment and try again.", { retryable: true });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AppError("AI_ERROR", 502, "The AI service couldn't process this request. If it keeps happening, the app owner should check the server logs and Anthropic account billing.", {
      detail: truncateDetail(err.message),
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError("AI_UNAVAILABLE", 502, "Couldn't reach the AI service. Check the connection and try again.", { retryable: true });
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError("AI_UNAVAILABLE", 502, "The AI service had a temporary problem. Please try again.", { retryable: true, detail: truncateDetail(err.message) });
  }
  return new AppError("AI_ERROR", 500, "Something went wrong while writing the summary.", { detail: truncateDetail(String(err)) });
}

/** Claude through the official Anthropic SDK. */
export class AnthropicAiProvider implements AiProvider {
  readonly mode = "live" as const;
  readonly name = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly refusalFallback: boolean;

  constructor(cfg: { apiKey: string; model: string; refusalFallback: boolean }, clientOptions: { fetch?: typeof fetch; maxRetries?: number } = {}) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: clientOptions.maxRetries ?? 2, ...(clientOptions.fetch ? { fetch: clientOptions.fetch } : {}) });
    this.model = cfg.model;
    this.refusalFallback = cfg.refusalFallback;
  }

  private fallbackParams() {
    return this.refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {};
  }

  private textOf(response: Anthropic.Beta.BetaMessage): string {
    if (response.stop_reason === "refusal") {
      throw new AppError("AI_REFUSED", 422, "The AI declined to summarize these emails. Try a different email or category.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new AppError("AI_ERROR", 502, "The AI ran out of room before finishing. Try summarizing fewer emails.");
    }
    return response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  async classify(emails: ClassifyInput, categories: CategoryForAi[]): Promise<Map<string, string>> {
    if (emails.length === 0) return new Map();
    const names = categories.map((c) => c.name);
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 8000,
        system: CLASSIFY_SYSTEM,
        output_config: { effort: "low", format: { type: "json_schema", schema: classifySchema(names) } },
        messages: [{ role: "user", content: buildClassifyPrompt(emails, categories) }],
        ...this.fallbackParams(),
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }
    return parseClassification(this.textOf(response), emails, names);
  }

  async summarize(req: SummaryRequest): Promise<string> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 8000,
        system: SUMMARY_SYSTEM,
        output_config: { effort: "medium" },
        messages: [{ role: "user", content: buildSummaryPrompt(req) }],
        ...this.fallbackParams(),
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const text = cleanSpokenText(this.textOf(response));
    if (!text) throw new AppError("AI_ERROR", 502, "The AI returned an empty summary. Please try again.", { retryable: true });
    return text;
  }
}
