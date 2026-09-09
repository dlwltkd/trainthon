# Vouch security-agent framework

Vouch provides a common structure for defensive security agents: model execution,
skills, controlled tools, public progress, evidence, and a shared interface. Local
repository repair is the first implemented workflow. Additional workflows should
reuse this structure and define what their results establish.

This document is the architecture contract for that direction. The code currently
has explicit local-repository and prepared-benchmark entry points, with repair
roles and stages. A general workflow registry and the additional workflows below
are not implemented yet.

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

The current local workflow requires `use_skill` and an initial `report_progress`
call before repository tools. Public updates contain a short decision summary,
next action, evidence paths, and up to six plan steps. Evidence paths must refer
to the supplied test or files observed through tools. The trace records these
user-facing statements and observable actions; it neither exposes hidden
reasoning nor invents missing activity. Future workflows must retain this
distinction and validate references against their own input artifacts.

## Current workflow: local repository repair

The inputs are a local Git revision, supplied security report, and existing
Vitest or pytest regression. An optional reviewer has read-only tools; the repair
agent may edit application source and run the designated tests. Existing tests,
configuration, manifests, lockfiles, and setup files remain protected.

The harness prepares a snapshot, checks the functional baseline and supplied
regression, and only calls repair models when the regression fails with a valid
assertion result. It verifies the candidate in a fresh snapshot and retains the
patch, before/after test evidence, runtime configuration, and event log.

`TESTS_PASSED` has scope `repository_tests` and `independentGrader: false`.
`NOT_REPRODUCIBLE` means the supplied regression already passed; it produces no
repair and is not a claim that the repository is secure. Neither outcome proves
general security performance. Benchmark results belong to their own evaluation
protocol and cannot be inferred from a local run.

## Planned defensive workflows

| Workflow | Proposed inputs and evidence |
| --- | --- |
| Code review | A pinned source revision and review question, with findings linked to observed source and the limits of the review. |
| Configuration review | Supplied configuration artifacts and explicit requirements, with assessed settings and recommended changes. |
| Dependency review | Lockfiles or an SBOM and identified advisory sources, with version matches, applicability notes, and remediation recommendations. |
| Incident-artifact review | Owner-supplied logs and incident artifacts, with source-linked timelines, observations, and unresolved questions. |

These are extension targets, not existing commands or capabilities. Each needs
its own adapter, tool allowlist, verification rules, result vocabulary, and tests.
The current UI and protocol still contain repository and repair assumptions;
generalizing them should preserve recorded-run compatibility and make each
workflow's evidence scope explicit.

The GitHub/QR audience integration, draft PR delivery, and benchmark comparison
remain separate planned work described in [HACKATHON_MVP.md](./HACKATHON_MVP.md).
