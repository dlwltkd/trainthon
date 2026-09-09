# Vouch

**A common agent framework for security work.**

Vouch brings model execution, skills, bounded tools, public activity, and
reviewable evidence into one structure for defensive security workflows. Start
with a local Git repository or public GitHub URL and a prompt for a read-only
source review. Add `--fix` to propose justified application-source changes without
running the project, or supply an existing regression for a repair with
before/after test results.

Its CLI and local dashboard show the repository alongside actual skill calls,
public decision summaries, plans, tools, and supporting evidence. Source review,
source remediation, and regression-based repair are implemented. Dedicated configuration, dependency,
and incident-artifact review workflows remain planned, along with GitHub
App/OAuth connection, private remote repository access, the authenticated Actions audience flow, and
large-scale benchmark comparisons. Public-repository draft PR delivery is available through
an explicit action in the dashboard.

The public audience demo is available at `/#/join` on phones and laptops. Submit
a public GitHub URL, follow the queued source review, and keep its result link or
download the report. New reviews can include source-matched before/after code
suggestions; these are not applied or tested. `/#/present` generates a presentation QR for the deployed
address. Run `pnpm build:dashboard && pnpm start:public` for rehearsal; see
[deployment and event limits](DEPLOY.md) for the single-service hosting setup.
For a Vercel frontend, use the repository root and set `VOUCH_API_ORIGIN` to the
public review server's HTTPS origin. The included `vercel.mjs` builds the audience
entry and proxies its API requests; the review server still needs persistent storage.

## Why Vouch

- **Shared execution** — keep model configuration, budgets, skill calls, public
  decisions, and tool results in a consistent run history.
- **Bounded tools** — enforce each role's capabilities in the harness. In the
  repair workflow, only application source can change; tests and configuration
  stay protected.
- **Evidence for the result** — source reviews cite observed files and their
  coverage limits. Repairs preserve test inventories and verify candidates in a
  fresh snapshot, stopping without a patch when the regression already passes.
- **Reviewable runs** — retain source reviews or patches and test evidence, model
  configuration, usage, and correlated tool events. Watch a running CLI session in
  the dashboard or replay its recorded events.

## Measured benchmark results

On 10 September 2026, we completed all 100 paired trials on a pinned, source-only
adaptation of 20 public CVE-Bench repair tasks. Both conditions requested
`gpt-5.6-sol` and received the same named source modules and task prompts.

| Measure | Codex CLI | Vouch, Red → Blue |
| --- | ---: | ---: |
| Expected verdict with a verbatim source citation | 40/50 (80%) | 47/50 (94%) |
| Completed trials | 50/50 | 50/50 |



## How it's built

The framework builds on the existing packages:

- `packages/model` — provider adapters and model/tool execution
- `packages/protocol` — shared run, tool, skill, and public progress events
- `packages/skills` — versioned defensive skills and role guidance
- `packages/engine` — workflow orchestration, budgets, tool boundaries, and result gates
- `packages/sandbox` — isolated workspaces and test execution

The engine has explicit source-review, repository-repair, and prepared-benchmark
entry points.
`apps/server` provides the local Hono API and SSE event stream; `apps/dashboard`
provides the React/Vite repository, activity, and benchmark evidence views.

See [`SECURITY_FRAMEWORK.md`](./SECURITY_FRAMEWORK.md) for the shared architecture
contract and the boundary between the framework and each workflow. The current
entry points are explicit; a general workflow registry has not been implemented.
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

Start the dashboard and API together:

```bash
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). Start a repository run
from the form, or open a run started by the CLI. The dashboard follows new events
from `runs/` and offers labeled replay with pause, seek, and speed controls for
completed runs. The development server proxies API requests to `127.0.0.1:8787`.

The [demo video script](DEMO_VIDEO.md) runs a bounded external assessment against
one authorized Milgram event. Red records live status codes, field names, and
security-header decisions without retaining response bodies, tokens, or PII values;
Blue then creates reference remediation code and a Korean responsible-disclosure
draft locally. No disclosure is sent. The completed live trace remains replayable.

For a built dashboard served by the local API:

```bash
pnpm build:dashboard
pnpm --filter @vouch/server start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Provider keys are loaded by the
server from the root `.env`; the browser receives configuration and key-presence
status, never the keys. `pnpm typecheck` checks both the harness and dashboard.

Run a paired source evaluation with the native Codex CLI and Python 3 installed:

