# Spec: Replace pi with Kimi Code as the Linear agent runner

Status: approved direction (2026-09-19), pending implementation
Tracking issues: GitHub Issues on `minlewis/linear-pi-agent` (each references this file)

## Goal

Turn this service from "Linear Agent Session → pi coding agent" into
"Linear Agent Session → Kimi Code CLI". When a Linear user mentions or delegates
an issue to the agent, the service runs `kimi` against the configured target
repository and reports progress and results back to Linear as agent activities.

## What we are doing (in scope)

1. Replace the pi SDK execution layer with a Kimi Code CLI subprocess runner.
2. Stream Kimi Code's `stream-json` (NDJSON) output into Linear progress
   activities, reusing the existing debounce/heartbeat/redaction/dedupe
   machinery in `src/progress.ts`.
3. Persist the Linear `agentSession.id` → Kimi `session_id` mapping on disk so
   follow-up prompts resume the same Kimi session even across service restarts.
4. Support Linear follow-ups (`action: "prompted"`) by resuming the stored Kimi
   session; queue follow-ups that arrive while a run is active.
5. Support Linear stop requests by killing the running Kimi subprocess.
6. Rename all configuration from `PI_*` to `KIMI_*` and drop the
   `@earendil-works/pi-coding-agent` dependency.
7. Update docs: `README.md`, `INSTALL.md`, `.env.example`,
   `systemd/` unit template, `CHANGELOG.md`, smoke scripts.

## What we are NOT doing (scope boundary)

- No pi compatibility mode and no dual-runner switch. The pi code path and the
  pi dependency are removed entirely.
- No mid-run follow-up injection. Kimi runs as a subprocess and cannot accept
  input mid-run; follow-ups during an active run are queued and started after
  the current run finishes (existing `pendingPayload` behavior).
- No ACP (`kimi acp`) server integration. Noted as a possible future
  alternative to subprocess-per-run; out of scope.
- No changes to OAuth install flow, webhook signature verification, or token
  storage (`src/oauth.ts`, `src/signature.ts`, `src/storage.ts`,
  `src/linear.ts` stay as-is except for user-facing strings).
- No multi-workspace support, no slash-command handling (unchanged from the
  existing roadmap).
- No git remote/repository renames on GitHub; that is the user's decision.

## Inputs and outputs

### Inputs

- **Linear AgentSessionEvent webhooks** at `POST /linear/webhook` (unchanged
  contract): `action: "created"` starts a run, `action: "prompted"` is a
  follow-up, stop/cancel actions or a `stop`/`cancel` body abort the run.
- **Environment configuration** (see Pinned interfaces below).
- **A working `kimi` CLI** on the host, already authenticated (`kimi login`),
  runnable by the service user.

### Outputs

- **Linear agent activities** on the agent session (unchanged API usage):
  - `thought` activities for start acknowledgement, tool progress, heartbeats,
    and queued-follow-up notices;
  - a final `response` activity with the run summary on success;
  - an `error` activity on failure, timeout, or stop.
- **On-disk state**: `KIMI_SESSION_STORE_PATH` JSON mapping Linear agent
  session IDs to Kimi session IDs.
- **Side effects in `KIMI_WORKDIR`**: whatever code changes Kimi Code makes.

## Verified facts about the Kimi CLI (probed 2026-09-19, kimi v2.0.1)

These were confirmed by running the real CLI:

- `kimi -p "<prompt>" --output-format stream-json` runs non-interactively and
  auto-approves tool calls (verified: it wrote a file without prompting).
- `-p` cannot be combined with `--auto` or `--yolo` (both rejected as argument
  errors); `-p` alone is the headless mode.
- `stream-json` stdout is newline-delimited JSON. Observed event shapes:
  - `{"role":"meta","type":"system.version","version":"2.0.1"}`
  - `{"role":"assistant","content":"..."}` — assistant text (intermediate and final)
  - `{"role":"assistant","tool_calls":[{"type":"function","id":"tool_...","function":{"name":"Write","arguments":"<json string>"}}]}`
  - `{"role":"tool","tool_call_id":"tool_...","content":"..."}` — tool result
  - `{"role":"meta","type":"session.resume_hint","session_id":"session_...","command":"kimi -r session_..."}` — emitted at end
- `kimi -S <session_id> -p "<follow-up>" --output-format stream-json` resumes
  the session with full context (verified: recalled content from the previous
  run).

## Pinned interfaces

### Environment configuration (`src/config.ts`)

