# Vouch — 확정 빌드 스펙

**제품명: Vouch** ("Every security fix, proven.") — 내부적으로 이 실행 시스템을 agent harness라 부른다.
차별화 축은 **"증명(익스플로잇)이 붙은 것만 고치고, 증명 못 하면 안 고친다"** 이다.

## 한 줄 claim (숫자가 증명할 것)

같은 모델을, 같은 정보·도구·예산으로 돌렸을 때, HARNESS는 검증된 수정률을 유지·향상하면서
**불필요·유해한 수정을 크게 줄인다**. 헤드라인은 2D 산점도(세로 검증수정률↑, 가로 과잉수정률↓)에서
C(HARNESS)가 B(기본 에이전트)를 좌상단으로 지배하는 그림.

## 락된 결정

| 항목 | 값 |
| --- | --- |
| 언어/러너 | TypeScript/Node 단일, vitest 단일 |
| 모델 | Claude Sonnet, B·C 동일. Vercel AI SDK |
| 반복 | 조건별 3회 |
| 과제 총량 | 12 = dev 4 + eval 8 (eval V 5 + C 3, V 중 실제 CVE 2 + 통제앱 3) |
| Sandbox | 로컬 git worktree + 자식 프로세스 vitest, 시간/자원 상한. Modal은 P3 |
| 저장 | JSONL append-only 이벤트 로그 + runs/. DB 없음 |
| 실시간 | Hono SSE |
| PR | 내 fork에 draft PR. 업스트림은 스트레치 |
| UI | React+Vite+Tailwind+shadcn 단일 앱, Run 뷰 + Bench 뷰 |

## 아키텍처 — skill/harness/sandbox를 패키지로 분리

```
apps/dashboard   React UI (Run 뷰, Bench 뷰)
apps/server      Hono: run API + SSE + GitHub PR
apps/cli         run / bench / replay
packages/protocol  공유 타입 (Task, Event, RunRecord, Metrics)
packages/skills    [SKILL] 프롬프트, 도구 설명, 보안 체크리스트 (조건별 on/off)
packages/engine    [HARNESS] 상태기계, Red/Blue, 예산, 완료 게이트, 이벤트 로거
packages/sandbox   [SANDBOX] worktree, vitest 실행, exec, 자원 상한
packages/model     Vercel AI SDK 래퍼
packages/grader    외부 채점기(오라클) 실행기
bench/tasks/<id>/    task.json + 공개 테스트 (에이전트가 봄)
bench/graders/<id>/  grader.json (숨김)
bench/preregistration.md
runs/<run_id>.jsonl
```

세 층이 세 패키지 → 벤치마크 조건이 패키지 토글이 됨.

## 엔진 상태기계

```
INIT → CONTEXT → REPRODUCE → PATCH → VERIFY → REVIEW → DONE
                     │           ↑        │
                     │           └ fail & 예산 남음 ┘
                     └ 트리거 못 만듦 → DONE(NOT_REPRODUCIBLE, diff=0)
```

종료 status: FIXED_VERIFIED / NOT_REPRODUCIBLE(대조 정답) / FAILED_NO_FIX /
BROKE_FUNCTION / BUDGET_TIMEOUT / INFRA_ERROR.

**완료 게이트(C):** FIXED_VERIFIED는 Red 익스플로잇이 이제 실패(취약점 죽음) AND 기능 테스트 통과일 때만.
Red가 예산 내 트리거 못 만들면 → NOT_REPRODUCIBLE, 변경 0줄. 대조 과제도 같은 게이트로 자동 처리.

도구(B·C 동일): read_file, list_dir, grep, write_file/apply_patch, run_tests(vitest), run_cmd.

## 조건 B vs C

| | B. 기본 | C. HARNESS |
| --- | --- | --- |
| skills | off (범용) | on (보안) |
| 상태기계 | 없음, 단일 루프 | Red→Blue + 상태 |
| 완료 판정 | 모델 "done" 선언 | 게이트(익스플로잇 죽음 ∧ 테스트 통과) |
| 예산·도구·모델·리포트 | 동일 | 동일 |
| 채점 | 외부·숨김·동일 | 외부·숨김·동일 |

유일한 차이는 오케스트레이션. 능력 차이 없음.

