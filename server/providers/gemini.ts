import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
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

const BLOCKED_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

/**
 * Maps Gemini API failures (documented codes: 401 invalid key, 403 permission denied,
 * 429 RESOURCE_EXHAUSTED, 402 prepay credits depleted, 503 overloaded) to clear messages.
 */
export function mapGeminiError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ApiError) {
    const detail = truncateDetail(err.message);
    const s = err.status;
    if (s === 401 || s === 403 || (s === 400 && /api[ _-]?key/i.test(err.message))) {
      return new AppError("AI_CONFIG", 503, "Gemini rejected this server's API key. The app owner should check GEMINI_API_KEY in the .env file.", { detail });
    }
    if (s === 429) {
      return new AppError(
        "AI_BUSY",
        429,
        "Gemini's usage limit was reached (free-tier keys have per-minute and per-day limits). Wait a minute and try again.",
        { retryable: true, detail },
      );
    }
    if (s === 402) {
      return new AppError("AI_QUOTA", 402, "The Gemini account behind this app is out of credit. The app owner needs to add credit in Google AI Studio.", { detail });
    }
    if (s === 404) {
      return new AppError("AI_CONFIG", 503, "Gemini doesn't recognize the model name. The app owner should check GEMINI_MODEL in the .env file.", { detail });
    }
    if (s === 503 || s === 504) {
      return new AppError("AI_BUSY", 503, "Gemini is very busy right now. Wait a few seconds and try again.", { retryable: true, detail });
    }
    if (s >= 500) {
      return new AppError("AI_UNAVAILABLE", 502, "Gemini had a temporary problem. Please try again.", { retryable: true, detail });
    }
    return new AppError("AI_ERROR", 502, "Gemini couldn't process this request. If it keeps happening, the app owner should check the server logs.", { detail });
  }
  if (err instanceof TypeError) {
    return new AppError("AI_UNAVAILABLE", 502, "Couldn't reach Gemini. Check the connection and try again.", { retryable: true });
  }
  return new AppError("AI_ERROR", 500, "Something went wrong while writing the summary.", { detail: truncateDetail(String(err)) });
}

/** Busy or slow model: worth trying the backup model once. */
function isBusy(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 429 || err.status === 503 || err.status === 504);
}

/** Google Gemini through the official @google/genai SDK. */
export class GeminiAiProvider implements AiProvider {
  readonly mode = "live" as const;
  readonly name = "gemini" as const;
  readonly model: string;
  readonly fallbackModel: string | null;
  private readonly client: GoogleGenAI;

  constructor(cfg: { apiKey: string; model: string; fallbackModel?: string | null }, opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.model = cfg.model;
    this.fallbackModel = cfg.fallbackModel && cfg.fallbackModel !== cfg.model ? cfg.fallbackModel : null;
    this.client = new GoogleGenAI({
      apiKey: cfg.apiKey,
      httpOptions: {
        // The SDK's default is 5 attempts with waits of up to a minute, which leaves
        // people staring at a spinner. One quick retry, a time limit, then the backup model.
        timeout: opts.timeoutMs ?? 25_000,
        retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 3 },
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      },
    });
  }

  /** Calls the main model, and the backup model once if the main one is overloaded or slow. */
  private async generate(contents: string, config: Record<string, unknown>): Promise<GenerateContentResponse> {
    try {
      return await this.client.models.generateContent({ model: this.model, contents, config });
    } catch (err) {
      if (this.fallbackModel && isBusy(err)) {
        try {
          return await this.client.models.generateContent({ model: this.fallbackModel, contents, config });
        } catch (fallbackErr) {
          throw mapGeminiError(fallbackErr);
        }
      }
      throw mapGeminiError(err);
    }
  }

  private textOf(response: GenerateContentResponse): string {
    if (response.promptFeedback?.blockReason) {
      throw new AppError("AI_REFUSED", 422, "Gemini declined to read these emails. Try a different email or category.");
    }
    const finish = String(response.candidates?.[0]?.finishReason ?? "");
    if (BLOCKED_FINISH.has(finish)) {
      throw new AppError("AI_REFUSED", 422, "Gemini declined to summarize these emails. Try a different email or category.");
    }
    if (finish === "MAX_TOKENS") {
      throw new AppError("AI_ERROR", 502, "The AI ran out of room before finishing. Try summarizing fewer emails.");
    }
    return (response.text ?? "").trim();
  }

  async classify(emails: ClassifyInput, categories: CategoryForAi[]): Promise<Map<string, string>> {
    if (emails.length === 0) return new Map();
    const names = categories.map((c) => c.name);
    const response = await this.generate(buildClassifyPrompt(emails, categories), {
      systemInstruction: CLASSIFY_SYSTEM,
      responseMimeType: "application/json",
      responseJsonSchema: classifySchema(names),
      maxOutputTokens: 8000,
    });
    return parseClassification(this.textOf(response), emails, names);
  }

  async summarize(req: SummaryRequest): Promise<string> {
    const response = await this.generate(buildSummaryPrompt(req), { systemInstruction: SUMMARY_SYSTEM, maxOutputTokens: 8000 });
    const text = cleanSpokenText(this.textOf(response));
    if (!text) throw new AppError("AI_ERROR", 502, "The AI returned an empty summary. Please try again.", { retryable: true });
    return text;
  }
}
