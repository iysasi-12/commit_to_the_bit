import "server-only";
import { ApiError as GenAiError, GoogleGenAI } from "@google/genai";
import { ApiError } from "@/lib/errors";
import { BUTLER_PERSONA, COACH_PERSONA, LENGTH_RULES, SYSTEM_PROMPT, type SummaryLength } from "@/lib/system-prompt";

export type Persona = "standard" | "butler" | "coach";

const PERSONAS: Record<Persona, string> = { standard: "", butler: BUTLER_PERSONA, coach: COACH_PERSONA };

export interface SummaryOptions {
  persona: Persona;
  length: SummaryLength;
}

const DEFAULT_OPTIONS: SummaryOptions = { persona: "standard", length: "medium" };

/** The exact prompt, plus the optional persona and length add-ons. */
function instructions(opts: SummaryOptions): string {
  return [SYSTEM_PROMPT, PERSONAS[opts.persona], LENGTH_RULES[opts.length]].filter(Boolean).join("\n\n");
}
import { wrapEmail } from "@/lib/triage";
import type { ParsedEmail } from "@/lib/gmail";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// If the main model is overloaded (common on the free tier), try this one instead.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
const CONCURRENCY = 4;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ApiError(503, "GEMINI_NOT_CONFIGURED", "GEMINI_API_KEY is missing from .env.local on the server.");
  client ??= new GoogleGenAI({ apiKey, httpOptions: { timeout: 30_000, retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 3 } } });
  return client;
}

function isBusy(err: unknown): boolean {
  return err instanceof GenAiError && [429, 500, 503, 504].includes(err.status);
}

function mapGeminiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof GenAiError) {
    if (err.status === 401 || err.status === 403) return new ApiError(503, "GEMINI_KEY", "Gemini rejected the API key. Check GEMINI_API_KEY in .env.local.");
    if (err.status === 404) return new ApiError(503, "GEMINI_MODEL", "Gemini doesn't recognize the model name. Check GEMINI_MODEL in .env.local.");
    if (err.status === 429) return new ApiError(429, "GEMINI_LIMIT", "Gemini's usage limit was reached. Wait a minute and try again.");
    return new ApiError(503, "GEMINI_BUSY", "Gemini is busy right now. Wait a few seconds and try again.");
  }
  return new ApiError(502, "GEMINI_ERROR", "Couldn't summarize with Gemini. Please try again.");
}

async function generate(model: string, email: ParsedEmail, opts: SummaryOptions): Promise<string> {
  const res = await getClient().models.generateContent({
    model,
    contents: wrapEmail(email),
    config: { systemInstruction: instructions(opts), temperature: 0.1, maxOutputTokens: 2048 },
  });
  return (res.text ?? "").trim();
}

/** Summarizes one email with the exact system prompt; returns "DISCARDED: SPAM" for spam. */
export async function summarizeEmail(email: ParsedEmail, opts: SummaryOptions = DEFAULT_OPTIONS): Promise<string> {
  try {
    return await generate(MODEL, email, opts);
  } catch (err) {
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL && isBusy(err)) {
      try {
        return await generate(FALLBACK_MODEL, email, opts);
      } catch (fallbackErr) {
        throw mapGeminiError(fallbackErr);
      }
    }
    throw mapGeminiError(err);
  }
}

/** Summarizes emails in parallel (a few at a time, to stay under free-tier rate limits). */
export async function summarizeAll(emails: ParsedEmail[], opts: SummaryOptions = DEFAULT_OPTIONS): Promise<Array<{ email: ParsedEmail; output: string | null; error?: string }>> {
  const results: Array<{ email: ParsedEmail; output: string | null; error?: string }> = new Array(emails.length);
  let next = 0;
  async function worker() {
    while (next < emails.length) {
      const i = next++;
      const email = emails[i]!;
      try {
        results[i] = { email, output: await summarizeEmail(email, opts) };
      } catch (err) {
        results[i] = { email, output: null, error: err instanceof ApiError ? err.message : "Summary failed." };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, emails.length) }, worker));
  return results;
}
