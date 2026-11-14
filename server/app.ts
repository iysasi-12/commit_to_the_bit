import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { currentConsentVersion, type AppDeps } from "./context.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { CATEGORY_COLORS, type UserRow } from "./db.ts";
import { AppError, Errors } from "./errors.ts";
import { MINUTE } from "./rateLimit.ts";
import { AccountService } from "./services/account.ts";
import { InboxService, requireConsent } from "./services/inbox.ts";
import { SummaryService, summaryToApi } from "./services/summaries.ts";
import { VoiceService, voiceRowToApi, type ResolvedVoice } from "./services/voices.ts";
import type { AudioRow } from "./db.ts";

const SESSION_COOKIE = "iv_session";
const OAUTH_COOKIE = "iv_oauth";
const SESSION_TTL_MS = 30 * 24 * 3600_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "mp4", "aac", "webm", "ogg", "oga", "opus", "flac", "weba"]);

export interface AppServices {
  inbox: InboxService;
  summaries: SummaryService;
  voices: VoiceService;
  account: AccountService;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw Errors.validation(`${where}${issue?.message ?? "Invalid request."}`);
  }
  return result.data;
}

function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string" || !ID_PATTERN.test(v)) throw Errors.notFound();
  return v;
}

function audioToApi(row: AudioRow, voice: Pick<ResolvedVoice, "name" | "kind"> | null, cached: boolean) {
  return {
    audio: {
      id: row.id,
      url: `/api/audio/${row.id}`,
      mime: row.mime,
      voiceMode: row.voice_mode,
      voiceName: voice?.name ?? null,
      voiceKind: voice?.kind ?? null,
      chars: row.chars,
    },
    cached,
  };
}

const SettingsBody = z
  .object({
    summaryLength: z.enum(["brief", "detailed"]),
    speakingSpeed: z.number().min(0.8).max(1.2),
    summaryCount: z.number().int().min(3).max(15),
    autoPlay: z.boolean(),
    autoSort: z.boolean(),
  })
  .partial()
  .strict();

const SummaryBody = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("one"), messageId: z.string().regex(ID_PATTERN) }),
  z.object({ scope: z.literal("many"), categoryId: z.string().regex(ID_PATTERN).nullable().optional() }),
]);

