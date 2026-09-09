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
App/OAuth connection, private remote repository access, the QR audience flow, and
benchmark comparisons. Public-repository draft PR delivery is available through
an explicit action in the dashboard.

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

The planned benchmark compares models with and without the harness. No measured
security-performance improvement is claimed yet.

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
provides the React/Vite repository and activity view. The Bench comparison
interface remains planned.

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

For a built dashboard served by the local API:

```bash
pnpm build:dashboard
pnpm --filter @vouch/server start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Provider keys are loaded by the
server from the root `.env`; the browser receives configuration and key-presence
status, never the keys. `pnpm typecheck` checks both the harness and dashboard.

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
Prompt workflows start with Red source discovery, defaulting to
`glm-5.3-flash-uncensored` through Routeway. Blue, defaulting to `gpt-5.6-sol`
through OpenAI, independently checks the reported source evidence and proposes
changes when `--fix` is selected. Configure both provider keys; the live doctor
command probes both roles:

```bash
install -m 600 .env.example .env
# Edit .env, validate configuration, then make one tool-call probe per role.
pnpm cli doctor
pnpm cli doctor --live
```

Daybreak Blue can replace the Blue default with
`--model gpt-daybreak-blue-latest` after the OpenAI project receives separate
Daybreak access. [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest)

`.env` is ignored by Git. Vouch accepts key-environment names rather than raw
key flags, and it does not print key values in configuration or run logs. The
Routeway Red role uses read-only tools to review evidence before Blue repairs
the code. Its adapter sends `max_completion_tokens` and omits `seed`, which this
exact GLM model does not advertise as supported. The adapter and connection
check are implemented. Routeway currently returns null token counts for this
model, so Vouch marks usage unknown and charges the full reserved token bound
instead of reporting invented usage or cost.

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

Blue must read the source and record its own confirmed findings before editing;
Red's findings alone do not authorize a change. Only
application source may change, and the final diff must be inspected with protected
files unchanged. A completed candidate is `PATCH_PROPOSED` with scope
`source_patch` and `testsRun: false`: it has not passed tests or runtime
verification. Review the findings and diff before using the patch. This mode
still requires no test suite, dependency installation, or Docker.

File reads and searches return bounded pages with continuation positions. Large
files can be changed through an exact, unique `edit_file` replacement instead of
rewriting their full contents. Prompt workflows do not impose a cumulative
token ceiling across both roles, including conservative accounting when
a gateway omits usage. Red is asked to finish its investigation after 30% of that
allowance or eight model steps, then make a final handoff within the shared run.
This leaves capacity for Blue; the handoff must disclose unread source and
unresolved questions. Existing-test and benchmark workflows retain their
200,000-token default. Before each model request, the harness
also reserves a conservative allowance for its context and output. A request
can exceed that allowance while recorded usage remains below the limit; this is
reported as a request-size limit, separately from time or step limits. It does
not indicate the provider account's balance.

To repair against an existing regression, provide `--regression`. Both `--report`
and a supplemental `--prompt` are optional; `--fix` cannot be combined with this
mode because regression repair already permits source changes:

```bash
pnpm cli run \
  --repo /path/to/project \
  --report ./report.md \
  --regression tests/security.test.ts \
  --mode live
