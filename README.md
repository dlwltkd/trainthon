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
large-scale benchmark comparisons. Public-repository draft PR delivery is available through
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

A live CVEfixes source pilot compares the same model in a disclosed Codex CLI
configuration and the Vouch workflow. No general security-performance improvement
is claimed. See [the cohort, grading policy, and limitations](bench/CVEFIXES.md).

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

File reads and searches return bounded pages with continuation positions. Large
files can be changed through an exact, unique `edit_file` replacement instead of
rewriting their full contents. Prompt workflows do not impose a cumulative
token ceiling across both roles, including conservative accounting when
a gateway omits usage. Red investigates the requested source paths and returns
its handoff when finished; there is no separate Red token or step cutoff.
There is no cumulative model-step ceiling for prompt reviews. A shared
twenty-minute wall-time limit still applies, including provider retry waits
and Blue validation. The handoff must
disclose unread source and unresolved questions. Existing-test and benchmark workflows retain their
200,000-token default. Before each model request, the harness
also reserves a conservative allowance for its context and output. A request
can exceed that allowance while recorded usage remains below the limit; this is
reported as a request-size limit, separately from time or step limits. It does
not indicate the provider account's balance.

Prompt reviews retry transient model API failures (HTTP 408, 429, and 5xx),
connection failures marked retryable by the provider, and empty replies up to
twice per request. Responses are streamed, with a 90-second inactivity deadline.
Active streams can continue within the shared run deadline. The timeline shows
waiting, receiving, tool preparation, first-response latency, and retry countdowns.
Only execution metadata and public decision summaries are displayed.
For a single-file snapshot, or exact repository paths named in the user prompt,
the harness supplies complete source files directly in each role's initial
context, up to eight files and 192 KB. This avoids repeated discovery calls while
keeping Red's baseline and Blue's candidate separate. Omitted or changed source
is still available through bounded file tools. The provided paths and content
hashes are recorded in `source-context-red.json` and `source-context-blue.json`.

Agents report meaningful decisions, changes, and completion through
`report_progress`; the harness does not add model requests on a fixed step cadence.
After 64 KB of new conversation history, prompt reviews request a fresh public
progress update and compact older messages into a checkpoint. The original task,
active skill, observed file paths, findings, Blue assessments, edit records, and
latest plan remain available, along with the latest complete tool exchange and
up to two recent source exchanges. The newest source exchange always remains
intact; a second is retained when their combined size is at most 32 KB.
Older source pages can be reread when an omitted detail is needed. Checkpoint events
show the conversation's byte size before and after; this is not a token limit or
a reduction of the provider's context window. Compaction and retry recovery apply
within the current run, not across process restarts.
Tool calls execute after a complete response; interrupted streams cannot execute
partially received tools. Retries retain completed
tool results and count toward the shared run limits; they do not restart the
review. The timeline shows the HTTP status or timeout and the retry delay.
`Retry-After` is honored when supplied; otherwise retries wait one and two
seconds. Cancellation and the run deadline interrupt that wait. Failed attempts
without usage are conservatively accounted and marked unknown. Repeated empty
Red replies produce an explicitly partial handoff only when source was observed.
If Red's transient API errors persist after retries, the harness retains its
observed source and recorded findings in a partial handoff, with the provider
failure attached. Blue may continue independent source validation, but a partial
Red review leaves the overall run `INCOMPLETE_REVIEW`, preserves candidate changes,
and disables draft PR delivery. Historical partial reviews are displayed the same
way without rewriting their logs. Authentication errors, cancellation, and exhausted run limits still stop
the run. If Blue already edited source before an interruption, the harness checks
protected-file boundaries and saves the candidate diff before cleaning up the
workspace. Saving that diff does not complete validation or enable PR delivery.

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