New schema (old `PI_*` keys are removed, no aliases):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `KIMI_WORKDIR` | yes | — | Target repository Kimi Code works in |
| `KIMI_COMMAND` | no | `kimi` | Kimi CLI executable (tests override this) |
| `KIMI_MODEL` | no | unset | Model alias passed as `-m` when set |
| `KIMI_SESSION_STORE_PATH` | no | `./data/kimi-sessions.json` | agentSession.id → Kimi session map |
| `KIMI_TIMEOUT_MS` | no | `1800000` | Max run duration before kill |
| `KIMI_PROGRESS_DEBOUNCE_MS` | no | `3000` | Min delay between progress activities |
| `KIMI_PROGRESS_HEARTBEAT_MS` | no | `300000` | Quiet interval before "still working" |
| `KIMI_PROGRESS_LONG_TOOL_MS` | no | `30000` | Min tool duration for completion notice; `0` disables |

Removed: `PI_WORKDIR`, `PI_COMMAND`, `PI_MODE`, `PI_RUNNER`, `PI_THEME`,
`PI_SESSION_DIR`, `PI_PROGRESS_DEBOUNCE_MS`, `PI_PROGRESS_HEARTBEAT_MS`,
`PI_PROGRESS_LONG_TOOL_MS`, `PI_TIMEOUT_MS`.

Unchanged: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`,
`LINEAR_WEBHOOK_SECRET`, `INSTALL_SECRET`, `LINEAR_REDIRECT_URI`, `BASE_URL`,
`HOST`, `PORT`, `TOKEN_STORE_PATH`, `STATE_STORE_PATH`.

### `src/kimi-runner.ts` (replaces `src/pi-runner.ts`)

```ts
export const MAX_LINEAR_BODY_CHARS = 8_000;

export type KimiRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;           // captured for failure summaries
  outputText: string;       // final assistant text
  summary: string;          // redacted, truncated, Linear-ready
  elapsedMs: number;
  kimiSessionId?: string;   // captured from session.resume_hint
};

