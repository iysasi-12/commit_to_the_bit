# Voice Inbox Assistant

Sign in with Google, click **Scan & Summarize Inbox**, and hear your newest emails one at a time: **Work / School** first, then **Personal**, then **Transactions**. Spam is silently skipped.

- **Summaries**: Gemini (`@google/genai`, `gemini-3.8-flash`, temperature 0.1) with the exact system prompt in `src/lib/system-prompt.ts`.
- **Voices**: ElevenLabs (`eleven_flash_v2_5`, `mp3_44100_128`).
- **App**: Next.js 16 (App Router, TypeScript, Tailwind) with Auth.js v5 for Google sign-in and `googleapis` for Gmail (read-only).

## How it works

1. **Scan** (`POST /api/emails`): reads the newest N inbox emails (default 10) and turns HTML into plain text with `html-to-text`. Gemini then summarizes each email separately, a few at a time.
   - Output of exactly `DISCARDED: SPAM` is dropped.
   - The category comes from the spoken lead-in ("Starting with Work and School.", "Next, Personal.", "Finally, Transactions.").
   - Emails are ordered Work/School → Personal → Transactions, and only the first email of each group keeps its lead-in.
   - **No ElevenLabs calls happen during the scan.**
2. **Player**: speaks one email at a time.
   - Audio is generated only for the email being played (`POST /api/tts`), and only after **Next Email →** or **Listen**.
   - Audio is cached in the browser by `${emailId}-${voiceId}`, so **Replay** never costs credits.
   - When an email finishes, the player waits; it never auto-advances.
   - **Skip** moves on without generating audio.
3. **Voice Box**:
   - **Preset & account voices** (`/api/voices`): **Test Voice** plays ElevenLabs' free preview clip when one exists.
   - **Voice Design** (`/api/voices/design`, `eleven_ttv_v3`): **Save & Use Voice** saves the preview you pick (`/api/voices/create`).
   - **Paste a voice ID**: saved in this browser.
   - **Instant Voice Clone** (`/api/voices/clone`): needs a paid ElevenLabs plan.
   - The chosen voice is remembered in `localStorage`.
4. **Security**:
   - Gemini and ElevenLabs keys are read only in server routes, never as `NEXT_PUBLIC_*`.
   - Google tokens live in the encrypted, HttpOnly Auth.js cookie and are refreshed automatically.
   - If Google refuses a refresh (access revoked, or the 7-day limit for apps in Testing mode), the page shows **"Session Expired — Sign Out & Reconnect Google"** instead of crashing.

## Extras

- **Category tabs**: after a scan, tabs for **All · Work · School · Personal · Transactions** let you play through just one group. Gemini's Work/School category is split into Work and School by simple clues: `.edu` senders, Canvas or Blackboard, professors, classes, assignments and exams count as School.
- **Butler mode**: a checkbox next to the scan button.
  - Summaries are delivered by an original, refined elderly British butler who addresses you as "sir". The exact system prompt is unchanged; the persona is added after it only when the box is ticked.
  - In the Voice Box under **Design a voice**, **🎩 Fill in the Butler voice** pre-fills a matching voice description. Generate previews, then **Save & Use Voice**.

## Chrome extension: use it on the Gmail page (your machine only)

The `chrome-extension/` folder adds a **🎧 AI Summary** button to Gmail. It opens the app in Chrome's side panel next to your email. The app itself must be running on http://localhost:3000.

1. Start the app with `npm.cmd run dev`, as below.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `voice-inbox-assistant\chrome-extension` folder.
4. Open http://localhost:3000 in a normal tab and **sign in with Google** once. Google won't show its sign-in page inside a side panel.
5. Open Gmail and click **🎧 AI Summary** (bottom right), or click the extension's toolbar icon. The side panel opens with your Voice Box, scan button, tabs and player.

If the panel says you're signed out, Chrome may be blocking third-party cookies. Go to **Settings → Privacy and security → Third-party cookies → Sites allowed to use third-party cookies** and add `localhost`, or simply use http://localhost:3000 in a tab.