```

Repair runs snapshot the requested commit, overlay the supplied regression,
install the project's dependencies in Docker, and run tests without
network access. Only JS/TS/Python application source can change. Local success is
`TESTS_PASSED`, with verification scope `repository_tests` and
`independentGrader: false`. It requires the exact regression and the functional
suite to pass in a fresh copy; it is never reported as `FIXED_VERIFIED`.
Artifacts are written below `runs/<runId>/` before cleanup.

For a public GitHub run with a nonempty patch and status `PATCH_PROPOSED` or
`TESTS_PASSED`, the result view offers **Create draft PR**. Set `GITHUB_TOKEN` or
`GH_TOKEN` in the server environment or root `.env`, with repository Contents and
Pull requests write permissions and push access to that repository. Restart the
server after changing its environment. The button calls
`POST /api/runs/:runId/pull-request` and creates a dedicated branch and draft PR
only when selected; it does not merge the change. The checked commit must still
be the repository's default-branch head. Fork delivery is not supported.

The draft includes the observed verification scope. A `PATCH_PROPOSED` draft is
explicitly marked untested; `TESTS_PASSED` describes the existing tests that ran.
The token stays in the local server, while repository acquisition remains
anonymous and limited to public HTTPS GitHub URLs.

The CLI streams elapsed-time progress to stderr: repository setup, test starts
and results, model requests, roles, skill calls, public decisions, and tool activity.
Long operations print a waiting update every 10 seconds. The final summary goes to stdout;
append `2>progress.log` to save the progress separately. Operation events are
also persisted in `events.jsonl` for the dashboard and later review.

Source review can load `source-security-review`, `auth-boundary-review`,
`config-dependency-review`, and `remediation-planning`. Source remediation adds
`source-remediation` and `change-validation`; regression repair retains
`evidence-review`, `minimal-repair`, and `regression-verification`. Each uses real
`use_skill` calls. Source findings are recorded with `report_finding`, including
severity, confidence, observed file evidence, and a defensive recommendation.
Confirmed source evidence is distinguished from potential issues and untested
runtime assumptions. The harness
requires an actual skill call and a `report_progress` plan before repository tools
become available.
Decision summaries include a next action, up to six plan steps, and evidence
paths drawn from the supplied test, read/search results, or successful source edits.
The dashboard renders the resulting `skill_call`, `agent_update`, and correlated
tool events; it does not expose hidden reasoning or invent missing activity.
When the baseline regression already passes, it explicitly shows that no model
was invoked.

The repository pane links inspected files, proposed diffs, and test results.
Runs retain private repository metadata and public GitHub source snapshots for
checked-revision previews. Local repair runs can also use the recorded source
path while that repository remains available. Older runs may lack the necessary
source metadata; their activity and evidence remain viewable without fabricated
file contents.

Vouch requires Node 22+, pnpm, and Git. The repair workflow additionally requires
Docker and supports Node projects with one npm or pnpm lockfile, Vitest 4–5,
and Vite 6.1 or newer, plus Python 3.11 projects with pytest 8–9.
Functional tests must live in conventional protected test paths; a collected
test outside those paths is rejected during setup.

For Python, use a `.py` regression path. The runner reads root
`requirements-test.txt` (or `requirements.txt`), follows relative `-r` includes,
and requires exact `name==version` pins, including pytest. It installs PyPI wheels
without mounting repository code during setup. Editable installs, source builds,
custom indexes, version ranges, and environment markers are unsupported.

```bash
pnpm cli run \
  --repo /path/to/python-project \
  --report /path/to/python-project/docs/security-report.md \
  --regression tests/test_security.py \
  --mode live
```

Pytest uses harness-owned configuration and disables plugin autoload. Existing
`conftest.py` fixtures remain available and immutable; `TESTING=1` is set and
dotenv loading is disabled. `DATABASE_URL` points to a temporary SQLite database
inside each test container; these environment settings are saved in the runtime
record. Projects requiring another database need a separate adapter.
Test setup/import errors are recorded separately
from failed assertions. Skipped or expected-failure regression cases cannot pass
verification. Protected fixtures may be up to 8 MB each; source and supplied
regression files remain capped at 2 MB, within a 30 MB / 3000-file snapshot.

The dependency-install container has network access during preparation. Install
scripts, pnpm hooks, linked/file/custom-tarball dependencies, and non-npmjs URLs
in npm locks are rejected; dependency extraction is monitored at 750 MB and
100,000 entries. Test containers have no network, return structured
evidence through a bounded output channel, and use a read-only repository mount. Each record includes the
pinned container digest, runner and package-manager versions, dependency input hash,
resolved input hash, and before/after test manifests. Python records also include
the resolved dependency versions and wheel SHA-256 hashes from the
[pip installation report](https://pip.pypa.io/en/stable/reference/installation-report/).
Transitive Python dependencies are resolved during setup and reused throughout
the run; direct requirements pins alone do not lock them across future runs.

The repair workflow assumes the owner trusts the selected commit, lockfile, test runner,
and tests. It uses immutable harness-owned test options: executable repository
Vitest/Vite configs and environment files are disabled, and PostCSS receives an
empty inline configuration. Config-defined plugins, setup files, aliases, and
custom test patterns are outside this slice.

The implemented sandbox runs supplied regression and functional tests in
containers with networking disabled. Red reviews supplied evidence and observed
test results through bounded read-only tools. A separate server lifecycle adapter
for isolated startup, health checks, existing tests, bounded logs, and cleanup is
planned; Vouch does not yet manage a persistent application server for that flow.
No automatic attack or new-reproduction skill is part of these repository workflows.

Editable application source runs in the same test process as the assertions. It
can overfit visible tests or alter assertion behavior, so passing results require
code review and are not proof of a security fix. The separate hidden grader is
available only on the benchmark path. Hiding tests does not prevent same-runtime
tampering; isolating grader control from candidate code for adversarial evaluation
remains future work. Local results do not count as benchmark performance.

Run the optional Docker integration check for the Python adapter with
`VOUCH_DOCKER_TESTS=1 pnpm exec vitest run packages/sandbox/src/python-project.test.ts`.
