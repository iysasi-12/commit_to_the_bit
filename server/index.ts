import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createApp, runHousekeeping } from "./app.ts";
import { loadConfig } from "./config.ts";
import type { AppDeps, Providers } from "./context.ts";
import { TokenCipher } from "./crypto.ts";
import { Store } from "./db.ts";
import { AnthropicAiProvider } from "./providers/anthropic.ts";
import { DemoAiProvider, DemoMailProvider, DemoVoiceProvider } from "./providers/demo.ts";
import { ElevenLabsVoiceProvider } from "./providers/elevenlabs.ts";
import { GmailMailProvider, GoogleOAuth, GoogleTokenService } from "./providers/google.ts";
import { RateLimiter } from "./rateLimit.ts";
import { FileStore } from "./storage.ts";

const dev = process.argv.includes("--dev");
const config = loadConfig();
const store = new Store(config.dataDir);
const files = new FileStore(config.dataDir);
const cipher = new TokenCipher(config.sessionSecret);

const googleAuth = config.google ? new GoogleOAuth(config.google) : null;
const tokens = googleAuth ? new GoogleTokenService(store, cipher, googleAuth) : null;

const providers: Providers = {
  googleAuth,
  liveMail: tokens ? new GmailMailProvider(tokens) : null,
  demoMail: new DemoMailProvider(),
  ai: config.anthropic ? new AnthropicAiProvider(config.anthropic) : config.demoMode ? new DemoAiProvider() : null,
  voice: config.elevenlabs ? new ElevenLabsVoiceProvider(config.elevenlabs) : config.demoMode ? new DemoVoiceProvider() : null,
};

const deps: AppDeps = { config, store, files, providers, tokens, limiter: new RateLimiter(), now: Date.now };
const { app } = createApp(deps);

// ---------- web front end ----------
const webRoot = path.resolve("web");
if (dev) {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa", configFile: path.resolve("vite.config.ts") });
  app.use(vite.middlewares);
} else {
  const dist = path.join(webRoot, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    console.error("The web app hasn't been built. Run `npm run build` first, or use `npm run dev`.");
    process.exit(1);
  }
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/|\/auth\/).*/, (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

runHousekeeping(deps);
setInterval(() => runHousekeeping(deps), 3600_000).unref();

app.listen(config.port, () => {
  const mode = (s: string | undefined) => s ?? "not configured";
  console.log(`\nInbox Voice running at ${config.publicUrl}${dev ? " (dev)" : ""}`);
  console.log(`  Gmail sign-in : ${googleAuth ? "Google OAuth configured" : "not configured"}${config.demoMode ? " · demo sign-in on" : ""}`);
  console.log(`  Summaries/AI  : ${mode(providers.ai?.mode)}${providers.ai?.mode === "live" ? ` (${config.anthropic?.model})` : ""}`);
  console.log(`  Voice         : ${mode(providers.voice?.mode)}${providers.voice?.mode === "live" ? ` (${config.elevenlabs?.modelId})` : ""}\n`);
});