## Run it locally

Requires Node.js 20.9+ (tested on Node 24).

```bash
cd voice-inbox-assistant
```

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in `.env.local` (see the next section), then:

```bash
npm run dev
```

Open http://localhost:3000. For a production build:

```bash
npm run build
```

```bash
npm start
```

The older Inbox Voice app in the parent folder also uses port 3000, so run only one at a time.

## `.env.local`

| Variable | Where it comes from |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client (below) |
| `NEXTAUTH_SECRET`, `AUTH_SECRET` | Any 32+ character random string; use the same value for both. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `NEXTAUTH_URL`, `AUTH_URL` | `http://localhost:3000` locally; `https://your-domain.com` on a server |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey (personal Google account; school accounts often block AI Studio) |
| `GEMINI_MODEL` | Optional, default `gemini-3.8-flash`. If it's overloaded, the app retries once with `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`). |
| `ELEVENLABS_API_KEY` | ElevenLabs → Developers → API Keys. Allow Text to Speech, Voices (write) and Voice Generation. |

## Google Cloud setup

### Testing on localhost (works today)

1. Go to https://console.cloud.google.com and create a project.
2. Go to **APIs & Services → Library → Gmail API → Enable**.
3. In **Google Auth Platform → Branding**, set the app name and support email.
4. In **Audience**, choose **External**. In **Test users**, click **Add users**, enter every Gmail that will sign in, and click **Save**.
5. In **Data Access**, click **Add or remove scopes** and add `openid`, `email`, `profile` and `https://www.googleapis.com/auth/gmail.readonly`.
6. In **Clients → Create client**, choose **Web application** and add the redirect URI `http://localhost:3000/api/auth/callback/google`.
7. Copy the client ID and secret into `.env.local`.

While in Testing mode:
- Only listed test users can sign in.
- Google shows an "unverified app" screen. Click **Continue**.
- Sign-ins expire after 7 days, and the app then shows the reconnect banner.

### Opening it to any Google user (production)

1. On **Branding**, add your home page, privacy policy and terms URLs, plus your authorized domain.
2. In **Audience**, click **Publish app**.
3. `gmail.readonly` is a restricted scope, so Google requires restricted-scope verification **and** an annual third-party security assessment before anyone outside your test users can sign in. Submit these in **Verification Center**. Allow several weeks.

## Deploying to a Vultr VPS with your own domain

1. Create an Ubuntu VPS and point your domain's DNS **A record** at its IP.
2. Install Node.js 20+ and clone the repo. Then:
   ```bash
   cd voice-inbox-assistant && npm ci && npm run build
   ```
3. Create `.env.local` on the server with `NEXTAUTH_URL=https://your-domain.com` and `AUTH_URL=https://your-domain.com`, plus the same keys.
4. Run the app on port 3000 with a process manager:
   ```bash
   npx pm2 start "npm start" --name voice-inbox
   ```
   Then run `npx pm2 save` so it restarts on reboot.
5. Put HTTPS in front of it:
   - **Caddy (simplest)**: in `/etc/caddy/Caddyfile`, add the block below. Caddy gets the HTTPS certificate automatically.
     ```
     your-domain.com {
         reverse_proxy localhost:3000
     }
     ```
   - **Nginx**: use `proxy_pass http://localhost:3000;` with these headers, plus a certificate from `certbot --nginx`:
     ```
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     ```
6. In Google Cloud **Clients**, add `https://your-domain.com/api/auth/callback/google` as a redirect URI. Then add the domain under **Branding → Authorized domains**.
7. Auth.js is configured with `trustHost: true`, so callbacks and secure cookies work behind the proxy with no code changes.

## What's verified

- `npm run build` passes (TypeScript and production build).
- The spam, ordering and lead-in logic was checked locally.
- The Gemini key, ElevenLabs key and Google OAuth client were each confirmed working earlier, against the same accounts.
- **Not yet tested end to end in this app**: signing in with Gmail and scanning a real inbox, Voice Design, and cloning. You're running those tests yourself to save credits.
