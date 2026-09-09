# CVEfixes source pilot

```bash
pnpm cli eval --suite cvefixes --prepare  # download and verify four source snapshots
pnpm cli eval --suite cvefixes            # run the registered paired experiment
```

Requires `OPENAI_API_KEY`, the native `codex` CLI, Git, and Python 3. Both conditions use `gpt-5.6-sol`. Commit implementation changes before running: the manifest records the code commit, Codex version, source hashes, prompts, conditions, and grading policy before the first model call. Every invocation gets a new artifact directory under `runs/evaluations/`; unsuccessful experiments remain available.

The cohort comes from [CVEfixes' official examples](https://github.com/secureIT-project/CVEfixes/blob/9283b50b3f04e3c5b0a17fc419ab0feea23fc438/Examples/custom.json). It contains two Python cases (CWE-93 and CWE-755), each paired with its published correction as a scoped negative control. Sources are downloaded from pinned upstream commits and checked against SHA-256 hashes. This convenience sample is from one project. It is **not the full CVEfixes dataset or an official CVEfixes benchmark**.

Codex runs in a disclosed source-only configuration: the full file is supplied in the prompt; shell, web, apps, host skills, and other tools are disabled; its structured replacements are applied by the evaluator. Vouch uses its production Red review and Blue validation/repair workflow with file tools and skills. Red observes the baseline; Blue edits a separate source workspace. These are capability boundaries, not separate operating-system containers. Neither condition executes the downloaded code.

The task prompt, model identifier, source, and eight-minute total wall-time allowance are shared. Cumulative tokens are not capped. Vouch v2 has no cumulative step ceiling; Codex uses its native response lifecycle. Input presentation, model-call counts, and reasoning defaults differ, so this pilot does not establish a comparison against unrestricted default Codex at equal compute.

The first completed v1 experiment recorded 3/4 label agreement for Codex and 2/4 for Vouch, including a Vouch repair that stopped at its shared 40-step ceiling. V2 removes that cutoff from production prompt workflows and the pilot while preserving all original cases, prompts, grading, and earlier records. It is explicitly a development-set re-evaluation after inspecting v1, not a held-out benchmark. Neither version establishes a claimed 14% advantage.

The deterministic grader records:

- **Label agreement:** the final source verdict agrees with the before/fixed label and includes a verbatim citation from the original source. The correctness of the explanation still needs human review.
- **Reference agreement:** the candidate's Python AST equals the published corrected file's AST. Formatting is ignored. Valid alternative repairs can fail this conservative check; matching is not runtime verification.
- **Control preservation:** a fixed control is correctly classified and left unchanged.
- **Coverage and failures:** every planned case stays in the denominator. Errors, uncertain verdicts, and invalid evidence receive no credit. A comparison delta is withheld while trials are pending.

The UI computes percentage-point differences from the recorded verdicts. Relative change is reported separately and is undefined when baseline accuracy is zero. There is no configured target uplift, best-of selection, or automatic omission of failed trials. Four correlated snapshots cannot establish a general performance advantage or statistical significance, and public historical code may already be in model training data.

No attack inputs, vulnerability reproduction, application execution, or runtime regression tests are part of this source pilot. Use a separately reviewed functional test suite before claiming a proposed correction is verified for deployment.

The CVEfixes collector is MIT licensed. Downloaded Bottle files retain their upstream license notices. Dataset reference: Bhandari, Naseer, and Moonen, [CVEfixes: Automated Collection of Vulnerabilities and Their Fixes from Open-Source Software](https://doi.org/10.1145/3475960.3475985), PROMISE 2021.
