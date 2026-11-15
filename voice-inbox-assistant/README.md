# Voice Inbox Assistant

Sign in with Google, click **Scan & Summarize Inbox**, and hear your newest emails summarized in the voice you pick: **Work**, then **School**, then **Personal**, then **Transactions**. Spam is silently skipped, and sensitive emails are never opened.

- **Summaries**: Gemini (`@google/genai`, `gemini-3.8-flash`, temperature 0.1) with the exact system prompt in `src/lib/system-prompt.ts`.
- **Voices**: ElevenLabs (`eleven_v4` by default, `mp3_44100_128`). Presets, designed character voices, and your own cloned voice.
- **App**: Next.js 16 (App Router, TypeScript, Tailwind) with Auth.js v5 for Google sign-in and `googleapis` for Gmail (read-only).

## How it works

1. **Scan** (`POST /api/emails`): reads the newest N inbox emails (default 10).
   - Sensitive emails (banking, medical, government, security codes) are recognized from the sender and subject only. Their text is never downloaded, summarized or spoken; the app just says how many it skipped.
   - Gemini summarizes each remaining email separately, a few at a time. Output of exactly `DISCARDED: SPAM` is dropped.
   - The category comes from Gemini's lead-in ("Starting with Work and School.", …). The app then **removes Gemini's lead-ins** (persona variants too, like "Finally, Transactions, sir.") and orders emails Work → School → Personal → Transactions.
   - **No ElevenLabs calls happen during the scan.**
2. **Spoken order** (`composeSpoken` in `src/lib/triage.ts`), rebuilt for exactly the tab being played:
   - **All tab**: "Starting with Work, three emails. First, … Second, … Finally, …", "Next, School, two emails. First, … Finally, …", and "Lastly, Transactions, …". The sensitive-email note comes last.
   - **One tab**: "You have three transaction emails. First, … Finally, …".
   - A section with a single email gets no First/Finally.
3. **Player**: audio is made only for the email being played (`POST /api/tts`). It's cached in the browser per email, voice and exact text, so **Replay** never costs credits. **Read all at once** (default on) plays the emails back to back; turn it off to stop after each one.
4. **Voice Box**: presets, **Design a voice** (`eleven_ttv_v3`), **Clone a voice** (record or upload), or paste a voice ID. Long voice names wrap instead of being cut off. The name shown always matches the voice that speaks: a voice renamed or deleted in ElevenLabs is picked up on the next load.
5. **Character voices**: choosing **The Butler** or **The Angry Coach** also changes how the summaries are written (persona added after the exact system prompt).

## Many users, one ElevenLabs account

Everyone signs in with their own Google account, so each person only ever reads their own Gmail. Voices are kept apart like this (`src/lib/voice-access.ts`):

| Voice | Who sees and uses it | Who can remove it |
|---|---|---|
| ElevenLabs presets | everyone | nobody |
| A voice you design or clone in the app | only you | only you |
| Shared character voices (The Butler, The Angry Coach, …) | everyone | admins |
| Clones made before owner tags existed (e.g. `jv10`) | admins | admins |

- Each new voice gets a private owner tag (an HMAC of your email, never the email itself) at the end of its ElevenLabs description. The tag never reaches the browser.
- `/api/tts` refuses another person's voice before calling ElevenLabs.
- Each non-admin may keep `VOICES_PER_USER` voices (default 3), because voice slots are shared.
- Admins are listed in `ADMIN_EMAILS`.

## Tests

```bash
npm.cmd test
```

Runs the spoken-order and voice-ownership unit tests (no network, no keys). Set `PRINT=1` to print exactly what is spoken for All and each tab.

## Chrome extension (Gmail button)

The `chrome-extension/` folder adds a **🎧 AI Summary** button to Gmail that opens the app in Chrome's side panel.

