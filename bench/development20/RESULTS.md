# Initial development run

Run: `dev20-1788965426716-e9547768`, implementation `03e29a4`.
Manifest SHA-256: `da53cfe5620172b4a282a5b0f6e83d5d32f1413b6a17ecc44e9592e912de0bea`.

| Condition | Label agreement | AST reference agreement | Correct controls preserved | Sum of trial times |
| --- | ---: | ---: | ---: | ---: |
| Codex CLI, source-only | 20/20 | 10/12 | 8/8 | 204.199 s |
| Vouch, Red → Blue | 20/20 | 11/12 | 8/8 | 1221.244 s |

All 40 trials completed without errors. With two pairs running concurrently, the experiment elapsed time was 634.592 seconds. The same `gpt-5.6-sol` model was used throughout.

The AST differences do not establish a security advantage. Both conditions used the equivalent quota comparison `cost > remaining` rather than the reference's `remaining < cost`. Codex also returned a call directly instead of retaining an intermediate local variable. These equivalent source forms explain the reference-score gap.

The explicit contracts and small functions made this set too easy to distinguish model capability. It remains a fixed basic development check. The separate [CVE-Bench source cohort](../cvebench20/README.md) adds real modules with larger control flow; its results must be measured independently.

Vouch's latency includes sequential review and validation roles, source evidence recording, source edits and diff inspection. In the first two cases it made 18 and 14 model requests, respectively. A source-only Codex answer does less orchestration work. Token totals include repeated context and should not be interpreted as billed cost.
