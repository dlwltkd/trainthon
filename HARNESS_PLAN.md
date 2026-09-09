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
| PR | 발표자 fork 또는 참가자가 연결한 자기 저장소에 draft PR. 업스트림은 스트레치 |
| UI | React+Vite+Tailwind+shadcn 단일 앱, 실제 저장소·에이전트 활동을 보여주는 Run 뷰 + Bench 뷰 + QR 모바일 Join |
| 참가자 체험 | QR → GitHub 연결 → 기존에 쓰던 자기 저장소 선택 → 실제 코드 점검 → 결과·draft PR 수령 |

## 아키텍처 — skill/harness/sandbox를 패키지로 분리

```
apps/dashboard   React UI (Run 뷰, Bench 뷰, QR 모바일 Join)
apps/server      Hono: run API + SSE + GitHub 연결/Actions/PR + 체험용 모델 프록시
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

## 모델 프로바이더 & 역할별 모델

- 게이트웨이는 **범용 OpenAI-호환 프로바이더 하나**로 처리한다(baseURL + key). Routeway
  (`https://api.routeway.ai/v1`), Vercel AI Gateway, OpenRouter, z.ai가 전부 같은 방식으로 붙는다.
  네이티브 `anthropic`/`openai`도 유지.
- **역할별 모델**(`ModelSpec`): 조건 C의 Red(공격/익스플로잇 작성)와 Blue(패치)는 서로 다른 모델을
  쓸 수 있다. 안전튜닝된 프런티어 모델은 PoC 작성을 거부(refusal)하는 경우가 있어, Red는 덜 제한적인
  모델(예: Routeway 호스팅 GLM/uncensored 계열)로 라우팅한다. Blue는 프런티어 모델.
- 안전 범위: 익스플로잇은 **sandbox 안의 fixture/발표자 fork/참가자가 연결한 저장소 코드에만** 실행한다. 운영 시스템 대상
  공격이나 무단 스캔은 없다. Red에 덜 제한적인 모델을 쓰는 것은 이 통제된 범위 안에서만 정당하다.
- B vs C 공정성: Red 모델을 바꾸는 것은 조건 C의 구성일 뿐, baseline B에도 동일 정보·도구·예산을
  준다. harness 효과와 "정보/모델 효과"를 섞지 않는다.

## 엔진 상태기계

```
INIT → CONTEXT → REPRODUCE → PATCH → VERIFY → REVIEW → DONE
                     │           ↑        │
                     │           └ fail & 예산 남음 ┘
                     └ 트리거 못 만듦 → DONE(NOT_REPRODUCIBLE, diff=0)
```

종료 status: FIXED_VERIFIED / NOT_REPRODUCIBLE(대조 정답) / FAILED_NO_FIX /
BROKE_FUNCTION / BUDGET_TIMEOUT / CANCELLED / SETUP_ERROR /
INVALID_REPRODUCTION / INFRA_ERROR.

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

- UI는 핵심 데모 기능이다. 앱 안에서 참가자의 실제 저장소·브랜치·커밋과 파일 트리를
  보여주고, 코드·변경 diff 옆에 에이전트의 현재 작업과 단계별 활동 기록을 배치한다.
- 도구 호출은 이름·대상 파일·상태·소요 시간·짧은 결과를 표시하고 상세 인자·출력은
  펼쳐서 확인한다. 실제 적용한 스킬/가이드와 Red→Blue 역할 전환, 하네스 검증도 구분한다.
  현재 정적 프롬프트는 설정된 가이드로 표시하며, 활성 스킬 표시는 실제 활성화 기록이 필요하다.
- 활동 항목을 누르면 해당 파일·diff·테스트 근거를 연다. 모바일은 Activity/Files/Results로
  정리하고, 발표 화면은 같은 실행 기록을 큰 글씨로 보여준다. 실시간과 replay는 같은 데이터를 쓴다.
- 이를 위해 도구 호출 ID·완료/오류·역할·시간, 스킬 메타데이터, 커밋에 연결된 파일/diff를
  기록하는 이벤트 확장이 필요하다. 이 변경은 명세에만 반영하며 UI 구현은 아직 시작하지 않는다.
