# Fixed 20-task development set

```bash
pnpm cli eval --suite development20 --prepare
pnpm cli eval --suite development20
```

This set contains 20 distinct synthetic Python source contracts: 12 require a correction and 8 are correct controls. It covers authorization, session lifetime, one-time approvals, permission errors, field allowlists, audit data, error responses, cookie attributes, origin policy, request size, quota reservation, and cleanup. These are source review exercises, not deployed applications or historical CVEs.

`cases.json` is frozen by SHA-256 in the evaluator. Every invocation runs all 20 tasks in both conditions with `gpt-5.6-sol`, the same task prompts and original sources, and eight minutes per condition per task. Two pairs run concurrently. There is no cumulative token or step ceiling. Corrected references and labels remain outside both agents' workspaces and prompts. Neither candidate nor reference source is executed.

The Codex condition uses the native CLI with source in its prompt, structured replacements, and tools disabled. Vouch uses its production source-only Red review and independent Blue repair workflow. Their compute usage and interfaces differ; this is not a comparison with unrestricted default Codex at equal compute.

Both conditions use the same `python-ast-reference-v1` grader as the separate CVEfixes pilot. Label agreement requires a verbatim original-source citation. Reference agreement compares the entire candidate AST to the registered correction and can reject valid alternatives. Correct controls must remain byte-for-byte unchanged. Runtime regression correctness is not measured.

Each execution freezes its manifest, code commit and hashes before the first model call, records all 40 planned trials, and retains errors and uncertain answers in the denominator. The Evidence screen shows answers, candidate sources, elapsed time, tokens and Vouch traces. Earlier runs remain accessible.

This set is explicitly available for harness and skill tuning. Compare successive runs using the same cohort hash and case list. Scores on these problems are **development-set tuning results**, not held-out performance or an external CVEfixes benchmark. A changed problem, prompt or reference requires a new suite version. No case-specific answers belong in production skills.
