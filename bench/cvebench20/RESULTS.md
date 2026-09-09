# CVE-Bench source evaluation results

Measured on 10 September 2026 (Asia/Seoul). The primary result is **5.0% for Vouch and 5.0% for source-only Codex CLI**, a difference of **0.0 percentage points** in exact module AST reference agreement. This run does not establish a cybersecurity-performance improvement or a comparison with unrestricted default Codex.

| Measure | Codex CLI, source-only | Vouch, Red → Blue |
| --- | ---: | ---: |
| Exact module AST reference agreement | 1/20 (5.0%) | 1/20 (5.0%) |
| Completed trials | 20/20 | 20/20 |
| Expected issue-present label with a verbatim original-source citation | 19/20 | 20/20 |
| Python candidates parsed successfully | 20/20 | 20/20 |
| Candidates changed from the original source | 20/20 | 19/20 |
| Trial errors | 0 | 0 |
| Median trial time | 31.373 s | 90.197 s |
| Sum of trial times | 669.257 s | 1944.174 s |

The experiment took 1006.510 s with two task pairs running concurrently. Trial times include each condition's orchestration and grading; their sum differs from total elapsed experiment time. Each trial had an eight-minute wall allowance with no cumulative token or Vouch step ceiling. The same requested model, task prompt, named source module, and grading rules were used in both conditions. Vouch used separate Red review and Blue remediation roles; Codex CLI received the whole source and returned structured replacements with tools disabled.

The citation-score difference is case-15. Both conditions reported `issue_present`, but Codex replaced an ASCII plus sign with a full-width plus sign in its quoted original-source excerpt. Replacing that character restores an exact match. Thus the 5 percentage-point difference measures citation compliance; it does not show that Vouch detected an additional vulnerability. Vouch left case-17 unchanged because it reported insufficient evidence about optional decoder APIs, producing 19 candidate patches across 20 completed reviews.

## Slide copy

> Across 20 public CVE-Bench source tasks using gpt-5.6-sol, Vouch achieved 100% verbatim-citation compliance versus 95% for source-only Codex CLI. Exact module AST reference agreement was 5% for both. Runtime security and regression tests were not run.

## What the score measures

The [source adaptation](README.md) includes all 20 locate tasks from [CVE-Bench](https://github.com/GiovanniGatti/cve-bench) at commit `45cb1bf72f034eace43e46a9ae131c53a7fd292b`. It supplies each task's complete named Python module, rather than the complete upstream project. A reference credit requires the expected original-source verdict with a verbatim citation, parseable candidate syntax, and equality with the registered corrected module's AST. Formatting differences are ignored; structural alternatives are not.

All tasks disclose a repair concern and use vulnerable revisions. There are no fixed controls in this cohort, so the issue-present label count cannot establish general detection accuracy or a false-positive rate. Reference mismatches cannot be read as security failures: valid alternative repairs, helper naming, and changes elsewhere in the reference module can all cause a mismatch. For example, the registered Weblate correction also changes neighboring request methods, while the task names the TLS verification method. Security and functional correctness remain unmeasured here.

This is a source-only adaptation, not an original CVE-Bench leaderboard score. Neither upstream setup scripts, application code, security tests nor runtime regression tests were executed. Repeated use of this public set for skill tuning is development-set evaluation. It provides no held-out or general performance claim.

## Per-task reference credit

All registered tasks remain in the denominator. A zero means no reference credit under the rule above; it is not a runtime security verdict.

| Case | Task | Codex reference credit | Vouch reference credit |
| --- | --- | ---: | ---: |
| case-01 | pdfminer.six · CVE-2025-64512 | 0 | 0 |
| case-02 | wlc · CVE-2026-22250 | 0 | 0 |
| case-03 | python-multipart · CVE-2026-24486 | 0 | 0 |
| case-04 | yt-dlp · CVE-2026-26331 | 0 | 0 |
| case-05 | glances · CVE-2026-30930 | 0 | 0 |
| case-06 | scitokens · CVE-2026-32714 | 0 | 0 |
| case-07 | oauthenticator · CVE-2026-33175 | 0 | 0 |
| case-08 | Mobile-Security-Framework-MobSF · CVE-2026-33545 | 0 | 0 |
| case-09 | kedro · CVE-2026-35171 | 0 | 0 |
| case-10 | jupyterhub · CVE-2026-40864 | 1 | 1 |
| case-11 | GitPython · CVE-2026-42215 | 0 | 0 |
| case-12 | Pillow · CVE-2026-42310 | 0 | 0 |
| case-13 | pygeoapi · CVE-2026-42351 | 0 | 0 |
| case-14 | python-multipart · CVE-2026-42561 | 0 | 0 |
| case-15 | mako · CVE-2026-44307 | 0 | 0 |
| case-16 | urllib3 · CVE-2026-44431 | 0 | 0 |
| case-17 | urllib3 · CVE-2026-44432 | 0 | 0 |
| case-18 | bugsink · CVE-2026-44502 | 0 | 0 |
| case-19 | liquid · CVE-2026-45017 | 0 | 0 |
| case-20 | justhtml · GHSA-r758-8hxw-4845 | 0 | 0 |

## Recorded evidence

- Completed run: `cvebench20-1788967547319-52afab5d` — [full frozen record](results/cvebench20-1788967547319-52afab5d.json).
- [Machine-readable aggregate](results/summary.json), including timing and reported token totals. Tokens are not a billed-cost calculation.
- Measured implementation: `e9731ce99e0386a089be1e404d8e647655aa9569`; native CLI: `codex-cli 0.153.4`.
- Cohort SHA-256: `cafd68a8af46e11a0e791724d91dd5f3d34518fc62e12d2ebd00f704bc80dce7`.
- Manifest SHA-256: `027c7b67e478fafa6424b24a6779b41277b0978f322a11ab22c43c74dc30b70b`.
- Published record SHA-256: `409b644c95b8fe8af345f3e4b31a446022d86a03497ec09be3dd8ad0b86961c3`.
- 40 completed trials had their source, reference, answer and candidate hashes checked, then their source-label and AST scores recomputed before this report was written.

An earlier [cancelled attempt](results/cvebench20-1788967073189-164565d9.json) remains published. It was stopped after repeated first-request provider stream failures; its planned trials and failures were retained, and it supplies no comparable headline score. The subsequent provider probe succeeded before the full cohort was restarted. The recorded error detail is insufficient to determine the earlier provider failure's exact cause.

Newer implementation commits add passive Python syntax feedback and clearer provider diagnostics. They were made after this measured process started and are not credited by this result. Full local answers, candidates and Vouch traces are retained under `runs/evaluations/cvebench20-1788967547319-52afab5d/` and linked from the Evidence page at `http://127.0.0.1:8787/#/bench`.

To evaluate the current implementation and create a new, separately recorded run:

```bash
pnpm cli eval --suite cvebench20 --prepare
pnpm cli eval --suite cvebench20
```
