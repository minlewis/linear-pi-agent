## Active initiative: Kimi Code runner

This repo is being converted from a pi runner to a Kimi Code runner (Linear Agent Session → `kimi` CLI subprocess). When touching runner, config, progress, or session code, read the spec first: `docs/specs/kimi-runner.md` is the single source of truth for scope, pinned interfaces (`KIMI_*` env schema, kimi-runner exports, NDJSON event mapping), dependency order, and acceptance criteria. Implementation slices are tracked as GitHub issues #2–#8 under epic #1 on the fork `minlewis/linear-pi-agent`; keep issue checkboxes/state in sync as slices land.

Remotes: `origin` points at the upstream `hiasinho/linear-pi-agent`; the user's fork is `minlewis/linear-pi-agent`. Issues, pushes, and PRs target the fork unless the user says otherwise.

Delete this section once the migration is complete and issues #1–#8 are closed.

## Agent skills

### PRDs

PRDs/specs live as local markdown under `docs/specs/<feature-slug>.md`; skills should create, update, and read specs there. See `docs/agents/prd.md`.

### Issue tracker

Implementation issues are tracked in GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context repo: use optional root `CONTEXT.md` and root `docs/adr/` when present. See `docs/agents/domain.md`.

### Review

Review uses user-provided specs/issues first, then branch/commit references, then matching specs under `docs/specs/`; default diff base is merge-base with `main`. See `docs/agents/review.md`.
