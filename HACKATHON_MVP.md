# Vouch hackathon MVP

Proposed build scope, based on the current CLI harness. This narrows the broader
[HARNESS_PLAN.md](./HARNESS_PLAN.md); the benchmark below has not been run.

**Pitch:** Vouch turns a security report into a reproduced vulnerability, a tested
patch, and a reviewable evidence bundle. A paired benchmark measures how much the
harness improves the same model's security repair performance.

## Product: Run, Bench, and a QR audience experience

| Surface | Required behavior |
| --- | --- |
| Join | Scan the presentation QR on a phone, connect a repository the participant already owns, and start checking its actual code in that repository's GitHub Actions. |
| Run | Keep the participant's actual repository visible alongside a live agent activity feed, tool calls, skills/guidance, file changes, and verification results. |
| Bench | Compare each model with and without Vouch; show verified fixes, unnecessary changes, regressions, time, and cost. Open any result to inspect its run. |
| Evidence | Export the patch, regression test, before/after test output, model configuration, and run log. Create a draft PR in the participant's selected repository or the presenter's configured fork once the fix is verified. |

Use the existing TypeScript engine, a local Hono API with SSE, and a React/Vite
interface. Keep JSONL as the record of each run. Prepared local targets remain the
benchmark environment. The audience demo adds GitHub sign-in, selected-repository
access, and GitHub-hosted Actions execution against participants' actual projects.
Start with Node-based JS/TS repositories using Vitest and an installable lockfile;
show this compatibility requirement before connection. Other test adapters and
production-server deployment come later.

The demo has three beats:

1. A real test demonstrates the reported vulnerability. Show the input, the
   affected behavior, and the failing security assertion.
2. Blue changes the application code. Re-run the exact saved reproduction and
   functional tests; display the patch and their observed results together.
3. Run the same report against the already-fixed control: no reproduced issue,
   no patch. Open the benchmark to show whether this behavior generalizes across
   the selected tasks and models.

Provide a visibly labeled replay of a saved run for presentation timing. Reserve
"live" for runs actually invoking a provider and executing tests.

## Demo UI: repository and agent activity

The UI is a core MVP requirement. An audience member should immediately recognize
whose repository is open, what the agent is doing, and what evidence supports the
result. These are planning requirements only; UI implementation is deferred.

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

Every activity and skill label must come from recorded execution data. The current
skills package provides static prompts, so it can initially be shown as configured
guidance; an "active skill" indicator requires a real activation record. Show
public action summaries and observable tool results, not invented agent narration.
Keep private source and sensitive tool output restricted to authorized viewers.

Plan the supporting event data before implementing the interface:

- Correlate tool start, completion, and error events with a call ID, role, stage,
  target, and duration. Record any public action summary explicitly.
- Record guidance/skill identity and version, with activation events when runtime
  skill loading exists. Do not infer skill use from a stage transition alone.
- Bind repository identity, file contents, and successful-edit diffs to the
  checked commit and run. Preserve these artifacts so replay and refresh recover
  the same repository, activity, and evidence after execution ends.

Acceptance: a viewer can identify the repository, current role, current action,
and result at a glance; expand a tool call; inspect the associated file/diff;
see which guidance or skill was actually used; and follow verification through to
the real PR. The same flow must work on a phone and during a saved-run replay.
This experience is part of the Run-view milestone, not a final cosmetic pass.

## QR audience demo: check a repository you already own

**Required demo feature:** an attendee selects an existing project they own and
Vouch checks that project's actual code and dependencies. They leave with an
Actions run and, when a fix verifies, a draft PR against the selected revision.
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
5. **Keep the result.** A verified fix opens a draft PR with the patch, regression
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
  and keep their results outside the frozen benchmark scores.

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

The first existing-repository harness slice is now implemented in the CLI. It
accepts a local Git root, pinned ref, supplied report, and designated regression;
uses the project's lockfile and Vitest installation in Docker; permits source-only
changes; and persists the patch, structured before/after test evidence, run record,
and correlated event log before cleanup. Records bind the run to the commit,
regression, lockfile, pinned image, runner versions, and exact test inventories.
Dependency preparation rejects install scripts and local/custom package sources;
dependency extraction has a size/entry monitor, and tests run offline with bounded
structured output. It does not load a benchmark task
or hidden grader.

This local slice assumes the repository owner trusts the selected commit,
lockfile, Vitest dependency, and test configuration. Those project-controlled
components execute during verification, so the artifact is observable test
evidence rather than a cryptographic attestation against a hostile repository.
The exact supplied test and conventional test files are immutable, while normal
application modules they import remain editable so a repair is possible.

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

During the presentation, show the QR while the presenter checks an existing project.
An opt-in audience activity panel can show joined participants and run outcomes;
private repository names and code stay on the participant's own result page.
Invite one participant to open their actual GitHub PR on their phone. Keep these
live audience outcomes visually separate from the controlled Bench comparison.

Acceptance: two participants each connect a different existing compatible project
with no Vouch-specific task files, complete setup, and run checks on its actual
source without entering model keys. Include a private repository with supported
account permissions. Real Actions links open in the owning accounts; an applicable
verified fix produces a draft PR there, and no confirmed issue produces a report
with no source patch. Refresh preserves progress. Rehearse
queued, blocked, and unsuccessful runs as well as the successful path. The QR
feature is specified here; its app, workflow, proxy, and deployed URL still need
implementation.

## Models

The product configuration uses **GLM 5.3 Flash Uncensored via Routeway for Red** and
an available coding model through the existing Anthropic/OpenAI adapter for Blue.
Pin Blue's exact model ID before evaluation.

Routeway lists `glm-5.3-flash-uncensored`, function calling, and the API base URL
`https://api.routeway.ai/v1`. It describes the model as a community refusal-reduced
variant. Treat fewer refusals as a hypothesis to test; valid reproductions and
correct patches determine security performance. [Routeway model page](https://routeway.ai/models/glm-5.3-flash-uncensored)

The current engine already reads these Red settings:

```dotenv
VOUCH_RED_MODEL=glm-5.3-flash-uncensored
VOUCH_RED_PROVIDER=compatible
VOUCH_RED_BASE_URL=https://api.routeway.ai/v1
VOUCH_RED_API_KEY_ENV=ROUTEWAY_API_KEY
```

Set `ROUTEWAY_API_KEY` locally. The compatible-provider loop and strict model
selection are covered by mock-provider tests; a credentialed Routeway run still
needs validation. Record the actual provider and model for every role; benchmark runs
must fail configuration checks if a requested model is unavailable, rather than
falling back to another provider or a scripted solution.

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
   both vulnerable and fixed references before admitting a case.
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
