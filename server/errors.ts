/**
 * Every failure the API reports uses this shape so the UI can show a clear,
 * actionable message. `message` is written for the person using the app;
 * `detail` carries provider text that helps whoever runs the server.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: string,
    status: number,
    message: string,
    opts: { retryable?: boolean; detail?: string; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.detail ? { detail: this.detail } : {}),
        ...(this.retryAfterSeconds ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      },
    };
  }
}

export const Errors = {
  unauthenticated: () => new AppError("UNAUTHENTICATED", 401, "Please sign in first."),
  notFound: (what = "That item") => new AppError("NOT_FOUND", 404, `${what} was not found.`),
  validation: (message: string) => new AppError("VALIDATION", 400, message),
  consentRequired: () =>
    new AppError(
      "CONSENT_REQUIRED",
      403,
      "Before the AI can read your emails, please review and accept how your data is processed (Settings > Privacy).",
    ),
  notConfigured: (service: string, envVar: string) =>
    new AppError(
      "NOT_CONFIGURED",
      503,
      `${service} isn't set up on this server yet. The app owner needs to add ${envVar} to the .env file and restart.`,
    ),
  rateLimited: (retryAfterSeconds: number, what: string) =>
    new AppError("RATE_LIMITED", 429, `You've hit the limit for ${what}. Try again in about ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minute(s).`, {
      retryable: true,
      retryAfterSeconds,
    }),
};

export function truncateDetail(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
