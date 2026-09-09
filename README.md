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
See [`HACKATHON_MVP.md`](./HACKATHON_MVP.md) for the proposed hackathon scope,
QR audience checks on participants' existing GitHub projects, Routeway Red
configuration, and benchmark comparison plan.

## Dev

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm cli run --task proto-pollution --condition C --mode scripted
```

The repository MVP accepts a local Git repository, a report, and a designated
Vitest regression. Scripted mode is useful for a deterministic rehearsal:

```bash
pnpm cli run \
  --repo /path/to/project \
  --report ./report.md \
  --regression tests/security.test.ts \
  --mode scripted \
  --patch ./candidate.diff
```

Use `--mode live` with an explicit model/provider and its API key to let the
repair agent edit source. The optional `VOUCH_RED_*` Routeway settings enable a
read-only GLM evidence review before Blue repairs the code.

Local runs snapshot the requested commit, overlay the supplied regression,
install the project's locked dependencies in Docker, and run tests without
network access. Only JS/TS application source can change. A verified result
requires the exact regression and the functional suite to pass in a fresh copy.
Artifacts are written below `runs/<runId>/` before cleanup.

This slice supports Node projects with one npm or pnpm lockfile, Vitest 3–5,
and Vite 6.1 or newer. It requires Node 22+, pnpm, Git, and Docker.
Functional tests must live in conventional protected test paths; a collected
test outside those paths is rejected during setup.

The dependency-install container has network access during preparation. Install
scripts, pnpm hooks, linked/file/custom-tarball dependencies, and non-npmjs URLs
in npm locks are rejected. Test containers have no network, return structured
evidence through a bounded output channel, and use a read-only repository mount. Each record includes the
pinned container digest, package-manager and Vitest/Vite versions, lockfile hash,
resolved input hash, and before/after test manifests.

The local MVP is for a repository and lockfile controlled by the person running
Vouch. It executes that repository's locked Vitest package and test config, so
its evidence is not an attestation against a deliberately malicious repository
or config. Application modules imported by tests remain application code and can
be repaired; the assertions only prove the behavior they cover. The frozen
benchmark uses a separate hidden grader for performance claims.