- 타겟: 실제 npm CVE 2개(작은 패키지 + 테스트 + 단순 CWE + MIT), fork 후 취약 커밋 pin. 벤치 eval과 공유.
- 라이브 = 벤치 V 과제 하나를 hint=L1(위치 안 줌)로 조건 C 실행 → localization 화면 노출.
- 흐름: Red 익스플로잇(빨강) → Blue 패치 → Verify → 내 fork에 draft PR(증거 표).
- 관객 참여(필수): 발표 QR → 모바일 Join → GitHub 연결 → 참가자가 기존에 쓰던 자기
  저장소 선택 → 그 저장소의 실제 코드·의존성을 GitHub Actions에서 점검 → 휴대폰에서
  실행 결과와 검증된 수정 PR 열기. 샘플 저장소 생성은 관객 체험 경로에서 제외한다.
- 첫 지원 범위는 설치 가능한 lockfile과 Vitest 테스트가 있는 Node 기반 JS/TS 저장소.
  의존성 보안 권고·지원하는 정적 점검 또는 사용자가 제공한 리포트에서 시작한다.
  워크플로가 없으면 설치 PR을 기본 브랜치에 병합한 뒤 실행한다. 실제 저장소에 문제가
  확인되지 않으면 점검 범위와 결과만 남긴다. 비공개 저장소의 공개 설정을 바꾸지 않는다.
- 실제 저장소 실행은 벤치 과제 ID·정답·숨은 grader 없이 동작해야 한다. 선택한 커밋을
  checkout하고 프로젝트 자체 의존성과 테스트로 전후 결과를 검증하는 경로를 구현한다.
- 참가자에게 모델 API 키 입력을 요구하지 않도록 서버에서 제한된 체험 크레딧을 제공한다.
  미지원·재현 불가·실행 실패도 그대로 표시하며, 관객 실행은 벤치 점수에 합산하지 않는다.
- 무대 대비: 실제-CVE는 성공 저널 녹화 후 replay, 최소 fixture 과제는 라이브(빠르고 결정론적).
- 실행 범위: 준비된 fork와 참가자가 연결한 저장소의 격리된 테스트 환경. PR은 해당 저장소에만
  만들고 참가자가 검토·병합한다. 운영 서버 배포는 포함하지 않는다.

QR 체험의 상세 흐름·설치 제약·완료 기준은 [HACKATHON_MVP.md](./HACKATHON_MVP.md)에 정리한다.
현재 QR 화면, GitHub 연결, Actions 실행, 모델 프록시는 구현 전이다.

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
| M0 ✅ | 0–1h | 모노레포+protocol+이벤트 로거+CLI. `cli run --task hello --condition B`가 올바른 JSONL run 기록 생성 |
| M1 ✅ | 1–3h | sandbox worktree + 도구 + 모델 루프(B). 기본 에이전트가 취약 fixture 수정, grader가 FIXED_VERIFIED |
| M2 ✅ | 3–5h | harness(C) + Red/Blue + 게이트. C가 V 하나 수정 AND 대조 하나 정답(diff=0). = P0 완료 — `proto-pollution` C→FIXED_VERIFIED, `proto-pollution-fixed` C→NOT_REPRODUCIBLE(diff 0), 스크립트 러너로 검증. 실모델 검증은 키 투입 후 |
| Local harness ✅ | — | 로컬 Git 커밋 + 제공 리포트/회귀 테스트 입력, 소스 전용 수정, 공유 예산/취소, Docker 격리 설치·구조화 Vitest 전후 검증, 상관관계 이벤트와 영구 artifact. 실제 Docker scripted E2E와 테스트 suite로 검증. Routeway 실키 검증은 남음 |
| M3 | 5–7h | SSE + 실제 저장소/파일/diff + 읽기 쉬운 에이전트 활동·도구 호출·스킬/가이드 표시 + 검증 결과 + 모바일/발표 뷰 + replay |
| M4 | 7–9h | bench 러너 + dev 4개 + 지표. `cli bench --set dev` 지표 표 |
| M5 | 9–13h | eval 8(실제 CVE 2 fork 포함) + prereg 커밋 + 48회 + 결과 표·차트 + fork draft PR URL |
| M6 | 13h+ | QR 체험: 참가자 2명이 서로 다른 기존 프로젝트를 연결해 실제 코드 점검·결과 수령. 적용 가능한 수정은 검증된 draft PR, 문제 미확인은 무수정 리포트. 모바일 참여 리허설·영상·발표 |

**하드 컷오버:** 벽시계 8h에 M2(P0) 안 되면 bench·실제CVE·UI 고도화 버리고 P0 하나만 완벽하게.
