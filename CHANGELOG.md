# Changelog

## Unreleased

Changes since `v0.1.0`.

### Changed

- Replaced the pi coding agent with the Kimi Code CLI: the service now spawns `kimi -p <prompt> --output-format stream-json` per run and maps its NDJSON output to Linear progress activities. The `@earendil-works/pi-coding-agent` dependency and the `PI_*` configuration are removed; use `KIMI_*` (`KIMI_WORKDIR`, `KIMI_COMMAND`, `KIMI_MODEL`, `KIMI_SESSION_STORE_PATH`, `KIMI_TIMEOUT_MS`, `KIMI_PROGRESS_*`).
- Follow-up prompts now resume the stored Kimi session via `kimi -S <session_id>`; the Linear `agentSession.id` → Kimi `session_id` mapping is persisted on disk and survives restarts. Follow-ups during an active run are queued (no mid-run injection).
- Stop/cancel requests kill the `kimi` subprocess (SIGTERM, then SIGKILL after a grace period). Long runs are killed after `KIMI_TIMEOUT_MS`.
- Package, service, and systemd unit renamed to `linear-kimi-agent`.

### Added

- File-backed Kimi session store (`KIMI_SESSION_STORE_PATH`) with atomic writes and corrupt-file recovery.
- `kimi-runner` with injectable spawn/session-store dependencies, plus unit tests and fake-kimi end-to-end tests covering created→response, follow-up resume, fresh-start fallback, and stop→kill.

### Removed

- Pi SDK session runner (`src/pi-runner.ts`), `PI_*` configuration, and the `@earendil-works/pi-coding-agent` dependency.
- Mid-run follow-up injection; follow-ups now always queue behind the active run.

### Historical: v0.1.0 changes

Changes shipped in `v0.1.0` (as Linear Pi Agent):

- Linear progress updates for Pi SDK session events, including session start, thinking, tool execution, context compaction, retries, and tool errors.
- A start activity when the service receives a Linear agent session and begins work.
- `POSSIBLE_IMPROVEMENTS.md` with prioritized follow-up ideas for progress reporting and operational polish.
- Recommended hosting guidance and a short roadmap in the README.
- Configurable Pi progress heartbeats through `PI_PROGRESS_HEARTBEAT_MS`.
- Unit tests for progress deduplication, event mapping, sanitization, and heartbeat behavior.
- Config tests for Pi theme defaults, custom theme names, and safe public runtime config.
- Report completion progress for successful long-running tools using toolCallId-based tracking.
- Initialize the Pi SDK theme for non-interactive runs so installed extensions with background widgets do not crash the service.
- Improve tool argument summaries by recognizing `cmd` as well as `command`.
- Upgrade `@earendil-works/pi-coding-agent` to `^0.80.3` and add `undici`.
- Upgrade dependency ranges for `express` to `^4.22.2` and `tsx` to `^4.23.0`.
- Deduplicate pending and already-sent Linear progress updates, stop generic `turn_start` progress spam, sanitize tool progress, and flush pending progress before Pi error or timeout results.
- Centralize Pi theme configuration through validated `PI_THEME`.
- Improve Linear tool progress summaries with tool-aware, redacted, truncation-safe formatting.
- Add optional `INSTALL_SECRET` protection for `/linear/install`, accepted through `?install_secret=` or a Bearer token.
- Document public endpoint protections, Linear webhook signature expectations, and deployment security considerations.
- Update transitive dependencies to clear the `qs`/`express` and `esbuild` npm audit findings.

## 0.1.0 - 2026-05-12

Initial public release of Linear Pi Agent.

### Added

- Linear OAuth install flow, webhook endpoint, and agent session handling.
- Pi SDK session execution against a configured repository.
- Local persistence for Linear tokens, OAuth state, and Pi session data.
- Follow-up prompt handling for existing Linear agent sessions.
- Setup, deployment, and systemd documentation.
