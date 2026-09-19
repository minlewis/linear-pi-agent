# Linear Kimi Agent

Connect [Kimi Code](https://moonshotai.github.io/kimi-code/) to Linear. This service receives Linear Agent Session events, runs the `kimi` CLI against your chosen repository, and posts progress and results back to Linear.

The agent service is intended to live in its own repository, separate from the application repository it operates on. Configure the target application repository with `KIMI_WORKDIR`.

## Easy install with a coding agent

If you want the easiest setup path, copy the contents of [`INSTALL.md`](./INSTALL.md) into your coding agent and ask it to follow the instructions. It will do the local setup steps it can do automatically and prompt you only for Linear setup, secrets, browser actions, or infrastructure details it cannot complete itself.

## How it works

```text
Linear Agent Session
  -> webhook to this service
  -> kimi CLI subprocess (kimi -p ... --output-format stream-json)
  -> target repository at KIMI_WORKDIR
  -> progress/results back to Linear
```

The service:

- exposes OAuth install and webhook endpoints for Linear
- stores Linear OAuth tokens locally
- spawns a `kimi` process per run and streams its `stream-json` (NDJSON) output into Linear progress activities
- persists a Linear `agentSession.id` → Kimi `session_id` mapping, so follow-up prompts resume the same Kimi session (even across service restarts)
- queues follow-ups that arrive while a run is active
- handles stop/cancel requests by killing the `kimi` process
- redacts obvious secret-looking values from progress updates
- deduplicates repeated progress updates and sends a configurable heartbeat during quiet long-running sessions

## Linear setup

Create a Linear OAuth application from:

```text
Linear Settings -> API -> New OAuth app
```

Use Linear's docs for the full details of OAuth apps, webhooks, and Agent Sessions:

- OAuth: https://linear.app/developers/oauth-2-0-authentication
- Webhooks: https://linear.app/developers/webhooks
- Agent best practices: https://linear.app/developers/agent-best-practices

At a high level, configure the app with these service URLs:

| Linear setting | Value |
| --- | --- |
| OAuth callback URL | `https://your-domain.example/linear/oauth/callback` |
| Webhook URL | `https://your-domain.example/linear/webhook` |

Required OAuth scopes:

```text
read, write, app:assignable, app:mentionable
```

Enable Agent Session events for the webhook.

After the service is running, install the app by visiting:

```text
https://your-domain.example/linear/install?install_secret=YOUR_INSTALL_SECRET
```

This redirects through Linear OAuth and stores the app token locally. `INSTALL_SECRET` protects the install endpoint so random visitors cannot start an install flow against your service.

## Requirements

- Node.js and npm
- the `kimi` CLI installed for the service user and authenticated (`kimi login`)
- a public HTTPS URL that Linear can reach
- a reverse proxy or tunnel forwarding public traffic to this service
- a target repository for Kimi Code to operate on

By default the service listens on `127.0.0.1:8787`. Expose these routes publicly:

- `/linear/install`
- `/linear/oauth/callback`
- `/linear/webhook`
- `/healthz` optional, for health checks

## Recommended hosting

Run this somewhere that can stay online, receive HTTPS webhooks from Linear, and access the repository you want Kimi Code to work on: a small VPS or any host with a public HTTPS endpoint.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
INSTALL_SECRET=
LINEAR_REDIRECT_URI=https://your-domain.example/linear/oauth/callback
BASE_URL=https://your-domain.example

KIMI_WORKDIR=/path/to/your/app
KIMI_COMMAND=kimi
# KIMI_MODEL=
KIMI_SESSION_STORE_PATH=./data/kimi-sessions.json
KIMI_PROGRESS_DEBOUNCE_MS=3000
KIMI_PROGRESS_HEARTBEAT_MS=300000
KIMI_PROGRESS_LONG_TOOL_MS=30000
KIMI_TIMEOUT_MS=1800000

HOST=127.0.0.1
PORT=8787
TOKEN_STORE_PATH=./data/linear-tokens.json
STATE_STORE_PATH=./data/oauth-states.json
```

Important values:

- `BASE_URL` — public URL for this service, without a trailing slash
- `LINEAR_REDIRECT_URI` — must exactly match the OAuth callback URL configured in Linear
- `LINEAR_WEBHOOK_SECRET` — Linear webhook signing secret
- `INSTALL_SECRET` — random secret for `/linear/install`; use at least 16 characters
- `KIMI_WORKDIR` — the repository Kimi Code should work in
- `KIMI_COMMAND` — Kimi CLI executable; defaults to `kimi`
- `KIMI_MODEL` — optional model alias passed as `kimi -m`
- `KIMI_SESSION_STORE_PATH` — persisted Linear → Kimi session mapping
- `KIMI_PROGRESS_DEBOUNCE_MS` — minimum delay between Linear progress activities
- `KIMI_PROGRESS_HEARTBEAT_MS` — quiet interval before posting a "still working" progress heartbeat
- `KIMI_PROGRESS_LONG_TOOL_MS` — minimum successful tool duration before posting completion progress; `0` disables completion updates
- `KIMI_TIMEOUT_MS` — maximum run duration before the `kimi` process is killed
- `TOKEN_STORE_PATH` / `STATE_STORE_PATH` — persisted Linear OAuth state

Use absolute paths for token, state, and session storage in production.

## Build and check

```bash
npm install
npm run typecheck
npm run build
```

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

Smoke tests require configured secrets and/or a running service:

```bash
npm run smoke:webhook
npm run smoke:linear
```

If a reverse proxy listens on another port, point the webhook smoke test at it:

```bash
WEBHOOK_SMOKE_URL=http://127.0.0.1:3000/linear/webhook npm run smoke:webhook
```

## Deploy with systemd

Install/reload the user service:

```bash
npm install
npm run typecheck
npm run build
install -Dm644 systemd/linear-kimi-agent.service.template \
  ~/.config/systemd/user/linear-kimi-agent.service
systemctl --user daemon-reload
systemctl --user restart linear-kimi-agent
systemctl --user status linear-kimi-agent
```

Watch logs:

```bash
journalctl --user -u linear-kimi-agent -f
```

Enable startup after host reboot:

```bash
systemctl --user enable linear-kimi-agent
loginctl enable-linger "$USER"
```

The systemd unit assumes the `kimi` CLI is on `PATH` for the service user and authenticated via `kimi login`. Kimi sessions are stored in the service user's home directory.

## Repository layout

- `src/` — TypeScript service source
- `systemd/linear-kimi-agent.service.template` — user systemd unit template
- `.env.example` — configuration template
- `data/` — local OAuth and kimi session state, ignored by git
- `dist/` — compiled output, ignored by git

Ignored locally: `.env`, `data/*.json`, `dist/`, `node_modules/`, and logs.

## Security notes

This service gives Linear a path to run Kimi Code in `KIMI_WORKDIR`. Judge for yourself whether that is appropriate for your repository, workspace, users, and hosting environment.

Important considerations:

- Keep `INSTALL_SECRET` set. Without it, anyone who knows your service URL can visit `/linear/install` and start an OAuth install flow.
- The webhook endpoint verifies Linear's signature with `LINEAR_WEBHOOK_SECRET`; knowing the public URL alone should not be enough to fake Linear webhooks.
- Anyone who can use this Linear agent can ask Kimi Code to act in `KIMI_WORKDIR`. Treat Linear agent access like write access to that repository.
- Run the service as a low-privilege user and avoid keeping unrelated secrets in the target repository.
- Output redaction is best-effort. The service redacts obvious token-looking strings, but you should still avoid exposing secrets to the agent workspace.
- Add rate limiting at your reverse proxy or hosting layer if the service is public, especially for `/linear/install` and `/linear/webhook`.

Public endpoint expectations:

| Endpoint | Protection | Notes |
| --- | --- | --- |
| `/healthz` | none | Safe to expose for uptime checks. |
| `/linear/install` | `INSTALL_SECRET` | Use only during install; rate-limit this route. |
| `/linear/oauth/callback` | OAuth `state` | Must stay public for Linear OAuth callback. |
| `/linear/webhook` | Linear HMAC signature + timestamp | Must stay public for Linear; rate-limit invalid/noisy traffic at the proxy. |

## Operational notes

Active run and queue state is currently in memory. A Node/systemd restart can lose an active run or queued follow-up prompt, although OAuth tokens and the Linear → Kimi session mapping are persisted on disk.

## Roadmap

- Multi-workspace support. The current implementation targets one Linear workspace/install.
- Better Linear app/install management for multiple installations.
- Mid-run follow-up injection once the kimi CLI supports it (today follow-ups queue until the active run finishes).
- Investigate support for installed slash commands or command-like actions that can be executed from Linear.
- Optional ACP (`kimi acp`) transport instead of subprocess-per-run.
