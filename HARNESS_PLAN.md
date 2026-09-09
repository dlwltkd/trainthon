# Vouch — 확정 빌드 스펙

**제품명: Vouch** ("Every security fix, proven.") — 내부적으로 이 실행 시스템을 agent harness라 부른다.
차별화 축은 **"증명(익스플로잇)이 붙은 것만 고치고, 증명 못 하면 안 고친다"** 이다.

이 파일이 스펙의 소스 오브 트루스다. 로컬에서 이어받으려면 **아래 핸드오프를 먼저** 읽고, 그 다음 락된 결정을 본다.

---

## 0. 로컬 핸드오프 (지금 여기부터)

클라우드 에이전트가 M0–M4까지 구현해 둔 상태. 데탑에서 할 일은 **실모델 키를 넣고 점수를 내는 것**, 그 다음 M5(eval CVE)다.

| | |
| --- | --- |
| 브랜치 | `cursor/harness-scaffold-39df` (PR [#1](https://github.com/dlwltkd/trainthon/pull/1), base `main`) |
| 완료 | M0 스캐폴드 · M1 조건 B · M2 조건 C 게이트 · M3 SSE+Studio+replay · M4 dev 4과제 bench |
| 미완 | M5 eval 8 + 실 CVE fork + 48회 · M6 데모 영상 · GitHub draft PR · `run_cmd` |
| 검증됨 | 키 없는 **scripted** 러너 + Studio/Bench UI 브라우저 확인. **실모델 점수는 아직 없음** |

### 0.1 가져오기

```bash
git fetch origin cursor/harness-scaffold-39df
git checkout cursor/harness-scaffold-39df
pnpm install          # Node 22+, pnpm 10.33.3 (packageManager 필드)
pnpm typecheck
pnpm test
```

`.env`는 **자동 로드하지 않는다**. CLI/서버는 `process.env`만 본다. 로컬에서:

```bash
cp .env.example .env   # 키 채우기
set -a && source .env && set +a
```

또는 셸/IDE에 직접 export. 키가 없으면 취약 과제는 `bench/tasks/<id>/solution`·`repro`로 스크립트 폴백하고, 대조 과제는 no-op → 파이프라인 스모크일 뿐 **벤치 점수가 아니다**.

### 0.2 한 번 돌려보기 (키 없이 / 키 있게)

```bash
# 키 없이 — 배선 확인. 출력에 [scripted] 가 붙어야 한다
pnpm cli run --task proto-pollution --condition C
pnpm cli run --task proto-pollution-fixed --condition C
pnpm cli bench --set dev

# 키 있게 — 이게 진짜 첫 점수. 역할 assigned 이벤트에 scripted- 가 없어야 한다
pnpm cli run --task proto-pollution --condition C --model claude-sonnet-5
pnpm cli run --task proto-pollution-fixed --condition C
pnpm cli bench --set dev
pnpm cli replay --run <runId>

pnpm dev   # Studio http://localhost:5173  +  API :8787 (Vite는 localhost, 127.0.0.1 이 안 될 수 있음)
```

Studio: 왼쪽 과제 → `run C`. 취약 과제는 `FIXED_VERIFIED`, 이미 고친 대조는 `NOT_REPRODUCIBLE` + 우측 게이트 `not reproduced · no patch`.

### 0.3 환경변수

| 변수 | 역할 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 기본 Blue / 조건 B. 모델 id가 `claude*` 이면 이 키 |
| `OPENAI_API_KEY` | 대안. `--provider openai` 또는 `gpt*` / `o1` 모델 id |
| `ROUTEWAY_API_KEY` | OpenAI-호환 게이트웨이 (기본 `https://api.routeway.ai/v1`) |
| `VOUCH_RED_MODEL` | **이걸 켜야** Red만 다른 모델. 미설정이면 Red도 기본 프로바이더 |
| `VOUCH_RED_PROVIDER` | `compatible` (기본) \| `anthropic` \| `openai` |
| `VOUCH_RED_BASE_URL` | 기본 Routeway. Vercel Gateway면 `https://ai-gateway.vercel.sh/v1` |
| `VOUCH_RED_API_KEY_ENV` | Red 키를 담은 env 이름. 기본 `ROUTEWAY_API_KEY` |
| `PORT` | API 서버. 기본 `8787` |

Red에 uncensored/GLM을 쓰려면 Routeway `GET https://api.routeway.ai/v1/models` 로 **실제 슬러그를 확인한 뒤** `VOUCH_RED_MODEL`에 넣는다. 추측 ID를 코드에 넣지 말 것.

```bash
# 예: Red만 게이트웨이, Blue는 Anthropic
export ANTHROPIC_API_KEY=...
export ROUTEWAY_API_KEY=...
export VOUCH_RED_MODEL='<routeway-model-id>'
export VOUCH_RED_PROVIDER=compatible
```

### 0.4 데탑에서 바로 할 일 (순서)

1. 키 넣고 `proto-pollution` C를 **실모델**로. `runs/*.jsonl`의 `role_assigned`가 `scripted-*`가 아닌지 확인.
2. 같은 모델로 `proto-pollution-fixed` C. 기대: `NOT_REPRODUCIBLE`, `diffLines=0`, 게이트 `reproduced=false`. Red가 PoC 작성을 거부하면 `VOUCH_RED_MODEL`을 켠다 — 그 거부가 Red 분리의 근거가 된다.
3. 같은 두 과제를 조건 **B**로. 대조에서 B가 파일을 고치면(과잉수정) C와의 차이가 숫자로 나온다.
4. `pnpm cli bench --set dev` — 표의 `note:`가 “live model”이어야 한다. scripted면 키가 안 들어간 것.
5. 그 다음 M5 (아래 마일스톤).

### 0.5 레이아웃 (as-built)

```
apps/cli          vouch run | replay | bench
apps/server       Hono :8787  POST /api/runs  GET /api/runs/:id/events (SSE)  POST /api/bench
apps/dashboard    Vite :5173  Studio + Bench (Tailwind, shadcn 없음)
packages/protocol  Task, Event, RunRecord, BenchReport
packages/skills    B / Red / Blue 프롬프트
packages/engine    상태기계, 게이트, JSONL, bench 집계
packages/sandbox   worktree, git diff, vitest
packages/model     AI SDK: anthropic, openai, openai-compatible + ScriptedRunner
packages/grader    숨은 exploit + functional + guardedPaths
bench/tasks/<id>/  task.json, repo/, solution/, repro/vouch.repro.test.ts
bench/graders/<id>/ grader.json + exploit.test.ts
runs/<runId>.jsonl              gitignore
runs/bench-latest.json          gitignore
.worktrees/<runId>/             gitignore
```

도구 as-built: `read_file` `list_dir` `grep` `write_file` `run_tests`. C 전용 `submit_repro` `run_repro`. 스펙의 `apply_patch` / `run_cmd`는 아직 없다.

### 0.6 락된 결정 vs 구현 차이

| 스펙 | as-built |
| --- | --- |
| UI = shadcn | 커스텀 Tailwind. Studio/Bench 동작함 |
| GitHub draft PR | 없음. M5/스트레치 |
| 도구에 `run_cmd` | 없음. 의도적으로 좁힘 |
| 과제 `hello` | 삭제. 최소 과제는 `proto-pollution` |
| 조건 A | 타입만 있음. 쓰지 않음 |
| `.env` 자동 로드 | 없음. `source .env` 필요 |
| bench 병렬 4 | 순차 실행 |

### 0.7 알려진 함정

- **scripted ≠ 점수.** 키가 없으면 취약은 `solution/`을 그대로 쓰고 대조는 no-op이라 B·C 지표가 둘 다 좋아 보인다 (`verified 2/2, over-fix 0/2`). UI에 노란 배너가 뜬다. 실모델에서 over-fix가 갈라져야 한다.
- 워크트리는 생성 시 `.gitignore`에 `node_modules/` `.vite/` 를 넣는다. 안 넣으면 vitest 캐시가 diff 1줄로 대조를 `FAILED_NO_FIX`로 만든다.
- 숨은 grader 오라클(`bench/graders/`)과 Red PoC(`repro/`)는 다른 파일이다. 에이전트는 grader를 못 본다.
- `repro/` 와 `solution/` 은 키 없는 스모크용이다. 실모델 채점에 쓰지 않는다.
- 대시보드 `fetch('/api/...')` 는 Vite 프록시로 8787에 붙는다. API만 띄우면 Studio가 빈 과제로 나온다 → `pnpm dev`.

### 0.8 명령 치트시트

```bash
pnpm cli run --task <id> --condition B|C [--seed N] [--model M] [--provider anthropic|openai]
pnpm cli replay --run <runId>
pnpm cli bench --set dev [--repeats 1] [--conditions B,C] [--model M]
pnpm dev
pnpm typecheck && pnpm test
```

dev 과제 id: `proto-pollution` `path-traversal` `proto-pollution-fixed` `path-join-na`.

---

## 한 줄 claim (숫자가 증명할 것)

같은 모델을, 같은 정보·도구·예산으로 돌렸을 때, HARNESS는 검증된 수정률을 유지·향상하면서
**불필요·유해한 수정을 크게 줄인다**. 헤드라인은 2D 산점도(세로 검증수정률↑, 가로 과잉수정률↓)에서
C(HARNESS)가 B(기본 에이전트)를 좌상단으로 지배하는 그림.

## 락된 결정

| 항목 | 값 |
| --- | --- |
| 언어/러너 | TypeScript/Node 단일, vitest 단일 |
| 모델 | Claude Sonnet, B·C **Blue/solo 동일**. Red만 게이트웨이 모델 허용 (검열 회피). Vercel AI SDK |
| 반복 | 조건별 3회 (eval). dev는 `--repeats 1` 로 튜닝 |
| 과제 총량 | 12 = dev 4 + eval 8 (eval V 5 + C 3, V 중 실제 CVE 2) |
| Sandbox | 로컬 git worktree + 자식 프로세스 vitest, 시간/자원 상한. Modal은 P3 |
| 저장 | JSONL append-only 이벤트 로그 + `runs/`. DB 없음 |
| 실시간 | Hono SSE |
| PR | 내 fork에 draft PR. 업스트림은 스트레치. **아직 미구현** |
| UI | React+Vite+Tailwind 단일 앱, Studio(Run) + Bench |

## 아키텍처 — skill/harness/sandbox를 패키지로 분리

세 층이 세 패키지 → 벤치마크 조건이 패키지 토글이 됨. 경로 목록은 §0.5.

## 모델 프로바이더 & 역할별 모델

- 게이트웨이는 **범용 OpenAI-호환 프로바이더 하나**로 처리한다(baseURL + key). Routeway
  (`https://api.routeway.ai/v1`), Vercel AI Gateway, OpenRouter, z.ai가 전부 같은 방식으로 붙는다.
  네이티브 `anthropic`/`openai`도 유지.
- **역할별 모델**(`ModelSpec`): 조건 C의 Red(공격/익스플로잇 작성)와 Blue(패치)는 서로 다른 모델을
  쓸 수 있다. 안전튜닝된 프런티어 모델은 PoC 작성을 거부(refusal)하는 경우가 있어, Red는 덜 제한적인
  모델(예: Routeway 호스팅 GLM/uncensored 계열)로 라우팅한다. Blue는 프런티어 모델.
- 안전 범위: 익스플로잇은 **sandbox 안의 fixture/우리 fork 코드에만** 실행한다. 운영 시스템 대상
  공격이나 무단 스캔은 없다. Red에 덜 제한적인 모델을 쓰는 것은 이 통제된 범위 안에서만 정당하다.
- B vs C 공정성: Red 모델을 바꾸는 것은 조건 C의 구성일 뿐, baseline B에도 동일 정보·도구·예산을
  준다. harness 효과와 "정보/모델 효과"를 섞지 않는다. 헤드라인 표에는 Red 모델을 각주로 표기.

## 엔진 상태기계

```
INIT → CONTEXT → REPRODUCE → PATCH → VERIFY → REVIEW → DONE
                     │           ↑        │
                     │           └ fail & 예산 남음 ┘   (예산 재시도는 스펙. as-built는 1패스)
                     └ 트리거 못 만듦 → DONE(NOT_REPRODUCIBLE, diff=0)
```

종료 status: FIXED_VERIFIED / NOT_REPRODUCIBLE(대조 정답) / FAILED_NO_FIX /
BROKE_FUNCTION / BUDGET_TIMEOUT / INFRA_ERROR.

**완료 게이트(C):** FIXED_VERIFIED는 Red 익스플로잇이 이제 실패(취약점 죽음) AND 기능 테스트 통과일 때만.
Red가 예산 내 트리거 못 만들면 → 워크트리 revert → NOT_REPRODUCIBLE, 변경 0줄. 대조 과제도 같은 게이트.

JSONL 1급 증거: `role_assigned` (어느 러너가 어느 역할), `gate` (`reproduce` | `verify`).

## 조건 B vs C

| | B. 기본 | C. HARNESS |
| --- | --- | --- |
| skills | off (범용 엔지니어 프롬프트) | on (Red 재현 / Blue 패치) |
| 상태기계 | 없음, 단일 루프 | Red→Blue + 상태 |
| 완료 판정 | 모델 "done" 선언 | 게이트(익스플로잇 죽음 ∧ 테스트 통과) |
| 예산·도구·리포트 | 동일 | 동일 |
| 채점 | 외부·숨김·동일 | 외부·숨김·동일 |

유일한 차이는 오케스트레이션. 능력 차이 없음. (Red 모델 예외는 §모델.)

## 지표 (분모 V/C 분리)

as-built `summarizeBench` (`packages/engine/src/bench.ts`):

- **검증된 수정률** = `FIXED_VERIFIED` / \|V\|  (vuln 과제)
- **과잉수정률** = status ≠ `NOT_REPRODUCIBLE` / \|C\|  (control_fixed + control_na). 정답은 변경 0줄
- broke / infra 는 별도 카운트. 실패 실행을 조용히 제외하지 않는다

스펙에 있던 기능파괴율·허위완료율은 아직 표에 안 뽑는다. 필요하면 `BenchCell`에 추가.

## 벤치마크 프로토콜

- 실행 매트릭스: eval 8 × {B,C} × 3 = 48회. as-built는 순차, 실행당 8분 상한은 예산 필드만 있음.
- dev/eval 분리: **dev 4로만 튜닝**, eval 8은 마지막 1회. eval 전 `bench/preregistration.md` 커밋.
- 오염 방지: 채점기 exploit은 숨김, Red PoC와 분리. 에이전트는 수정 커밋/숨은 테스트 못 봄.
- 인프라 오류 재실행 규칙 B·C 동일. as-built는 자동 재실행 없음.

## 데모

- 타겟: 실제 npm CVE 2개(작은 패키지 + 테스트 + 단순 CWE + MIT), fork 후 취약 커밋 pin. 벤치 eval과 공유.
- 라이브 = 벤치 V 과제 하나를 hint=L1(위치 안 줌)로 조건 C 실행 → Studio에서 localization.
- 흐름: Red 익스플로잇(빨강) → Blue 패치 → Verify → (미구현) fork draft PR.
- 무대 대비: 실제-CVE는 성공 저널 녹화 후 replay, fixture 과제는 라이브(빠르고 결정론적).
- 윤리: fork 코드만 sandbox에서, PR도 fork에만, 운영 시스템·무단 리포트 없음.

## 타겟 코드 (전용 데모 앱 없음)

harness는 임의의 코드에 동작한다. 별도 심사 앱을 만들지 않는다. 각 과제는 `bench/tasks/<id>/repo/`에
타겟 코드 사본을 두고, sandbox가 그 사본을 워크트리로 복제해 테스트를 돌린다. 서버 기동 불필요 —
함수/모듈 수준 단위 테스트로 검증 가능한 CWE.

**dev 4 (있음, 전부 `split: "dev"`):**

| id | kind | 내용 |
| --- | --- | --- |
| `proto-pollution` | vuln | `deepMerge` CWE-1321. 숨은 오라클은 `__proto__` + `constructor.prototype` |
| `path-traversal` | vuln | `safeJoin` CWE-22. 오라클은 `..` 세그먼트 + 세그먼트 내부 `..` |
| `proto-pollution-fixed` | control_fixed | 이미 패치된 merge + **같은** pollution 리포트. 정답 = 0줄 |
| `path-join-na` | control_na | 이미 안전한 join + **SQL injection 오탐** 리포트. 정답 = 0줄 |

과제 추가 방법: `bench/tasks/<id>/{task.json,repo/,solution?,repro/}` + `bench/graders/<id>/{grader.json,exploit.test.ts}`. `kind`가 control이면 `guardedPaths`에 구현 파일을 넣는다.

## 마일스톤 (완료 = 수용 기준)

| M | 시간 | 완료 기준 |
| --- | --- | --- |
| M0 ✅ | 0–1h | 모노레포+protocol+이벤트 로거+CLI |
| M1 ✅ | 1–3h | sandbox + 조건 B. `proto-pollution` B→FIXED_VERIFIED (scripted 검증) |
| M2 ✅ | 3–5h | 조건 C. vuln FIXED_VERIFIED AND 대조 NOT_REPRODUCIBLE(diff 0). P0 |
| M3 ✅ | 5–7h | SSE + Studio + `vouch replay` |
| M4 ✅ | 7–9h | `cli bench --set dev` + 지표 표 + Bench 뷰 |
| M5 | 다음 | eval 8(실제 CVE 2 fork 포함) + `bench/preregistration.md` 커밋 + 실모델 48회 + 결과 표. draft PR은 있으면 가산 |
| M6 | 그 다음 | 실제-CVE 성공 저널 녹화, fixture 라이브 리허설, 영상, 발표 |

**하드 컷오버:** P0(M2)는 이미 통과. 남은 리스크는 실모델 거부/품질과 eval CVE 선정이다. 시간 없으면 eval 8 전부 대신 **실모델 dev 4 × {B,C} × 3** 만으로도 2D 그림을 그릴 수 있다.

### M5를 로컬에서 쪼개면

1. 실모델로 dev 4 점수 고정 (핸드오프 §0.4). 이게 안 되면 CVE는 의미 없다.
2. 작은 MIT npm 패키지 2개, 단순 CWE, 테스트 있는 취약 커밋 pin, **우리 fork만**. `source: real_cve`, `split: eval`.
3. eval vuln 3 + control 3을 더해 8을 채운다. 새 과제는 합성으로 채워도 된다.
4. `bench/preregistration.md`에 과제 id·커밋·조건·반복·모델·날짜를 적고 **eval 돌리기 전에 커밋**.
5. `pnpm cli bench --set eval --repeats 3` (오래 걸림). `runs/bench-latest.json` + Studio Bench.
6. (가산) 성공한 실-CVE 런의 diff로 fork에 draft PR. `apps/server`에 GitHub 호출을 붙이면 된다. gh 토큰 필요.
