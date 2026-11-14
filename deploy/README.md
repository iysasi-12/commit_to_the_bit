# Deploying VocaMail to Vultr

Every push to `main` runs CI (typecheck, tests, build, Docker smoke test). When all of that passes, the **Deploy to Vultr** job:

1. Builds the Docker image and pushes it to `ghcr.io/<owner>/vocamail` (tagged with the commit SHA and `latest`).
2. Copies `docker-compose.yml`, `Caddyfile` and a generated `.env` to `/opt/vocamail` on the server over SSH.
3. Pulls the new image and restarts with `docker compose up -d`.
4. Checks that `https://<domain>/` responds.

Caddy gets the HTTPS certificate automatically. The SQLite database and cached audio live in the `vocamail-data` Docker volume, so they survive redeploys.

You can also run a deploy by hand: **Actions → CI → Run workflow** on `main`.

## Server prerequisites

- Ubuntu with Docker installed (`curl -fsSL https://get.docker.com | sh`).
- Firewall open on TCP 22, 80 and 443.
- The domain's DNS **A record** points at the server's IP.
- The deploy key's public half is in `~/.ssh/authorized_keys` for `VULTR_USER`.

## GitHub settings

Repo **Settings → Secrets and variables → Actions**.

**Secrets** (required):

| Name | Value |
|---|---|
| `VULTR_SSH_KEY` | Private deploy key (whole file, including the BEGIN/END lines) |
| `VULTR_HOST` | Server IPv4 address |
| `VULTR_USER` | SSH user, e.g. `root` |
| `SESSION_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Keep it stable: changing it signs everyone out and makes stored Google tokens unreadable. |

**Secrets** (optional; each missing one falls back to demo mode):

| Name | Enables |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Real Gmail sign-in. Add `https://<domain>/auth/google/callback` as a redirect URI in Google Cloud. |
| `ANTHROPIC_API_KEY` | AI summaries and sorting |
| `ELEVENLABS_API_KEY` | Real voices and voice cloning |

**Variables** (the Variables tab, not Secrets):

| Name | Value |
|---|---|
| `VOCAMAIL_DOMAIN` | Required. Domain only, e.g. `vocamail.example.com` (no `https://`) |
| `DEMO_MODE` | Optional. `true` (default) keeps the "Try the demo inbox" button; `false` hides it. |

## Useful commands on the server

```bash
cd /opt/vocamail
docker compose ps                 # what's running
docker compose logs -f app        # app logs
docker compose logs -f caddy      # HTTPS/certificate logs
docker compose restart app
```
