# Benchmark slide wording

**20 public CVE-Bench source tasks · gpt-5.6-sol · 40 completed trials**

| Measure | Codex CLI, source-only | Vouch |
| --- | ---: | ---: |
| Verbatim-citation compliance | 95% (19/20) | 100% (20/20) |
| Exact module AST reference agreement | 5% (1/20) | 5% (1/20) |
| Median trial time | 31.4 s | 90.2 s |

Across 20 public CVE-Bench source tasks using gpt-5.6-sol, Vouch achieved 100%
verbatim-citation compliance versus 95% for source-only Codex CLI. Exact module
AST reference agreement was 5% for both. Runtime security and regression tests
were not run.

The citation gap came from one changed character in a Codex excerpt. Both
conditions reported all 20 tasks as issue-present. These numbers do not establish
better vulnerability detection or repair success; this is a source adaptation,
not the original benchmark's runtime score.

Source: [results and frozen records](RESULTS.md).
Run: `cvebench20-1788967547319-52afab5d`; implementation: `e9731ce`.
