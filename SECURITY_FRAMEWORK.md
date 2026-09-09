# Vouch security-agent framework

Vouch provides a common structure for defensive security agents: model execution,
skills, controlled tools, public progress, evidence, and a shared interface.
Prompt-based source review, opt-in source remediation, and regression-based
repository repair are implemented. Additional workflows should reuse this structure and define
what their results establish.

This document is the architecture contract for that direction. The code currently
has explicit source-review, repository-repair, and prepared-benchmark entry
points. A general workflow registry and the additional workflows below are not
implemented yet.

## Shared framework

| Component | Responsibility |
| --- | --- |
| Model runtime | Resolve the requested provider/model, execute model and tool turns, track available usage, and enforce shared step, token, and time budgets. |
| Skills | Supply versioned task instructions through actual `use_skill` calls and record why the agent selected them. |
| Tool boundaries | Validate arguments and enforce allowed operations, workspace scope, protected files, cancellation, and execution isolation outside the model. |
| Public trace | Record roles, stages, skill calls, public decision summaries, plans, and correlated tool outcomes in the run history. |
| Artifacts | Preserve inputs, configuration, observed outputs, changes, verification evidence, and final results with their provenance. |
| Server and UI | Stream and replay the same recorded events, connect decisions to evidence, and make unavailable data and incomplete work visible. |

These responsibilities live in `packages/model`, `packages/skills`,
`packages/engine`, `packages/sandbox`, and `packages/protocol`, with
`apps/server` and `apps/dashboard` providing the current local interface.
The engine owns the result gate; an agent's completion claim is evidence to
review, not authority to declare success.

## Workflow contract

Each workflow must define the following before gaining an execution entry point:

| Definition | What it must specify |
| --- | --- |
| Identity and inputs | A versioned workflow identity, accepted inputs, target revision or artifact identity, and validation rules. |
| Roles and skills | Which roles participate, which skills they may load, and any handoff requirements. Red/Blue is the current repair workflow's choice. |
| Tool allowlist | The operations available to each role and stage, including read/write scope and any external access. |
| Stages and budgets | The sequence, decision gates, cancellation behavior, and shared resource limits. |
| Verification | Required observations, preserved evidence, checks for incomplete or invalid execution, and the authority that evaluates the result. |
| Result scope | The meaning and limits of each outcome, plus the artifacts needed for another person to review it. |

A skill describes how to work; it does not grant privileges. Loading a new skill
cannot add a tool, authorize network access, expand write scope, or bypass a
verification gate. Tool implementations enforce those boundaries even when model
output or repository content requests otherwise.

The current repository workflows require `use_skill` and an initial `report_progress`
call before repository tools. Public updates contain a short decision summary,
next action, evidence paths, and up to six plan steps. Evidence paths must refer
to the supplied test or files observed through tools. The trace records these
user-facing statements and observable actions; it neither exposes hidden
reasoning nor invents missing activity. Future workflows must retain this
distinction and validate references against their own input artifacts.

## Current workflow: repository source review

The inputs are a local Git path or public GitHub URL and a review prompt, with an
optional report and ref. The harness pins the commit and prepares a source
snapshot. Red first reviews the source and passes recorded findings to Blue.
Blue independently checks the source before issuing its assessment. Reviewers can load `source-security-review`,
`auth-boundary-review`, `config-dependency-review`, and `remediation-planning`.
They use paginated read/search tools, structured `report_finding` records, and public progress
updates. Each finding identifies observed files, severity, confidence, a summary,
and a defensive recommendation. Confirmed source observations remain distinct
from potential issues and unverified runtime assumptions. It has no source-edit, shell, project-execution, or
network tools. No regression, test suite, dependency installation, or Docker is
required.

`REVIEW_COMPLETE` has scope `source_review` and `independentGrader: false`. It
records a usable source-backed review; it does not establish that the repository
is secure or that unexecuted behavior has been verified. `INCOMPLETE_REVIEW`
distinguishes a run that did not produce such a review. Configuration failures,
timeouts, and cancellation remain separate outcomes. The review, prompt, source
identity, observed evidence, and trace remain available as artifacts.

