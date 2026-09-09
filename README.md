# Vouch

**Every security fix, proven.**

Vouch is an AI security agent that reproduces a vulnerability with a working exploit,
patches it, verifies the exploit no longer fires while normal behavior still passes, and
opens a draft PR with that evidence attached. If it cannot prove a vulnerability, it does
not change your code.

## Why Vouch

Tools like GitHub Copilot Autofix will *claim* a fix. Vouch **proves** it — and, just as
important, refuses to touch code when the reported issue cannot be reproduced. For a small
team without a dedicated security engineer, the value is a fix you can trust and a decision
you can audit.

- **Proof-carrying fixes** — a Red step writes an exploit that demonstrates the bug; a fix
  is only "verified" when that exploit is neutralized *and* functional tests still pass.
- **Restraint** — already-fixed code and non-applicable alerts result in zero changes, with
  a reasoned "not reproducible" verdict.
- **The PR is the audit trail** — diff, before/after tests, the exploit-as-regression-test,
  time and cost, all in one reviewable pull request.

## How it's built

Three layers, three packages, so the benchmark can toggle them cleanly:

- `packages/skills` — security prompts, tool descriptions, checklists (the SKILL layer)
- `packages/engine` — state machine, Red/Blue orchestration, budgets, completion gate (the HARNESS layer)
- `packages/sandbox` — isolated worktree, test execution (the SANDBOX layer)

The same execution engine powers both the product (Studio) and the benchmark (Bench).

**Local handoff, current milestone, env vars, and what to run on a desktop:** see
[`HARNESS_PLAN.md`](./HARNESS_PLAN.md) §0. Spec, benchmark protocol, and remaining M5/M6
work live in the rest of that file.

## Dev

Requires Node 22+ and pnpm 10.33.3. Branch: `cursor/harness-scaffold-39df`.

```bash
pnpm install
pnpm typecheck
pnpm test

# no API key → scripted wiring smoke (not a model score)
pnpm cli run --task proto-pollution --condition C
pnpm cli run --task proto-pollution-fixed --condition C
pnpm cli bench --set dev
pnpm cli replay --run <runId>

# live Studio (Vite :5173) + API (:8787)
pnpm dev
```

Keys are **not** loaded from `.env` automatically. Copy `.env.example`, fill it, then
`set -a && source .env && set +a` (or export in the shell) before `cli` / `dev`.

With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` the same commands use a real model. Optional
Red-only gateway: `VOUCH_RED_MODEL` + `ROUTEWAY_API_KEY` — see the plan §0.3.

Dev tasks: `proto-pollution`, `path-traversal` (vuln); `proto-pollution-fixed`,
`path-join-na` (controls; correct outcome is zero-line `NOT_REPRODUCIBLE`).
