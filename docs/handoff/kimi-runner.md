# Handoff: pi → Kimi Code runner migration

Date: 2026-09-19
Status: completed locally, ready for push/PR (requires user authorization)
Spec: `docs/specs/kimi-runner.md` (amended once during review: `handleKimiLine` name and return contract; `stderr` added to `KimiRunResult`; CHANGELOG exempt from the no-`PI_*` criterion)
Tickets: minlewis/linear-pi-agent issues #2–#8 (closed), epic #1 (open, closes on merge)

## What was done

Branch `kimi-runner`, 8 commits on top of base `ee11812` (merge-base with `main`):

| Commit | Slice |
| --- | --- |
| 5adf892 | 1: config `PI_*` → `KIMI_*` |
| 61e721f | 2: file-backed kimi session store |
| d2b4997 | 3: NDJSON handling in progress.ts |
| 7a20105 | 4: kimi-runner; pi-runner and pi dependency removed |
| 06ce2cd | 5: session-runner rewiring + branch tests |
| ad5dc26 | 7: fake-kimi end-to-end tests |
| 85a2427 | 6: rename to linear-kimi-agent (package/docs/systemd) |
| 3aebd71 | review pass: single NDJSON parse, final-answer-once, awaited session persist, errno helper, e2e wiring helper, e2e flake fix |

## Verification evidence

- `npm run typecheck` — clean
- `npm run build` — clean
- `npm test` — 66/66 pass, 6 consecutive full-suite runs stable (a flake in the e2e file was found and fixed in 3aebd71: dynamic import raced a 0ms timer)
- Fake-kimi E2E (`test/agent-session-e2e.test.ts`): created→response, prompted→`-S` resume, prompted-without-session→fresh, stop→SIGTERM kill
- Real kimi CLI integration check (2026-09-19, kimi v2.0.1, temp workdir): `runKimi` with real spawn — exit 0, file created in `KIMI_WORKDIR`, `session_id` captured and persisted to the session store file; follow-up resumed the same session and recalled prior context
- `package.json`/`package-lock.json`: zero `earendil` references; no `PI_*` legacy keys in `src/`, `.env.example`, `README.md`, `INSTALL.md`
- Code review: two-axis (standards + spec) sub-agent review against base `ee11812`; 13 findings total, all addressed or explicitly accepted (`SessionContext` data-clump left as-is: churn outweighs benefit); fixes in 3aebd71

## Known follow-ups

- Push `kimi-runner` to `minlewis/linear-pi-agent` and open a PR — needs user authorization. Local `origin` points at upstream `hiasinho/linear-pi-agent`; add the fork as a remote or push with an explicit URL.
- Manual live smoke against a real Linear workspace (webhook → agent run → activities visible in Linear) — needs the user's Linear app, secrets, and a public URL; documented as a follow-up in the spec, not a code gate.
- Behaviour note carried over from the pi version: a stop posts both a "Stopped by user" error activity and, when the killed run settles, a "kimi failed/timed out" error activity. Kept for parity; dedupe later if it bothers users.
- `AGENTS.md` "Active initiative" section should be deleted after merge and epic #1 close.
