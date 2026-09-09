# Vouch hackathon MVP

Hackathon scope for Vouch as a common security-agent framework, with prompt-based
repository source review, optional source remediation, and regression-based repair implemented. The shared
architecture is defined in [SECURITY_FRAMEWORK.md](./SECURITY_FRAMEWORK.md). This demo narrows the
broader [HARNESS_PLAN.md](./HARNESS_PLAN.md); the benchmark below has not been run.
The local CLI, repository dashboard, and Hono/SSE server are implemented. The
dashboard shows real skill calls, public decision summaries, plans, tools, and
source/test evidence, including live CLI runs and labeled replay. Public GitHub
URLs work through anonymous HTTPS acquisition. GitHub App/OAuth, private remote
access, the QR flow, and Bench comparisons remain planned. A local-server action
can deliver recorded patches as draft PRs to public repositories where the
configured GitHub token has push access.

**Pitch:** Vouch gives defensive security agents a common execution structure:
skills, bounded tools, visible decisions, and evidence for their results. Start
with a repository URL and prompt for a source review, or opt into a proposed
source patch with `--fix`. Supply an existing
regression to request a repair with before/after test evidence. A planned paired
benchmark will measure whether the harness improves the same model's security
repair performance.

New workflows should reuse that execution and viewing structure while defining
their own inputs, roles, tool permissions, stages, and verification scope. Dedicated
configuration, dependency, and incident-artifact review workflows remain planned.
A general workflow registry is also planned; the repository workflows have
explicit entry points today.

The default source-review demo needs only a public repository URL and prompt:

```bash
pnpm cli run \
  --repo https://github.com/owner/repo \
  --prompt 'Review authentication and authorization boundaries' \
  --mode live
```

`--report` is optional. This workflow requires no regression, test suite,
dependency installation, or Docker: the agent only reads pinned source and
records evidence for its review. `REVIEW_COMPLETE` has scope `source_review`; it
does not prove the repository secure. `INCOMPLETE_REVIEW` remains a distinct
outcome. Public source snapshots persist for later file previews. These URL runs
use the presenter's local harness, without a GitHub App or Actions integration.

Add `--fix` to the prompt-based run to permit justified application-source edits.
The agent records findings with observed file evidence and uses
`source-remediation` before editing, then `change-validation` and `inspect_diff`
after the final edit. `PATCH_PROPOSED` has scope `source_patch` and explicitly
records that tests were not run. It must remain distinct from a regression repair
that reaches `TESTS_PASSED`. Reports remain optional for repository workflows; `--fix` and
`--regression` select different validation paths and cannot be combined.

The result view's **Create draft PR** button calls
`POST /api/runs/:runId/pull-request` for a recorded public-repository source patch
with status `PATCH_PROPOSED` or `TESTS_PASSED`. The local server needs
`GITHUB_TOKEN` or `GH_TOKEN` with Contents and Pull requests write permissions
and push access to that repository. Delivery creates a dedicated branch and a
draft against the still-current checked default-branch commit. Untested proposals
are labeled untested; no fork or automatic merge is provided. The GitHub
App/OAuth and audience-owned Actions flow below remains separate planned work.

## Product: Run, Bench, and a QR audience experience

| Surface | Required behavior |
| --- | --- |
| Join | Scan the presentation QR on a phone, connect a repository the participant already owns, and start checking its actual code in that repository's GitHub Actions. |
| Run | Keep the participant's actual repository visible alongside a live agent activity feed, tool calls, skills/guidance, file changes, and verification results. |
| Bench | Compare each model with and without Vouch; show verified fixes, unnecessary changes, regressions, time, and cost. Open any result to inspect its run. |
| Evidence | Export the patch, regression test, before/after test output, model configuration, and run log. Create a draft PR for review in the selected repository once the required tests pass, with the scope and limits of those results visible. |