## 지표 (분모 V/C 분리)

- 검증된 수정률 = (익스플로잇 죽음 ∧ 기능 통과) / (|V| × 반복)
- 기능 파괴율 = 익스플로잇 고쳤으나 기능 회귀 / (|V| × 반복)
- 과잉수정률 = 보호 파일 diff 있음 ∨ 기능 회귀 / (|C| × 반복)
- 허위완료율 = "고쳤다" 선언했으나 채점기 불통과 / 전체
- + 완료 시간(구간별), 비용(모델/실행 분리), 실패 유형

## 벤치마크 프로토콜

- 실행 매트릭스: eval 8 × {B,C} × 3 = 48회. sandbox 4개 병렬, 실행당 8분 상한.
- dev/eval 분리: dev 4로만 튜닝, eval 8은 마지막 1회. eval 전 preregistration.md 커밋.
- 오염 방지: 채점기 exploit()는 숨김, Red 익스플로잇(게이트용)과 분리. 에이전트는 수정 커밋/숨은 테스트 못 봄.
- 실패 실행 조용히 제외 금지. 인프라 오류 재실행 규칙 B·C 동일.

## 데모

- 타겟: 실제 npm CVE 2개(작은 패키지 + 테스트 + 단순 CWE + MIT), fork 후 취약 커밋 pin. 벤치 eval과 공유.
- 라이브 = 벤치 V 과제 하나를 hint=L1(위치 안 줌)로 조건 C 실행 → localization 화면 노출.
- 흐름: Red 익스플로잇(빨강) → Blue 패치 → Verify → 내 fork에 draft PR(증거 표).
- 무대 대비: 실제-CVE는 성공 저널 녹화 후 replay, 최소 fixture 과제는 라이브(빠르고 결정론적).
- 윤리: fork 코드만 sandbox에서, PR도 fork에만, 운영 시스템·무단 리포트 없음.

## 타겟 코드 (전용 데모 앱 없음)

harness는 임의의 코드에 동작한다. 별도 심사 앱을 만들지 않는다. 각 과제는 `bench/tasks/<id>/repo/`에
타겟 코드 사본을 두고, sandbox가 그 사본을 워크트리로 복제해 테스트를 돌린다. 서버 기동 불필요 —
함수/모듈 수준 단위 테스트로 검증 가능한 CWE를 택한다(prototype pollution, path traversal, ReDoS,
injection 등).

- dev 과제: 최소 합성 fixture(함수 + 테스트). 엔진 루프 브링업·튜닝용.
- eval 과제: 실제 npm CVE(작은 패키지 + 테스트 + 단순 CWE + MIT)를 취약 커밋으로 pin.
- 대조 과제: 이미 수정된 버전 + 오탐 리포트(C1), 적용 안 되는 리포트(C2). 정답 = 변경 0줄.
- 증명은 데모 연출이 아니라 벤치마크 숫자로 한다.

## 마일스톤 (완료 = 수용 기준)

| M | 시간 | 완료 기준 |
| --- | --- | --- |
| M0 | 0–1h | 모노레포+protocol+이벤트 로거+CLI. `cli run --task hello --condition B`가 올바른 JSONL run 기록 생성 |
| M1 | 1–3h | sandbox worktree + 도구 + 모델 루프(B). 기본 에이전트가 취약 fixture 수정, grader가 FIXED_VERIFIED |
| M2 | 3–5h | harness(C) + Red/Blue + 게이트. C가 V 하나 수정 AND 대조 하나 정답(diff=0). = P0 완료 |
| M3 | 5–7h | SSE + Run 뷰 + replay |
| M4 | 7–9h | bench 러너 + dev 4개 + 지표. `cli bench --set dev` 지표 표 |
| M5 | 9–13h | eval 8(실제 CVE 2 fork 포함) + prereg 커밋 + 48회 + 결과 표·차트 + fork draft PR URL |
| M6 | 13h+ | 실제-CVE 성공 저널 녹화, 통제앱 라이브 리허설, 영상, 발표 |

**하드 컷오버:** 벽시계 8h에 M2(P0) 안 되면 bench·실제CVE·UI 고도화 버리고 P0 하나만 완벽하게.