```bash
pnpm cli eval --suite cvebench20     # all 20 external source repair tasks
pnpm cli eval --suite development20  # all 20 fixed development tasks, both conditions
pnpm cli eval --suite cvefixes --prepare
pnpm cli eval --suite cvefixes
```

The **Evidence** page at `/#/bench` shows all registered trials, including failures,
with verdicts, candidate artifacts, source hashes, and Vouch agent traces. The
registered model is `gpt-5.6-sol` for both conditions. This pilot compares source
labels and published patch references; it does not run CVE reproduction or
runtime regression tests.

The [fixed development set](bench/development20/README.md) contains 20 distinct
synthetic source tasks, including correct controls. Every run uses the same
hash-pinned problems and grader. Harness and skill improvements can be evaluated
on this set; the UI labels these as development-set tuning results, separately
from the four-snapshot CVEfixes pilot.

The [CVE-Bench source adaptation](bench/cvebench20/README.md) uses all 20 published
locate tasks with complete named modules and pinned correction commits. Its
headline score is module AST reference agreement; it does not reproduce the
original benchmark's runtime security or regression tests. Use this harder set
to inspect repair behavior, and retain the small development set as a basic check.

The repository workflows accept a local Git path or an anonymous public HTTPS GitHub URL
in the form `https://github.com/owner/repo` (an optional `.git` suffix and trailing
slash are accepted). The selected ref is pinned to a commit. Remote source
snapshots are persisted for file previews after execution. GitHub App/OAuth,
authenticated cloning, private remote repositories, and other Git hosts are not
supported yet.

Regression-based repair also accepts a supplied patch in scripted mode for a
deterministic rehearsal:

```bash
pnpm cli run \
  --repo /path/to/project \
  --report ./report.md \
  --regression tests/security.test.ts \
  --mode scripted \
  --patch ./candidate.diff
```

For live runs, copy the environment template and add the provider keys locally.
Prompt workflows start with Red source discovery. Red and Blue both default to
`gpt-5.6-sol` through OpenAI. Blue independently checks the reported source
evidence and proposes changes when `--fix` is selected. Red inherits Blue's
model and provider configuration unless explicitly overridden. The live doctor
command probes both roles:

```bash
install -m 600 .env.example .env
# Edit .env, validate configuration, then check a complete tool-call round trip per role.
pnpm cli doctor
pnpm cli doctor --live
```

Daybreak Blue can replace the Blue default with
`--model gpt-daybreak-blue-latest` after the OpenAI project receives separate
Daybreak access. [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest)

`.env` is ignored by Git. Vouch accepts key-environment names rather than raw
key flags, and it does not print key values in configuration or run logs. The
optional Routeway adapter remains available for explicitly selected models.
When a provider omits token usage, Vouch marks usage unknown and accounts for
the reserved token bound instead of inventing usage or cost.

The CLI loads the root `.env` without overriding exported variables. Start a
source review with a repository and prompt:

```bash
pnpm cli run \
  --repo https://github.com/owner/repo \
  --prompt 'Review authentication and authorization boundaries' \
  --mode live
```

No report, regression, test suite, dependency installation, or Docker is needed
for this workflow. The agent reads the pinned source through bounded tools; it
does not execute the project or change its files. `--report ./report.md` can add
context. The result is `REVIEW_COMPLETE` with scope `source_review`, or
`INCOMPLETE_REVIEW` when no usable source-backed review is produced. Completion
records a review of the observed source, not proof that the repository is secure.
The Markdown review and event history are retained in the run artifacts.

To propose source changes from the prompt, add the boolean `--fix` flag:

```bash
pnpm cli run \
  --repo https://github.com/owner/repo \
  --prompt 'Review authorization checks and correct confirmed source defects' \
  --fix \
  --mode live
```

Blue must read the source and record its own confirmed findings before editing.
For each Red finding, Blue calls `assess_finding` with a confirmed, dismissed,
or unresolved verdict and independently observed source paths. Confirmation links
to Blue's own recorded finding. The harness requires an assessment for every Red
finding before completing the review; the dashboard displays each verdict beside
the original claim. Only
application source may change, and the final diff must be inspected with protected
files unchanged. A completed candidate is `PATCH_PROPOSED` with scope
`source_patch` and `testsRun: false`: it has not passed tests or runtime
verification. Review the findings and diff before using the patch. This mode
still requires no test suite, dependency installation, or Docker.