Use the existing TypeScript engine, a local Hono API with SSE, and a React/Vite
interface. Keep JSONL as the record of each run. Prepared local targets remain the
benchmark environment. The audience demo adds GitHub sign-in, selected-repository
access, and GitHub-hosted Actions execution against participants' actual projects.
The repair workflow supports JS/TS repositories using Vitest and a lockfile, and
Python 3.11 repositories with pinned pytest requirements; show these requirements
before selecting repair. Source review has no test-adapter requirement. Other
test adapters and production-server deployment come later.

The repair demonstration has three beats:

1. A real test demonstrates the reported vulnerability. Show the input, the
   affected behavior, and the failing security assertion.
2. Blue changes the application code. Re-run the exact saved reproduction and
   functional tests; display the patch and their observed results together.
3. Run the same report against the already-fixed control: no reproduced issue,
   no patch. Open the benchmark to show whether this behavior generalizes across
   the selected tasks and models.

Provide a visibly labeled replay of a saved run for presentation timing. A live
event stream follows a current run; show provider calls and test execution only
when those operations occur in its selected workflow.

## Demo UI: repository and agent activity

The UI is a core MVP requirement. An audience member should immediately recognize
whose repository is open, what the agent is doing, and what evidence supports the
result. The local implementation now provides the repository tree, code and diff
panes, linked test evidence, current decision and next action, plan status, skill
calls, and expandable tool activity. Source-review results show their source
evidence and coverage separately from repair test verdicts. The table retains
the full product target; authenticated audience identity and the App/Actions
delivery flow still need integration.

| Area | Required content and behavior |
| --- | --- |
| Repository header | Owner/repository, visibility, branch and checked commit; GitHub link, run status, elapsed time, and actual role/model assignments. |
| File explorer | The selected repository's real file tree. Mark files being inspected separately from files changed. Clicking a file opens its contents at the checked revision or its proposed diff. |
| Code and evidence | Readable code with line numbers, before/after diffs, and linked test results. Selecting an activity opens the relevant file, change, or evidence without leaving the app. |
| Agent activity | A compact chronological feed grouped by stage and role. Keep the current action prominent, with completed work below and detailed output expandable. |
| Skills and tools | Show configured guidance, recorded skill activations, and tool calls with clear labels. Each tool call shows its target, running/succeeded/failed state, duration, and concise result; expand for arguments and output. |
| Verification | Keep the reproduction result, functional-test result, and final verdict visible together. Enable the result PR link only when it exists. |

On desktop, use a repository sidebar, a central code/evidence pane, and an agent
activity panel. On mobile, keep the repository and current action visible above
Activity, Files, and Results tabs. The presentation view uses the same real run
with larger text and reduced secondary detail.

The activity feed should read like concrete actions: "Reading package.json",
"Searching validation code", "Updated src/merge.ts", or "Running functional
tests". Keep tool names visible as secondary labels such as `read_file` or
`run_tests`. Show an explicit handoff when Red finishes and Blue starts. Distinguish
agent actions from harness checks and GitHub setup operations.

Default to short action summaries and collapsed output. Group repeated reads and
searches without losing their individual entries. Use restrained color with text
status labels, keep code readable on a projector, and avoid forced scrolling
while a person is reading. A "Follow agent" control resumes automatic focus on
the latest action. Queueing, connection loss, failures, and retries must be visible.

Every activity and skill label comes from recorded execution data. Local agents
now load versioned defensive instructions through `use_skill`; configured system
guidance remains separately labeled. `report_progress` records a public decision
summary, next action, evidence paths, and a plan of up to six steps. The harness
requires a skill call and initial plan before repository tools, and accepts
evidence paths only from the supplied test, read/search results, or successful
source edits. Review specializations include authentication boundaries,
configuration/dependency declarations, and remediation planning. Actual
`report_finding` calls record severity, confidence, observed files, and defensive
recommendations. These updates explain the agent's decisions without exposing hidden
reasoning or fabricating narration.

The implemented event and viewing path provides:

- Tool start, completion, and error events correlated by call ID, with role,
  stage, target, duration, and expandable arguments/results.
- `skill_call` events with skill identity, version, and activation reason, plus
  `agent_update` events for the public decision and plan. Skill use is never
  inferred from a stage transition.