## Current workflow: proposed source remediation

`--repo` and `--prompt` with `--fix` select `repository_remediation`. The default
without `--fix` stays read-only. `--report` remains optional; no regression or test
execution is required in this mode.

Blue must read source and record its own confirmed finding, then activate
`source-remediation` before using `write_file` or `edit_file`. Red's toolset stays
read-only and its findings never seed Blue's edit permissions. Only application source can
change; tests, configuration, manifests, lockfiles, setup, and hidden files remain
protected. After the final edit it must activate `change-validation` and call
`inspect_diff`. The runtime checks the inspected patch and protected files before
accepting the proposal.

`PATCH_PROPOSED` has scope `source_patch`, `testsRun: false`, and
`independentGrader: false`. It records an inspected candidate patch, not a tested
repair or an independently verified security fix. Findings, source changes,
diff evidence, and unperformed checks remain visible for review. This workflow
has no shell, execution, or network tools and creates no new regression tests.

## Current workflow: repository repair

Supplying an existing Vitest or pytest regression selects repair. A report and
supplemental prompt are optional. An optional evidence reviewer has read-only
tools; the repair agent may edit application source and run the designated tests.
Existing tests, configuration, manifests, lockfiles, and setup files remain
protected. Docker and a supported project's pinned test dependencies are required.

The harness prepares a snapshot, checks the functional baseline and supplied
regression, and only calls repair models when the regression fails with a valid
assertion result. It verifies the candidate in a fresh snapshot and retains the
patch, before/after test evidence, runtime configuration, and event log.

`TESTS_PASSED` has scope `repository_tests` and `independentGrader: false`.
`NOT_REPRODUCIBLE` means the supplied regression already passed; it produces no
repair and is not a claim that the repository is secure. Neither outcome proves
general security performance. Benchmark results belong to their own evaluation
protocol and cannot be inferred from a local run.

The repository workflows accept only anonymous HTTPS GitHub repository URLs for remote
input. Public repository sources are pinned to commits, with snapshots persisted
for later file previews. Local Git paths remain supported. GitHub App/OAuth,
private remote access, and QR joining are not implemented.

## Draft delivery and sandbox scope

The local server can deliver a recorded public-repository patch through
`POST /api/runs/:runId/pull-request`, invoked by the dashboard's explicit
**Create draft PR** action. It accepts `PATCH_PROPOSED` or `TESTS_PASSED` with
source changes and requires server-side `GITHUB_TOKEN` or `GH_TOKEN` with Contents
and Pull requests write permissions and repository push access. It verifies the
recorded base against the current default branch, creates a dedicated branch,
and records the resulting draft PR. Untested source proposals remain labeled
untested in the draft. Fork creation and automatic merging are unsupported.

Regression repair already runs supplied tests inside containers with networking
disabled. Red's repository role reviews source and observed test evidence through
read-only tools. An adapter for isolated application-server startup, health
checks, existing tests, bounded logs, and cleanup is planned separately; no server
lifecycle or automatic attack/new-reproduction workflow is implemented here.

## Planned defensive workflows

| Workflow | Proposed inputs and evidence |
| --- | --- |
| Configuration review | Supplied configuration artifacts and explicit requirements, with assessed settings and recommended changes. |
| Dependency review | Lockfiles or an SBOM and identified advisory sources, with version matches, applicability notes, and remediation recommendations. |
| Incident-artifact review | Owner-supplied logs and incident artifacts, with source-linked timelines, observations, and unresolved questions. |

These are extension targets, not existing commands or capabilities. Each needs
its own adapter, tool allowlist, verification rules, result vocabulary, and tests.
The current UI and protocol still contain repository-specific assumptions;
generalizing them should preserve recorded-run compatibility and make each
workflow's evidence scope explicit.

The GitHub/QR audience integration and benchmark comparison
remain separate planned work described in [HACKATHON_MVP.md](./HACKATHON_MVP.md).
