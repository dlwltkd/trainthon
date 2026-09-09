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

See [`HARNESS_PLAN.md`](./HARNESS_PLAN.md) for the full build spec, benchmark protocol, and milestones.

## Dev

```bash
pnpm install
pnpm typecheck
pnpm cli run --task hello --condition B   # writes runs/<runId>.jsonl
```

Requires Node 22+ and pnpm.
