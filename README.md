# Vouch

**A common agent framework for security work.**

Vouch brings model execution, skills, bounded tools, public activity, and
reviewable evidence into one structure for defensive security workflows. Local
repository repair is the first implemented workflow: it takes a supplied security
report and regression test, prepares a candidate patch when the test fails, and
records the before/after results.

Its CLI and local dashboard show the repository alongside actual skill calls,
public decision summaries, plans, tools, and test evidence. Code review,
configuration review, dependency review, and incident-artifact review are planned
workflows. GitHub connection, the QR audience flow, benchmark comparisons, and
draft PR creation also remain planned.

## Why Vouch

- **Shared execution** — keep model configuration, budgets, skill calls, public
  decisions, and tool results in a consistent run history.
- **Bounded tools** — enforce each role's capabilities in the harness. In the
  repair workflow, only application source can change; tests and configuration
  stay protected.
- **Evidence for the result** — the repair workflow preserves the supplied test
  inventories and verifies candidates in a fresh snapshot. It stops without a
  patch when the supplied regression already passes.
- **Reviewable runs** — retain the diff, structured test results, model configuration,
  usage, and correlated tool events after cleanup. Watch a running CLI session in
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

The engine has local-repository and prepared-benchmark entry points.
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

Open [http://localhost:5173](http://localhost:5173). Start a local repository run
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

The repository MVP accepts a local Git repository, a report, and a designated
Vitest or pytest regression. Scripted mode is useful for a deterministic rehearsal:

```bash
pnpm cli run \
  --repo /path/to/project \
  --report ./report.md \
  --regression tests/security.test.ts \
  --mode scripted \
  --patch ./candidate.diff
```

For a live repair, copy the environment template and add the provider keys
locally. Blue defaults to `gpt-5.6-sol` through OpenAI; Red defaults to
`glm-5.3-flash-uncensored` through Routeway:

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

The CLI loads the root `.env` without overriding exported variables. Run the
repair with that provider configuration:

```bash
pnpm cli run \
  --repo /path/to/project \
  --report ./report.md \
  --regression tests/security.test.ts \
  --mode live
```

Local runs snapshot the requested commit, overlay the supplied regression,
install the project's dependencies in Docker, and run tests without
network access. Only JS/TS/Python application source can change. Local success is
`TESTS_PASSED`, with verification scope `repository_tests` and
`independentGrader: false`. It requires the exact regression and the functional
suite to pass in a fresh copy; it is never reported as `FIXED_VERIFIED`.
Artifacts are written below `runs/<runId>/` before cleanup.

The CLI streams elapsed-time progress to stderr: repository setup, test starts
and results, model requests, roles, skill calls, public decisions, and tool activity.
Long operations print a waiting update every 10 seconds. The final summary goes to stdout;
append `2>progress.log` to save the progress separately. Operation events are
also persisted in `events.jsonl` for the dashboard and later review.

Local agents call `use_skill` to load `evidence-review`, `minimal-repair`, or
`regression-verification`, subject to their role. The harness requires an actual
skill call and a `report_progress` plan before repository tools become available.
Decision summaries include a next action, up to six plan steps, and evidence
paths drawn from the supplied test, read/search results, or successful source edits.
The dashboard renders the resulting `skill_call`, `agent_update`, and correlated
tool events; it does not expose hidden reasoning or invent missing activity.
When the baseline regression already passes, it explicitly shows that no model
was invoked.

The repository pane links inspected files, proposed diffs, and test results.
New local runs save their source path in the private `repository.json` artifact
so file previews can read the checked commit while the repository remains
available. Older runs may have no source path; their recorded activity and
evidence remain viewable without fabricated file contents.

This slice supports Node projects with one npm or pnpm lockfile, Vitest 4–5,
and Vite 6.1 or newer, plus Python 3.11 projects with pytest 8–9. Vouch itself
requires Node 22+, pnpm, Git, and Docker.
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

The local MVP assumes the owner trusts the selected commit, lockfile, test runner,
and tests. It uses immutable harness-owned test options: executable repository
Vitest/Vite configs and environment files are disabled, and PostCSS receives an
empty inline configuration. Config-defined plugins, setup files, aliases, and
custom test patterns are outside this slice.

Editable application source runs in the same test process as the assertions. It
can overfit visible tests or alter assertion behavior, so passing results require
code review and are not proof of a security fix. The separate hidden grader is
available only on the benchmark path. Hiding tests does not prevent same-runtime
tampering; isolating grader control from candidate code for adversarial evaluation
remains future work. Local results do not count as benchmark performance.

Run the optional Docker integration check for the Python adapter with
`VOUCH_DOCKER_TESTS=1 pnpm exec vitest run packages/sandbox/src/python-project.test.ts`.