- Live SSE updates for server-started runs and CLI events observed from disk,
  plus explicitly labeled recorded playback with pause, seek, and speed controls.
  Missing completion events show an inactive stream rather than a finished run.
- Checked-commit file previews, recorded diffs, and persisted source/test evidence.
  Public GitHub runs retain source snapshots; local repair runs also support the
  source path in private `repository.json` metadata. Older runs may lack file
  previews while recorded activity and evidence remain accessible.

If a supplied regression already passes, the view says no model was invoked and
shows harness checks without inventing skill calls or a plan. The server binds to
`127.0.0.1:8787`; the development dashboard runs on port 5173, and a built dashboard
can be served by the same local API. This is the presenter's local interface;
authenticated audience access remains part of the GitHub/QR work.

Acceptance: a viewer can identify the repository, current role, current action,
and result at a glance; expand a tool call; inspect the associated file/diff;
see which guidance or skill was actually used; and follow verification through to
the real PR. The same flow must work on a phone and during a saved-run replay.
This experience is part of the Run-view milestone, not a final cosmetic pass.

## QR audience demo: check a repository you already own

**Required demo feature:** an attendee selects an existing project they own and
Vouch checks that project's actual code and dependencies. They leave with an
Actions run and, when a candidate passes the required tests, a draft PR against
the selected revision.
Creating a sample repository is not part of this audience flow; fixtures remain
bench and internal rehearsal assets. The presentation QR opens a
public HTTPS Join page that works on mobile data. It contains an event URL, never
credentials or an automatic authorization to run code.

The mobile flow is:

1. **Scan and sign in.** Sign in with GitHub. Explain
   which code/test output will be sent to model providers and the demo credit
   allowance before the participant starts a run.
2. **Choose my repository.** Select an existing repository the participant can
   manage, including a private repository when the required access is granted.
   Choose the branch and pin its commit. Preserve the repository's visibility and
   use its actual source, dependencies, and tests.
3. **Connect and finish setup.** Install Vouch for the chosen repository, or add
   it to an existing selected-repository App installation. Check the supported
   runtime and test adapter, dependency installation, baseline tests, Actions and draft
   PR availability, and Vouch workflow. If an existing repository has no workflow,
   create a setup PR and display "Merge setup PR" until it reaches the default
   branch. Installing the GitHub App alone does not install this file.
4. **Check my repository.** After the participant starts the run, inspect
   dependency advisories and supported static checks, or investigate an existing
   security report they provide. They need not arrive with a prepared benchmark
   task. For applicable findings, evaluate and verify candidate fixes against the
   selected project. Run in that repository's GitHub-hosted Actions environment.
   Show its real GitHub run link and Queue → Inspect → Reproduce → Patch → Verify
   on the phone. Refreshing the page reconnects to that run.
5. **Keep the result.** A candidate that passes tests opens a draft PR with the patch, regression
   test, before/after results, and Actions link. No reproduction produces a report
   and no patch. If the checks find no applicable issue, show their coverage and
   "No confirmed finding". Unsupported setup, failed verification, and timeouts remain
   explicit outcomes; "not reproduced" is not a claim that the repository is
   free of vulnerabilities. Changes are reviewed and merged by the participant.

