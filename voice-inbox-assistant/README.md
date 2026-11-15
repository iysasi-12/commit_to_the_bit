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

Runs the spoken-order, voice-ownership and Gemini-quota unit tests (no network, no keys). Set `PRINT=1` to print exactly what is spoken for All and each tab.

Against a running site (no Gemini or ElevenLabs credits used):

```bash
npm.cmd run check:live -- https://vocamail.biz 3
```

```bash
npm.cmd run check:ui -- https://vocamail.biz
```

- `check:live` runs 18 checks per round: HTTPS and `www` redirects, health and commit, pages, sign-in callback, signed-out refusals, and signed-in voice privacy using fake test users. Use `http://localhost:3000` for your computer.
- `check:ui` opens the app in headless Chrome at 13 phone, tablet and desktop sizes (portrait and landscape) with fake inbox data, and fails on sideways scrolling, cut-off text or voice names, or small tap targets. Screenshots go to your temp folder.
- Both sign in as fake test users with the site's `AUTH_SECRET`: from `.env.local` for localhost, or from `.env.live` (git-ignored) for the live site.

## Chrome extension (Gmail button)

The `chrome-extension/` folder adds a **🎧 AI Summary** button to Gmail that opens the app in Chrome's side panel.

1. Start the app (`npm.cmd run dev`), or use the hosted site once it's live.
2. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `voice-inbox-assistant\chrome-extension`. After an update, click the reload icon on the extension.
3. Open the app in a normal tab and **sign in with Google** once (Google won't show sign-in inside a side panel).
4. In Gmail, click **🎧 AI Summary** and pick Short, Medium or Long.

**Which server?** Right-click the extension icon → **Options**:
- *Automatic* (default): vocamail.biz, or this computer (http://localhost:3000) if vocamail.biz doesn't answer within 4 seconds.
- *vocamail.biz only*.
- *This computer only*.

Both addresses are at the top of `chrome-extension/panel.js`.

If the panel says you're signed out, Chrome may be blocking third-party cookies: allow them for the app's site, or use the app in a normal tab.

## Presentation backup: run it on this computer

If vocamail.biz isn't up, the same app runs on your laptop:

1. Start it. For a quicker, steadier app, build it first (`npm.cmd run build`) and then run `npm.cmd start`; you can ignore its "standalone" warning. Or simply:
   ```bash
   npm.cmd run dev
   ```
2. Open http://localhost:3000 in a normal Chrome tab and sign in with Google. The presenter's Gmail must be a **test user** in Google Cloud (Audience → Test users).
3. The extension's *Automatic* mode switches to this computer by itself. No code changes are needed.
4. Check it before you present:
   ```bash
   npm.cmd run check:live -- http://localhost:3000 3
   ```

`.env.local` keeps the live-site addresses as commented lines under the active localhost ones. Leave them commented on your computer.

**Gemini's free tier allows only about 20 requests a day on the main model**, and every email uses one, so two 10-email scans use it up. When that happens the app switches to `GEMINI_FALLBACK_MODEL` on its own, and the summaries are just as usable. For a presentation, turn on billing for the Gemini key's Google Cloud project (each email costs a fraction of a cent), or scan 5 emails at a time.

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
| `NEXTAUTH_URL`, `AUTH_URL` | `http://localhost:3000` locally; `https://vocamail.biz` on the server |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | Optional. Defaults `gemini-3.8-flash`, then `gemini-3.5-flash-lite` if the first is busy. |
| `ELEVENLABS_API_KEY` | ElevenLabs → Developers → API Keys. Allow Text to Speech, Voices (write) and Voice Generation. |
| `ELEVENLABS_MODEL` | Optional, default `eleven_v4`. `eleven_flash_v2_5` is faster and cheaper but flatter. |
| `ADMIN_EMAILS` | Comma-separated Google emails that can manage shared and older voices. |
| `VOICES_PER_USER` | Optional, default 3. |
| `VOICE_OWNER_SECRET` | Random string behind the private voice owner tags. Must match the server's, or voices made here won't show up for their owner on the live site. |
| `CONTACT_EMAIL` | Shown on `/privacy` as the contact for questions and deletion requests. |
| `GEMINI_PAID_TIER` | `false` (free tier, the default): the privacy page says Google may use content sent to Gemini to improve its products. Set `true` only after enabling billing. |

## Google Cloud: letting people sign in

### Testing mode (now)

- Only the test users listed under **Google Auth Platform → Audience** can sign in (up to 100). Add each person's Gmail there.
- Google shows an "unverified app" screen; click **Continue**.
- Sign-ins expire after 7 days, and the app then shows the reconnect banner.
- Redirect URIs (**Clients**): `http://localhost:3000/api/auth/callback/google`, and for the server `https://vocamail.biz/api/auth/callback/google`.

### Any Google user (production)

`gmail.readonly` is a **restricted** scope. Before people outside your test list can sign in, Google requires:

1. A verified domain (`vocamail.biz` in Search Console) listed under **Branding → Authorized domains**, with the home page `https://vocamail.biz` and privacy policy `https://vocamail.biz/privacy`.
2. **Publish app** under **Audience**, then submit **restricted-scope verification** in **Verification Center** (scope justification and a demo video of the sign-in and scan).
3. A yearly third-party **security assessment** (CASA). Plan for several weeks.
4. Gemini on a **paid** API tier (billing enabled on the key's project). On the free tier Google may use prompts to improve its products, which doesn't fit Gmail's Limited Use rules or the privacy policy.

## Deploying to Vultr (vocamail.biz)

Deploys are automatic: every push to `main` runs the repo's CI (`.github/workflows/ci.yml`). When this app's lint, unit tests, build and Docker smoke test pass, the **Deploy Voice Inbox Assistant to Vultr** job:

1. Builds the Docker image (`Dockerfile`, Next.js standalone) and pushes it to `ghcr.io/<owner>/voice-inbox-assistant`, tagged with the commit.
2. Copies `deploy/docker-compose.yml`, `deploy/Caddyfile` and a generated `.env` to `/opt/voice-inbox` on the server over SSH. If the older VocaMail stack is running in `/opt/vocamail`, it is stopped first, because only one Caddy can own ports 80 and 443.
3. Starts the app with Caddy in front (automatic HTTPS for the domain and `www`).
4. **Fails unless `https://<domain>/api/health` reports the exact commit that was tested**, so a green deploy means the live site runs the tested version.

You can also deploy by hand: **Actions → CI → Run workflow** on `main`.

### One-time setup

1. **Server**: Ubuntu on Vultr with Docker (`curl -fsSL https://get.docker.com | sh`), firewall open on TCP 22, 80 and 443, and the deploy key's public half in `~/.ssh/authorized_keys` of `VULTR_USER`.
2. **DNS**: at the registrar for `vocamail.biz`, add **A records** for `vocamail.biz` and `www.vocamail.biz` pointing at the server's IP.
3. **Google Cloud → Clients**: add the redirect URI `https://vocamail.biz/api/auth/callback/google`.
4. **GitHub → repo Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `VULTR_HOST`, `VULTR_USER`, `VULTR_SSH_KEY` | Server IP, SSH user (e.g. `root`), and the private deploy key (whole file) |
| `AUTH_SECRET` | A new 32+ character random string for the live site (not the one on your computer) |
| `VOICE_OWNER_SECRET` | The **same** value as `VOICE_OWNER_SECRET` in your `.env.local`, so people keep their voices |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY` | Same as in `.env.local` |

| Variable (Variables tab) | Value |
|---|---|
| `APP_DOMAIN` | Optional, default `vocamail.biz` |
| `ADMIN_EMAILS` | Your Google email(s), comma-separated |
| `CONTACT_EMAIL` | Contact shown on `/privacy` |
| `VOICES_PER_USER`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`, `ELEVENLABS_MODEL` | Optional overrides |
| `GEMINI_PAID_TIER` | Leave unset while on the free tier. Set to `true` only after billing is on; it updates the privacy page. |

Generate a random secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Checking and managing the server

```bash
curl -s https://vocamail.biz/api/health
```

The `commit` it reports should equal the commit shown for the latest green CI run. On the server:

```bash
cd /opt/voice-inbox && docker compose ps && docker compose logs --tail=50 app
```