1. Start the app (`npm.cmd run dev`), or use the hosted site once it's live.
2. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `voice-inbox-assistant\chrome-extension`. After an update, click the reload icon on the extension.
3. Open the app in a normal tab and **sign in with Google** once (Google won't show sign-in inside a side panel).
4. In Gmail, click **🎧 AI Summary** and pick Short, Medium or Long.

**Which server?** Right-click the extension icon → **Options**: *This computer* (http://localhost:3000, the default) or *vocamain.biz*.

If the panel says you're signed out, Chrome may be blocking third-party cookies: allow them for the app's site, or use the app in a normal tab.

## Run it locally

Requires Node.js 20.9+ (tested on Node 24). On Windows PowerShell, use `npm.cmd` instead of `npm`.

```bash
npm.cmd install
```

```bash
copy .env.example .env.local
```

Fill in `.env.local` (below), then:

```bash
npm.cmd run dev
```

Open http://localhost:3000. The older Inbox Voice app in the parent folder also uses port 3000, so run only one at a time.

## `.env.local`

| Variable | Where it comes from |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client (below) |
| `NEXTAUTH_SECRET`, `AUTH_SECRET` | Any 32+ character random string, the same for both. Changing it signs everyone out and changes voice owner tags. |
| `NEXTAUTH_URL`, `AUTH_URL` | `http://localhost:3000` locally; `https://vocamain.biz` on the server |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | Optional. Defaults `gemini-3.8-flash`, then `gemini-3.5-flash-lite` if the first is busy. |
| `ELEVENLABS_API_KEY` | ElevenLabs → Developers → API Keys. Allow Text to Speech, Voices (write) and Voice Generation. |
| `ELEVENLABS_MODEL` | Optional, default `eleven_v4`. `eleven_flash_v2_5` is faster and cheaper but flatter. |
| `ADMIN_EMAILS` | Comma-separated Google emails that can manage shared and older voices. |
| `VOICES_PER_USER` | Optional, default 3. |
| `CONTACT_EMAIL` | Shown on `/privacy`. Set it before `npm run build`, because the page is built once. |

## Google Cloud: letting people sign in

### Testing mode (now)

- Only the test users listed under **Google Auth Platform → Audience** can sign in (up to 100). Add each person's Gmail there.
- Google shows an "unverified app" screen; click **Continue**.
- Sign-ins expire after 7 days, and the app then shows the reconnect banner.
- Redirect URIs (**Clients**): `http://localhost:3000/api/auth/callback/google`, and for the server `https://vocamain.biz/api/auth/callback/google`.

### Any Google user (production)

`gmail.readonly` is a **restricted** scope. Before people outside your test list can sign in, Google requires:

1. A verified domain (`vocamain.biz` in Search Console) listed under **Branding → Authorized domains**, with the home page `https://vocamain.biz` and privacy policy `https://vocamain.biz/privacy`.
2. **Publish app** under **Audience**, then submit **restricted-scope verification** in **Verification Center** (scope justification and a demo video of the sign-in and scan).
3. A yearly third-party **security assessment** (CASA). Plan for several weeks.
4. Gemini on a **paid** API tier (billing enabled on the key's project). On the free tier Google may use prompts to improve its products, which doesn't fit Gmail's Limited Use rules or the privacy policy.

## Deploying to Vultr (vocamain.biz)

1. Create an Ubuntu 24.04 Vultr server. At your domain registrar, add **A records** for `vocamain.biz` and `www.vocamain.biz` pointing at its IP.
2. Make a production env file (a copy of `.env.local` with `AUTH_URL` and `NEXTAUTH_URL` set to `https://vocamain.biz`) and copy it to the server. It never goes in Git:
   ```bash
   scp .env.production root@SERVER_IP:/etc/voice-inbox.env
   ```
3. Copy and run the setup script. It installs Node 24 and Caddy (automatic HTTPS), clones `main`, runs the tests, builds, and starts a systemd service on 127.0.0.1:3000. The first run prints a deploy key to add on GitHub (repo → Settings → Deploy keys, read-only), because the repo is private. Run it again after adding the key.
   ```bash
   scp deploy/setup-vultr.sh root@SERVER_IP:/root/
   ```
   ```bash
   ssh root@SERVER_IP "bash /root/setup-vultr.sh"
   ```
4. Add `https://vocamain.biz/api/auth/callback/google` as a redirect URI in Google Cloud **Clients**.
5. **Check the server runs the tested commit:** these two must match.
   ```bash
   curl -s https://vocamain.biz/api/health
   ```
   ```bash
   git rev-parse HEAD
   ```
6. To update later, push to `main` and run step 3's `ssh` command again.