Manual dispatch requires the workflow to exist on the default branch, so
connecting a repository for the first time can require a real setup-PR merge.
[workflow dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

Keep the implementation bounded:

- Use a GitHub App scoped to the chosen repositories. Its backend handles setup
  PRs, dispatch, status, and result PRs. Keep App credentials outside the target
  runner; show installation or organization-policy blocks during setup.
- Sponsor a limited number of live runs so attendees do not enter model API keys
  on their phones. A backend model proxy holds provider credentials and grants
  bounded access only to the authorized repository/workflow/run. GitHub Actions
  OIDC can authenticate that request; the proxy still has to validate it and
  enforce model, token, and event spending limits. Keep this access outside the
  sandbox that executes repository code and generated tests.
- Allow one active run per repository, retain the shared eight-minute cap, and
  queue excess demand. Export results to GitHub as well as the mobile page so the
  participant keeps the evidence after the presentation.
- Existing-repository runs use supported check results or the supplied report,
  plus protected project tests. Findings are unknown until investigated.
  They have no benchmark ground-truth grader, so describe exactly what was tested
  and keep their results outside the frozen benchmark scores. Label successful
  local checks `TESTS_PASSED`, not `FIXED_VERIFIED`, and require code review.

The App permissions and dispatch integration must be implemented explicitly.
Returning PRs through the backend App avoids depending on a repository allowing
`GITHUB_TOKEN` to create PRs. The sponsored model proxy is an additional service,
not a capability supplied by OIDC itself. Check draft-PR support for existing
private repositories before offering this flow; availability depends on the
account plan and repository visibility.
[GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
[draft PR availability](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request),
[OIDC gateway pattern](https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/connect-to-a-private-network/connect-with-oidc)

The regression-based repair workflow is implemented in the CLI alongside source
review. It accepts a local Git root or public GitHub URL, pinned ref, and designated
regression, with an optional report and supplemental prompt. It
uses the project's locked Vitest installation or pinned pytest requirements in Docker; permits source-only
changes; and persists the patch, structured before/after test evidence, run record,
and correlated event log before cleanup. Records bind the run to the commit,
regression, dependency input, pinned image, runner versions, and exact test inventories.
Dependency preparation rejects install scripts and local/custom package sources;
dependency extraction has a size/entry monitor, and tests run offline with bounded
structured output. It does not load a benchmark task or hidden grader. Local
success is `TESTS_PASSED`, with verification scope `repository_tests` and
`independentGrader: false`; this path never emits `FIXED_VERIFIED`.

The repair workflow assumes the repository owner trusts the selected commit,
lockfile, Vitest dependency, and tests. Executable repository Vitest and Vite
configuration and environment files are disabled; immutable harness options drive
collection and execution, including an empty inline PostCSS configuration.
This slice supports Vitest 4–5 and Vite 6.1 or newer. Config-defined
plugins, setup files, aliases, and custom test patterns are therefore outside the
current slice. Python 3.11 / pytest 8–9 support installs PyPI wheels from exact
requirements pins, records resolved versions and wheel hashes, disables pytest
configuration and plugin autoload, and preserves immutable `conftest.py` fixtures.
The exact supplied test and conventional test files are immutable.
Editable application modules still share the test process with assertions: they
can overfit visible checks or alter assertion behavior. Test passes therefore
require code review and do not prove a security fix or benchmark improvement.
Only the benchmark path has a separate hidden grader. Hidden tests alone do not
stop candidate code from tampering with its runtime; isolating grader control
from candidate execution for adversarial evaluation remains future work.

The GitHub-hosted product path still needs these integration changes:

- Add repository-run inputs: authorized repository, branch, pinned commit,
  supported checks or report, and detected install/test configuration. Keep them
  separate from benchmark task labels and dev/eval splits.
- Check out the requested commit and install that project's dependencies in an
  isolated environment. Establish a baseline with its own tests and supported
  test adapter; Vouch's development dependencies cannot stand in for the project.
- Verify using preserved before/after evidence and protected project tests,
  without requiring `bench/graders/<taskId>`. Retain the patch and evidence before
  cleanup and bind the result PR to the checked revision.

The current sandbox executes the supplied regression and functional tests in
containers with networking disabled. Red reviews code and observed test results
through read-only tools. A separate adapter for isolated application-server
startup, health checks, existing tests, bounded logs, and cleanup is planned; that
server lifecycle is not implemented yet. These repository workflows do not add
automatic attacks, generated payloads, or new reproduction tests.

During the presentation, show the QR while the presenter checks an existing project.
An opt-in audience activity panel can show joined participants and run outcomes;
private repository names and code stay on the participant's own result page.
Invite one participant to open their actual GitHub PR on their phone. Keep these
live audience outcomes visually separate from the controlled Bench comparison.

Acceptance: two participants each connect a different existing compatible project
with no Vouch-specific task files, complete setup, and run checks on its actual
source without entering model keys. Include a private repository with supported
account permissions. Real Actions links open in the owning accounts; an applicable
candidate that passes tests produces a draft PR there, and no confirmed issue
produces a report with no source patch. Refresh preserves progress. Rehearse
queued, blocked, and unsuccessful runs as well as the successful path. The QR
feature is specified here; its app, workflow, proxy, and deployed URL still need
implementation.

## Models

The planned product configuration pairs **GLM 5.3 Flash Uncensored via Routeway for Red** with
**GPT-5.6 Sol via OpenAI for Blue**.
The local CLI's Red role reviews the supplied report and test evidence
with read-only tools. The CLI pins Blue to `gpt-5.6-sol` unless an explicit
flag or `VOUCH_BLUE_MODEL` override is supplied.
`gpt-daybreak-blue-latest` is a later Blue option, but it requires separate
OpenAI Daybreak approval and must pass the same live connection check first.

Routeway lists `glm-5.3-flash-uncensored`, function calling, and the API base URL
`https://api.routeway.ai/v1`. It describes the model as a community refusal-reduced
variant. Treat fewer refusals as a hypothesis to test; valid reproductions and
correct patches determine security performance. [Routeway model page](https://routeway.ai/models/glm-5.3-flash-uncensored)

These optional variables override the pinned Red profile:

```dotenv
VOUCH_RED_MODEL=glm-5.3-flash-uncensored
VOUCH_RED_PROVIDER=compatible
VOUCH_RED_BASE_URL=https://api.routeway.ai/v1
VOUCH_RED_API_KEY_ENV=ROUTEWAY_API_KEY
```

Set `ROUTEWAY_API_KEY` locally. The compatible-provider loop and strict model
selection have mock-provider coverage. On 2026-09-09, the live connection check
completed a required tool call with both `gpt-5.6-sol` and
`glm-5.3-flash-uncensored`. Routeway returned null token counts for the GLM
response; Vouch records `usageKnown: false`, charges the full reserved token
bound, and leaves cost unavailable. Record the actual provider and model for
every role; benchmark runs must fail configuration checks if a requested model
is unavailable, rather than falling back to another provider or a scripted
solution.

## Benchmark selection

Use an **adapted SecBench.js subset plus Vouch control tasks** for this MVP.
SecBench.js contains 600 reported server-side JavaScript vulnerabilities across
five classes, with executable tests and package/version metadata. Its Node targets
fit this repository. Add functional regression tests and independently verified
fixed versions to turn selected cases into security repair tasks. Record all
adaptations and report the result as a subset, not an official full-benchmark
score. [SecBench.js](https://github.com/cristianstaicu/SecBench.js)

SEC-bench directly evaluates both PoC generation and patching, but its Docker and
Python setup is a larger integration; its full setup recommends over 200 GB of
disk. It is the follow-up for a broader external evaluation.
[SEC-bench](https://github.com/SEC-bench/SEC-bench)

Select cases by published criteria before measuring agent performance: local
reproduction, stable functional tests, verified vulnerable/fixed versions, source
availability, and execution within the time limit. Stratify by vulnerability class
and source package. Record excluded cases and reasons; never select based on where
Vouch wins. Keep related package versions in the same dev/eval group.

## Comparisons

| Experiment | Model assignment | What the result measures |
| --- | --- | --- |
| B: baseline | Model M in an ordinary tool loop | Reference performance |
| C: Vouch | The same M for Red and Blue | Effect of the complete Vouch harness |
| C-mixed: product | GLM Uncensored Red + coding model Blue | Performance of the chosen product configuration |
| Prompt ablation | M in B's loop with the security guidance | Contribution of prompts versus orchestration |

Run B and C for at least two models, including GLM Uncensored and one other coding
model. Give both conditions the same initial report, repository, public tests,
ability to write/run reproduction tests, and total run budget. Baseline agents may
use their tools to reproduce issues voluntarily. C's shared budget covers both
roles and all retries. The mixed-model result does not isolate harness effects.

The current B/C comparison also changes security prompts. Label its result as the
effect of the complete system; use the prompt ablation before attributing gains
specifically to orchestration. Re-run baselines locally under this protocol rather
than comparing against published scores from different settings.

Start with the existing plan's 4 dev tasks and an 8-task eval pilot. The proposed
final target is **20 eval tasks: 12 vulnerable cases and 8 controls**, covering at
least three classes and several independent packages. Prefer fixed counterparts
for controls; document any synthetic non-applicable reports separately. Report
real vulnerability tasks and custom controls separately.

Two models × two conditions × 20 tasks × three repetitions = **240 runs**. The
8-task pilot is 96 runs. Run the mixed-model and prompt ablations after this core
comparison, budget permitting. Three repetitions estimate variability on each
task; they do not turn 20 tasks into 60 independent tasks. Freeze the task list,
model IDs, prompts, tool schema, budgets, and grader before final evaluation.

## Scoring and presentation

These are planned benchmark metrics, not scores from local repository runs. The
benchmark path has hidden grader assets, but an adversarial evaluation also needs
grader control isolated from candidate code; hiding tests in a shared runtime is
insufficient. Complete and validate that boundary before making such claims.

- **Verified fix rate:** hidden security tests and held-out functional tests pass,
  divided by all vulnerable task runs. Grade the actual patch independently of
  the agent's claimed outcome.
- **Unnecessary change rate:** protected application files change or functional
  behavior regresses on controls, divided by all control runs. Also report exact
  zero-diff controls.
- **Regression rate:** functional tests fail, divided by vulnerable task runs.
- **False completion rate:** the agent claims a verified fix but the independent
  grader rejects it. Store completion claims explicitly to measure this.
- **Valid reproduction rate, elapsed time, and cost per verified fix:** report
  alongside accuracy, using actual per-role token usage and model pricing.

Show paired baseline/Vouch points on a chart: verified fix rate upward,
unnecessary change rate rightward. Add per-model bars, task-level wins/losses, raw
counts, and uncertainty estimated by resampling source groups. A small pilot is
directional evidence. Preserve failures, timeouts, and infrastructure errors in
the run table; use a fixed, identical infrastructure retry policy for all arms.

The desired headline is a measured increase in verified fixes with fewer
unnecessary changes at the same budget. Report absolute percentage-point changes,
the denominator, and cost. A large gain is a goal, not a result to assume.

## Build order and acceptance

1. **Make verification trustworthy.** Require a real security assertion failure
   for reproduction; classify setup, import, and timeout failures separately.
   Preserve the reproduction and trusted tests outside editable agent files.
   Enforce the completion gate in the final verdict and give both conditions
   equivalent test-running capabilities. Enforce shared token, step, and wall
   budgets. Include role model configuration in the run fingerprint.
2. **Validate live models.** Exercise GLM tool calling and at least one coding
   model on dev tasks. Separate scripted, replay, and live modes explicitly.
   Execute generated tests in isolated processes/containers without provider
   credentials or access to hidden grader assets; the existing copied worktree
   alone does not provide that isolation.
3. **Build the eval runner.** Load a frozen task manifest, schedule paired runs,
   persist all outcomes, apply independent grading, and export metrics. Verify
   both vulnerable and fixed references before admitting a case. Isolate grader
   control from candidate execution before treating results as resistant to runtime
   tampering.
4. **Build Run and Bench.** Treat the repository workspace and clean agent
   activity view as core deliverables: real files, correlated tool calls,
   skills/guidance, live diffs, and verification evidence. Use recorded events for
   live updates and replay, with mobile and presentation layouts. Render benchmark
   comparisons from persisted results and finish evidence export and result PRs.
5. **Build the QR experience.** Ship the public mobile Join page, GitHub App
   connection, existing-repository intake and compatibility checks, supported
   security checks, Actions execution, bounded sponsored model access, and result
   PRs against the participant's actual code. This is required
   for the presentation; prioritize it over expanding support to more stacks.
6. **Rehearse.** One live successful fix, one unchanged fixed control, one saved
   replay, one reproducible comparison with inspectable raw runs, and participants
   taking home runs and PRs in their own GitHub accounts.

Completion means those artifacts work with real provider calls. The existing
scripted smoke tests validate wiring; they are not model-performance evidence.
