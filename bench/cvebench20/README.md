# CVE-Bench source adaptation

```bash
pnpm cli eval --suite cvebench20 --prepare
pnpm cli eval --suite cvebench20
```

This cohort includes all 20 locate tasks from [Giovanni Gatti Pinheiro's CVE-Bench](https://github.com/GiovanniGatti/cve-bench), pinned at commit `45cb1bf72f034eace43e46a9ae131c53a7fd292b`. Each task supplies the complete named Python module from the registered vulnerable revision. The published correction is kept outside both model prompts and agent workspaces. References, original modules, task prompts and task order are frozen by the SHA-256 of `cases.json`.

The modules range from 89 to 4,183 lines. They include authentication providers, parser state machines, redirects, decoding pipelines and resource limits. Selection includes every task in the pinned dataset; it does not depend on the performance of either condition. These are all disclosed repair tasks, so label agreement alone is not a useful detection metric.

Both conditions use `gpt-5.6-sol`, the same source and locate scope, and an eight-minute wall allowance per task. Vouch uses production Red review and independent Blue remediation with source tools and versioned skills. Codex uses the native CLI with the complete source in its prompt and structured replacements, with tools disabled. Two pairs run concurrently. Compute usage differs between conditions.

The displayed score is **named-module AST reference agreement**, using the same passive Python parser as the other Vouch source evaluations. It requires a supported original-source verdict, valid candidate syntax and equality with the registered corrected module's AST. Valid alternative repairs can receive zero reference credit. No percentage from this comparison establishes runtime security or regression correctness.

This is **not a replication of the original CVE-Bench evaluation**. The original benchmark uses a complete repository and runtime security/regression tests; this adaptation supplies only the named module and executes neither candidate nor reference code. Some upstream corrections span additional modules, which are outside this comparison. No upstream setup scripts, security tests or reproduction inputs are downloaded or run by the evaluator.

Every invocation creates a new frozen manifest and retains all 40 planned trials, including errors. Answers, candidates, source hashes, model usage and Vouch traces are available in the Evidence screen. Repeated runs used for skill tuning are development-set results. Preserve the existing cohort and create a new suite version if any task, source, prompt or reference needs to change.

The benchmark metadata is MIT licensed. Downloaded source files retain their respective upstream license notices. Attribution: Giovanni Gatti Pinheiro, *CVE-Bench: Benchmarking LLM Agents on Real-World Security Vulnerability Fixes* (2026), [project and method](https://giovannigatti.github.io/cve-bench/).