export function createApp(deps: AppDeps): { app: express.Express; services: AppServices } {
  const { config, store, providers, limiter } = deps;
  const inbox = new InboxService(deps);
  const voices = new VoiceService(deps);
  const summaries = new SummaryService(deps, inbox);
  const account = new AccountService(deps, voices, inbox);
  const users = new WeakMap<Request, UserRow>();
  const consentVersion = currentConsentVersion(providers);

  const app = express();
  app.disable("x-powered-by");

  // ---------- security basics ----------
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    // The OAuth code arrives in the URL; never leak it through Referer.
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
    next();
  });

  app.use(express.json({ limit: "64kb" }));

  // ---------- sessions ----------
  app.use((req, _res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const user = store.getSessionUser(sha256(token), deps.now());
      if (user) users.set(req, user);
    }
    next();
  });

  function currentUser(req: Request): UserRow {
    const user = users.get(req);
    if (!user) throw Errors.unauthenticated();
    return user;
  }

  function startSession(res: Response, userId: string): void {
    const token = randomToken();
    store.createSession(sha256(token), userId, deps.now(), SESSION_TTL_MS);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
  }

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    currentUser(req);
    next();
  };

  // Cross-site request forgery: state-changing API calls must carry a custom header,
  // which other sites can't add without a CORS preflight this server never approves.
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("x-inbox-voice") !== "1") {
      throw new AppError("CSRF", 403, "This request was blocked for your safety. Reload the page and try again.");
    }
    next();
  });

  // ---------- public config ----------
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      demoMode: config.demoMode,
      consentVersion,
      aiProvider: providers.ai?.name ?? null,
      signIn: { google: Boolean(providers.googleAuth), demo: config.demoMode },
      services: {
        gmail: providers.liveMail ? "live" : "unavailable",
        ai: providers.ai?.mode ?? "unavailable",
        voice: providers.voice?.mode ?? "unavailable",
      },
      aiModel: providers.ai?.mode === "live" ? providers.ai.model : null,
      voiceModel: providers.voice?.mode === "live" ? config.elevenlabs?.modelId : null,
      limits: {
        summaryMaxEmails: config.limits.summaryMaxEmails,
        cloneMaxFiles: config.limits.cloneMaxFiles,
        cloneMaxFileMb: Math.round(config.limits.cloneMaxFileBytes / (1024 * 1024)),
        maxCategories: config.limits.maxCategories,
        cacheTtlHours: config.cacheTtlHours,
      },
    });
  });

  // ---------- Google sign-in ----------
  app.get("/auth/google/start", (req, res) => {
    limiter.consume(`auth:${req.ip}`, config.rateLimits.authPerMinute, MINUTE, "sign-in attempts");
    if (!providers.googleAuth) {
      res.redirect("/?signin_error=GOOGLE_NOT_CONFIGURED");
      return;
    }
    const state = randomToken(24);
    store.saveOAuthState(sha256(state), deps.now());
    // Bind the state to this browser too, so a link started elsewhere can't complete here.
    res.cookie(OAUTH_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: config.secureCookies, maxAge: OAUTH_STATE_TTL_MS, path: "/auth" });
    res.redirect(providers.googleAuth.authorizationUrl(state));
  });

  app.get("/auth/google/callback", async (req, res) => {
    const fail = (code: string) => {
      res.clearCookie(OAUTH_COOKIE, { path: "/auth" });
      res.redirect(`/?signin_error=${encodeURIComponent(code)}`);
    };
    try {
      limiter.consume(`auth:${req.ip}`, config.rateLimits.authPerMinute, MINUTE, "sign-in attempts");
      if (!providers.googleAuth || !deps.tokens) return fail("GOOGLE_NOT_CONFIGURED");
      if (typeof req.query.error === "string") return fail(req.query.error === "access_denied" ? "ACCESS_DENIED" : "GOOGLE_ERROR");
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const cookieState = readCookie(req, OAUTH_COOKIE);
      if (!state || !code || !cookieState || cookieState !== state || !store.consumeOAuthState(sha256(state), deps.now(), OAUTH_STATE_TTL_MS)) {
        return fail("STATE_MISMATCH");
      }
      const identity = await providers.googleAuth.exchangeCode(code);
      let user = store.getUserByGoogleSub(identity.sub);
      if (user) {
        store.updateUserProfile(user.id, identity.email, identity.name);
      } else {
        user = store.createUser({ googleSub: identity.sub, email: identity.email, name: identity.name, isDemo: false, now: deps.now() });
      }
      deps.tokens.save(user.id, identity);
      res.clearCookie(OAUTH_COOKIE, { path: "/auth" });
      startSession(res, user.id);
      res.redirect("/");
    } catch (err) {
      if (err instanceof AppError) {
        if (err.status >= 500) console.error("[auth]", err.code, err.detail ?? err.message);
        return fail(err.code);
      }
      console.error("[auth] unexpected", err);
      return fail("GOOGLE_ERROR");
    }
  });

  app.post("/api/auth/demo", (req, res) => {
    if (!config.demoMode) throw Errors.notFound("Demo sign-in");
    limiter.consume(`auth:${req.ip}`, config.rateLimits.authPerMinute, MINUTE, "sign-in attempts");
    const user = store.createUser({ googleSub: null, email: "demo@example.com", name: "Alex", isDemo: true, now: deps.now() });
    startSession(res, user.id);
    res.status(201).json({ ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) store.deleteSession(sha256(token));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // ---------- me, consent, settings ----------
  function meToApi(user: UserRow) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      isDemo: Boolean(user.is_demo),
      mailMode: user.is_demo ? "demo" : "live",
      consent: {
        accepted: Boolean(user.ai_consent_at) && user.ai_consent_version === consentVersion,
        acceptedAt: user.ai_consent_at,
        version: user.ai_consent_version,
      },
      settings: store.getSettings(user),
      selectedVoiceRef: user.selected_voice_ref,
    };
  }

  app.get("/api/me", (req, res) => {
    res.json({ user: meToApi(currentUser(req)) });
  });

  app.post("/api/consent", (req, res) => {
    const user = currentUser(req);
    parse(z.object({ accept: z.literal(true), version: z.literal(consentVersion) }), req.body);
    store.setConsent(user.id, deps.now(), consentVersion);
    res.json({ user: meToApi(store.getUser(user.id)!) });
  });

  app.delete("/api/consent", (req, res) => {
    const user = currentUser(req);
    account.revokeConsent(user);
    res.json({ user: meToApi(store.getUser(user.id)!) });
  });

  app.patch("/api/settings", (req, res) => {
    const user = currentUser(req);
    const patch = parse(SettingsBody, req.body);
    const next = { ...store.getSettings(user), ...patch };
    next.summaryCount = Math.min(next.summaryCount, config.limits.summaryMaxEmails);
    store.saveSettings(user.id, next);
    res.json({ user: meToApi(store.getUser(user.id)!) });
  });

  // ---------- inbox & messages ----------
  app.get("/api/inbox", async (req, res) => {
    const user = currentUser(req);
    const result = await inbox.list(user, { refresh: req.query.refresh === "1" });
    res.json(result);
  });

  app.post("/api/inbox/classify", async (req, res) => {
    const user = currentUser(req);
    const result = await inbox.classify(user);
    res.json({ ...result, ...(await inbox.list(user)) });
  });

  app.get("/api/messages/:id", async (req, res) => {
    const user = currentUser(req);
    const id = param(req, "id");
    const message = await inbox.mailFor(user).getMessage(user.id, id, 20_000);
    const assigned = store.getClassifications(user.id, user.categories_version);
    res.json({ message: { ...message, categoryId: assigned.get(id) ?? null } });
  });

  // ---------- categories ----------
  function categoriesToApi(userId: string) {
    const fresh = store.getUser(userId)!;
    return {
      categoriesVersion: fresh.categories_version,
      categories: store.listCategories(userId).map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        color: c.color,
        isFallback: Boolean(c.is_fallback),
      })),
    };
  }

  const CategoryBody = z.object({
    name: z.string().trim().min(1, "Give the category a name.").max(config.limits.categoryNameChars, `Keep the name under ${config.limits.categoryNameChars} characters.`),
    description: z.string().trim().max(config.limits.categoryDescriptionChars).default(""),
  });

  function assertUniqueName(userId: string, name: string, exceptId?: string) {
    const clash = store.listCategories(userId).find((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== exceptId);
    if (clash) throw Errors.validation(`You already have a category called "${clash.name}".`);
  }

  app.get("/api/categories", (req, res) => {
    res.json(categoriesToApi(currentUser(req).id));
  });

  app.post("/api/categories", (req, res) => {
    const user = currentUser(req);
    const body = parse(CategoryBody, req.body);
    const existing = store.listCategories(user.id);
    if (existing.length >= config.limits.maxCategories) {
      throw new AppError("LIMIT_REACHED", 409, `You can have up to ${config.limits.maxCategories} categories.`);
    }
    assertUniqueName(user.id, body.name);
    const used = new Set(existing.map((c) => c.color));
    const color = CATEGORY_COLORS.find((c) => !used.has(c)) ?? CATEGORY_COLORS[existing.length % CATEGORY_COLORS.length]!;
    store.insertCategory(user.id, body.name, body.description, color);
    store.bumpCategoriesVersion(user.id);
    res.status(201).json(categoriesToApi(user.id));
  });

  app.patch("/api/categories/:id", (req, res) => {
    const user = currentUser(req);
    const id = param(req, "id");
    const category = store.getCategory(user.id, id);
    if (!category) throw Errors.notFound("That category");
    const body = parse(CategoryBody, req.body);
    assertUniqueName(user.id, body.name, id);
    store.updateCategory(user.id, id, body.name, body.description);
    store.bumpCategoriesVersion(user.id);
    res.json(categoriesToApi(user.id));
  });

  app.delete("/api/categories/:id", (req, res) => {
    const user = currentUser(req);
    const id = param(req, "id");
    const category = store.getCategory(user.id, id);
    if (!category) throw Errors.notFound("That category");
    if (category.is_fallback) throw Errors.validation(`"${category.name}" catches everything else, so it can't be deleted. You can rename it.`);
    store.deleteCategory(user.id, id);
    store.bumpCategoriesVersion(user.id);
    res.json(categoriesToApi(user.id));
  });

  app.post("/api/categories/reset", (req, res) => {
    const user = currentUser(req);
    store.replaceCategoriesWithDefaults(user.id);
    store.bumpCategoriesVersion(user.id);
    res.json(categoriesToApi(user.id));
  });

  // ---------- summaries & audio ----------
  app.post("/api/summaries", async (req, res) => {
    const user = currentUser(req);
    const body = parse(SummaryBody, req.body);
    const result =
      body.scope === "one" ? await summaries.summarizeOne(user, body.messageId) : await summaries.summarizeMany(user, { categoryId: body.categoryId ?? null });
    res.json({ summary: summaryToApi(result.summary), cached: result.cached });
  });

  app.post("/api/summaries/:id/audio", async (req, res) => {
    const user = currentUser(req);
    requireConsent(user, deps);
    const summary = store.getSummary(user.id, param(req, "id"));
    if (!summary) throw Errors.notFound("That summary");
    const voice = await voices.resolve(user);
    const result = await voices.speak(user, { text: summary.text, voice, summaryId: summary.id, purpose: "summary" });
    res.json(audioToApi(result.audio, voice, result.cached));
  });

  app.get("/api/audio/:id", (req, res) => {
    const user = currentUser(req);
    const row = store.getAudio(user.id, param(req, "id"));
    // Another person's audio is indistinguishable from audio that doesn't exist.
    if (!row) throw Errors.notFound("That audio");
    const filePath = deps.files.audioPath(user.id, row.file_name);
    if (!deps.files.exists(filePath)) throw Errors.notFound("That audio");
    res.setHeader("Cache-Control", "private, no-store");
    res.type(row.mime);
    res.sendFile(filePath);
  });

  // ---------- voices ----------
  app.get("/api/voices", async (req, res) => {
    const user = currentUser(req);
    const mode = providers.voice?.mode ?? "unavailable";
    let stock: Awaited<ReturnType<VoiceService["stockVoices"]>> = [];
    let stockError: string | null = null;
    let selected: ResolvedVoice | null = null;
    if (providers.voice) {
      try {
        stock = await voices.stockVoices();
        selected = await voices.resolve(store.getUser(user.id)!);
      } catch (err) {
        stockError = err instanceof AppError ? err.message : "Couldn't load voices.";
      }
    } else {
      stockError = Errors.notConfigured("The voice service", "ELEVENLABS_API_KEY").message;
    }
    res.json({
      mode,
      selected,
      stock,
      stockError,
      mine: store.listVoices(user.id).map(voiceRowToApi),
    });
  });

  app.get("/api/voices/capabilities", async (req, res) => {
    currentUser(req);
    if (!providers.voice) {
      res.json({ mode: "unavailable", canClone: false, message: Errors.notConfigured("The voice service", "ELEVENLABS_API_KEY").message });
      return;
    }
    try {
      const caps = await providers.voice.capabilities();
      res.json({
        mode: providers.voice.mode,
        canClone: caps.canClone,
        message: caps.canClone ? null : "Voice cloning isn't included in the ElevenLabs plan behind this app. Instant Voice Cloning needs a paid plan.",
      });
    } catch (err) {
      res.json({ mode: providers.voice.mode, canClone: false, message: err instanceof AppError ? err.message : "Couldn't check voice cloning." });
    }
  });

  app.put("/api/voices/selected", async (req, res) => {
    const user = currentUser(req);
    const { ref } = parse(z.object({ ref: z.string().max(140) }), req.body);
    const selected = await voices.select(user, ref);
    res.json({ selected });
  });

  app.get("/api/voices/library", async (req, res) => {
    currentUser(req);
    const search = typeof req.query.search === "string" ? req.query.search : "";
    const page = Number.parseInt(typeof req.query.page === "string" ? req.query.page : "0", 10) || 0;
    res.json(await voices.searchLibrary(search, page));
  });

  app.post("/api/voices/library", async (req, res) => {
    const user = currentUser(req);
    const body = parse(
      z.object({
        publicOwnerId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        providerVoiceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        name: z.string().trim().min(1).max(60),
      }),
      req.body,
    );
    const row = await voices.addLibraryVoice(user, body);
    res.status(201).json({ voice: voiceRowToApi(row) });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.limits.cloneMaxFileBytes, files: config.limits.cloneMaxFiles, fields: 10, fieldSize: 2000 },
    fileFilter: (_req, file, cb) => {
      const ext = (file.originalname.split(".").pop() ?? "").toLowerCase();
      const mime = file.mimetype.toLowerCase();
      const ok = mime.startsWith("audio/") || mime === "video/webm" || mime === "video/mp4" || (mime === "application/octet-stream" && AUDIO_EXTENSIONS.has(ext));
      if (ok) cb(null, true);
      else cb(new AppError("UNSUPPORTED_MEDIA", 415, "That file isn't an audio recording. Use MP3, WAV, M4A, WebM, OGG, or FLAC."));
    },
  });

  app.post("/api/voices/clone", requireAuth, upload.array("audio", config.limits.cloneMaxFiles), async (req, res) => {
    const user = currentUser(req);
    const body = parse(
      z.object({
        name: z.string().max(40).default(""),
        consentOwnVoice: z.string().optional(),
        consentProcessing: z.string().optional(),
        removeNoise: z.string().optional(),
        keepRecording: z.string().optional(),
      }),
      req.body ?? {},
    );
    const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ buffer: f.buffer, filename: f.originalname || "recording.webm", mime: f.mimetype }));
    const row = await voices.createClone(user, {
      name: body.name,
      files,
      consentOwnVoice: body.consentOwnVoice === "true",
      consentProcessing: body.consentProcessing === "true",
      removeNoise: body.removeNoise === "true",
      keepRecording: body.keepRecording === "true",
    });
    res.status(201).json({ voice: voiceRowToApi(row) });
  });

  app.post("/api/voices/:id/preview", async (req, res) => {
    const user = currentUser(req);
    const id = param(req, "id");
    const row = store.getVoice(user.id, id);
    const result = await voices.preview(user, id);
    res.json(audioToApi(result.audio, row ? { name: row.name, kind: row.kind } : null, result.cached));
  });

  app.post("/api/voices/:id/approve", (req, res) => {
    const user = currentUser(req);
    const row = voices.approve(user, param(req, "id"));
    res.json({ voice: voiceRowToApi(row) });
  });

  app.delete("/api/voices/:id/recording", (req, res) => {
    const user = currentUser(req);
    voices.deleteRecording(user, param(req, "id"));
    res.json({ ok: true });
  });

  app.delete("/api/voices/:id", async (req, res) => {
    const user = currentUser(req);
    const result = await voices.deleteVoice(user, param(req, "id"));
    res.json({ ok: true, ...result });
  });

  // ---------- account ----------
  app.post("/api/account/clear-cache", (req, res) => {
    const user = currentUser(req);
    res.json({ ok: true, ...account.clearGenerated(user) });
  });

  app.delete("/api/account", async (req, res) => {
    const user = currentUser(req);
    const result = await account.deleteAccount(user);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true, ...result });
  });

  app.use("/api", (_req, _res, next) => {
    next(Errors.notFound("That API route"));
  });

  // ---------- errors ----------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    let appErr: AppError;
    if (err instanceof AppError) {
      appErr = err;
    } else if (err instanceof multer.MulterError) {
      appErr =
        err.code === "LIMIT_FILE_SIZE"
          ? new AppError("PAYLOAD_TOO_LARGE", 413, `Each recording must be under ${Math.round(config.limits.cloneMaxFileBytes / (1024 * 1024))} MB. Two minutes of speech is plenty.`)
          : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
            ? new AppError("TOO_MANY_FILES", 400, `Upload at most ${config.limits.cloneMaxFiles} recordings.`)
            : new AppError("UPLOAD_ERROR", 400, "The upload couldn't be read. Please try again.");
    } else if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed") {
      appErr = Errors.validation("The request body isn't valid JSON.");
    } else if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.too.large") {
      appErr = new AppError("PAYLOAD_TOO_LARGE", 413, "That request is too large.");
    } else {
      console.error("[unexpected]", err);
      appErr = new AppError("INTERNAL", 500, "Something went wrong on our side. Please try again.");
    }
    if (appErr.status >= 500 && appErr.code !== "INTERNAL") console.error(`[${appErr.code}]`, appErr.detail ?? appErr.message);
    if (appErr.retryAfterSeconds) res.setHeader("Retry-After", String(appErr.retryAfterSeconds));
    res.status(appErr.status).json(appErr.toJSON());
  });

  return { app, services: { inbox, summaries, voices, account } };
}

/** Deletes cached summaries/audio past their lifetime, expired sessions and stale sign-in states. */
export function runHousekeeping(deps: AppDeps): void {
  const now = deps.now();
  const before = now - deps.config.cacheTtlHours * 3600_000;
  for (const row of deps.store.expiredAudio(before)) {
    deps.files.remove(deps.files.audioPath(row.user_id, row.file_name));
    deps.store.deleteAudioRow(row.user_id, row.id);
  }
  deps.store.purgeExpired(now, before);
}