export function buildKimiPrompt(payload: AgentSessionWebhook): string;
export function buildKimiFollowUpPrompt(payload: AgentSessionWebhook): string;
export function summarizeKimiResult(result: KimiRunResult): string;
export async function runKimi(payload: AgentSessionWebhook, deps?: KimiRunnerDeps): Promise<KimiRunResult>;
export async function abortKimiSession(agentSessionId: string): Promise<boolean>;
```

`KimiRunnerDeps` (all optional, production defaults in parentheses):

```ts
export type KimiRunnerDeps = {
  spawnProcess?: typeof spawn;              // (node:child_process.spawn)
  sessionStore?: KimiSessionStore;          // (FileKimiSessionStore at KIMI_SESSION_STORE_PATH)
  nowMs?: () => number;                     // (performance.now)
};
```

Spawned argv, in order:

```text
KIMI_COMMAND [-S <kimiSessionId>] -p <prompt> --output-format stream-json [-m <KIMI_MODEL>]
```

with `cwd = KIMI_WORKDIR`. `-S` is included only when a stored Kimi session ID
exists for this Linear agent session and the webhook is a follow-up.

### NDJSON parsing rules (`handleKimiEvent`)

- Read stdout line by line; blank lines and lines that fail `JSON.parse` are
  ignored (logged at debug level).
- Unknown `role`/`type` combinations are ignored for forward compatibility.
- `assistant.tool_calls[]` → `ProgressReporter.toolStarted(id, name, args)`
  where `args` is the parsed `function.arguments` JSON (unparseable → `{}`).
- `role: "tool"` → `ProgressReporter.toolEnded(tool_call_id, name, isError)`.
  `isError` detection is heuristic: true when the content starts with
  `error`-like prefixes; otherwise false (see Assumptions).
- Intermediate `assistant.content` → `ProgressReporter.thought(truncate(text))`.
- Final `assistant.content` → `KimiRunResult.outputText` → final `response`.
- `meta.type === "session.resume_hint"` → capture `session_id`, persist via
  the session store for the current Linear `agentSession.id`.

### Session store (`src/kimi-session-store.ts`)

```ts
export type KimiSessionStore = {
  get(agentSessionId: string): Promise<string | undefined>;
  set(agentSessionId: string, kimiSessionId: string): Promise<void>;
};
```

File format: `{ "<linearAgentSessionId>": { "kimiSessionId": "...", "updatedAt": "<iso>" } }`.
Writes are atomic (write temp file, rename). Missing/corrupt file behaves as empty.

### Follow-up semantics (`src/session-runner.ts`, adapted)

- `created` → start a run with `buildKimiPrompt`; no `-S` (fresh Kimi session).
- `prompted`, no active run, stored Kimi session exists → start run with
  `buildKimiFollowUpPrompt` and `-S <kimiSessionId>`.
- `prompted`, no active run, no stored session (e.g. state wiped) → start a
  fresh run with `buildKimiPrompt` (full issue context) instead of failing.
- `prompted` while running → queue as `pendingPayload` (existing behavior) and
  post a "queued" thought. `queuePiFollowUp` is deleted; there is no mid-run
  injection.
- Stop/cancel → `abortKimiSession` kills the child (SIGTERM, then SIGKILL
  after a 5s grace period), posts the existing stop error activity.

### Progress mapping

All user-facing strings switch from "Pi" to "Kimi". The reporter machinery
(debounce, heartbeat, dedupe, redaction, truncation) is unchanged; config keys
inside `ProgressReporter` read the new `KIMI_PROGRESS_*` values.

## Dependency order (implementation slices)

Each slice is one TDD red→green cycle with its own tests; implement in this
order because later slices import earlier ones:

1. **Config rename** — `KIMI_*` schema in `config.ts`, update
   `config.test.ts`, `.env.example`. Fails until code compiles without `PI_*`.
2. **Session store** — `kimi-session-store.ts` + tests (get/set, atomic write,
   corrupt file recovery).
3. **NDJSON event handling** — `handleKimiEvent` in `progress.ts` (replacing
   `handleSdkEvent`) + tests with recorded fixtures, including malformed lines
   and unknown event types.
4. **kimi-runner** — prompt builders, `runKimi` with injected fake spawn
   (streaming NDJSON fixtures), timeout kill, abort, summary/truncation;
   `kimi-runner.ts` + tests. This slice removes `pi-runner.ts` and the pi
   dependency from `package.json`.
5. **session-runner rewiring** — swap imports to kimi-runner, follow-up resume
   vs queue vs fresh-start logic, stop path; update `session-runner.test.ts`.
6. **Cleanup and docs** — `package.json` rename to `linear-kimi-agent`,
   README, INSTALL.md, systemd template rename, CHANGELOG, smoke script
   strings.
7. **End-to-end verification with a fake kimi** — a shell-script fixture as
   `KIMI_COMMAND` emitting NDJSON; drive `handleAgentSessionWebhook` through
   created → response, prompted → `-S` resume argv, stop → kill, asserting on
   the Linear activities posted via an injected sender.

## Acceptance criteria (definition of done)

- `npm run typecheck`, `npm run build`, `npm test` all pass.
- No source file imports `@earendil-works/pi-coding-agent`; the dependency is
  absent from `package.json` and the lockfile.
- No `PI_*` environment variable remains in `src/`, `.env.example`, or docs.
- The fake-kimi end-to-end test demonstrates all four behaviors: created →
  response activity, prompted with stored session → resume argv, prompted
  without stored session → fresh run, stop → killed process + error activity.
- Timeout and abort paths are covered by tests that observe the child process
  being killed.
- README describes the Kimi setup (including `kimi login` on the host) and the
  new `KIMI_*` configuration.
- A Linear-facing manual smoke check (real webhook against a dev install) is
  documented as a follow-up step for the user, not a code gate — it needs the
  user's Linear workspace and a public URL.

## Assumptions (explicit, with risk)

- **A1 (verified)**: kimi `-p` headless mode auto-approves tool calls.
- **A2 (assumed)**: The `stream-json` schema is stable across kimi releases.
  Mitigation: unknown lines/events are ignored, and the runner works even if
  only `assistant.content` and `session.resume_hint` survive a schema change.
- **A3 (assumed)**: Tool-result error detection is heuristic because the
  observed tool event has no `isError` field. Worst case: a failed long tool
  posts a "Finished" notice instead of an error notice; final results are
  unaffected.
- **A4 (assumed)**: `kimi` is installed and authenticated on the host.
  Mitigation: spawn `ENOENT` surfaces as a clear error activity telling the
  operator to install/login the CLI.
- **A5 (assumed)**: One Kimi process per Linear agent session at a time, which
  the existing session-runner state machine already enforces.
- **A6 (assumed)**: Kimi sessions persist on the host under the service user's
  home directory, so `-S <id>` resume works after service restarts. If Kimi
  session storage is pruned, resume fails; the runner then reports the error
  to Linear (no automatic retry with a fresh session in v1).
