# Vouch 실제 실행 화면

2026-09-10에 로컬 Vouch 대시보드에서 캡처한 JPG 3장입니다. 모두 1920×1080, 16:9이며, 완료된 실제 실행 기록을 보여줍니다. 브라우저가 반환한 원본 이미지입니다.

| 이미지 | PPT 제목 | 설명 |
| --- | --- | --- |
| `01-red-blue-source-review.jpg` | Red가 발견하고, Blue가 독립적으로 확인 | JupyterHub 소스에서 기록한 발견 사항, 근거 파일, Blue의 확인, 사용한 스킬을 보여줍니다. |
| `02-source-patch-and-tools.jpg` | 발견에서 코드 수정까지, 도구 호출로 추적 | 실제 생성된 수정 diff와 `edit_file`, `read_file`, `change-validation` 호출 기록입니다. |
| `03-local-regression-before-after.jpg` | 수정 전 실패 → 수정 후 통과 | 별도 로컬 산술 예제에서 회귀 테스트와 기존 기능 테스트의 전후 결과를 보여줍니다. |

## 1–2번: JupyterHub 소스 검토와 수정 제안

- 실행: `input__review__1788967920242__c313e1d4`
- 화면: <http://127.0.0.1:8787/#/runs/input__review__1788967920242__c313e1d4>
- 파일: `jupyterhub/_xsrf_utils.py`
- 당시 모델: Red와 Blue 모두 `gpt-5.6-sol`.
- 기록: 238 events, 13 tool calls, 수정량 +2 / −2.
- 결과: **Patch proposed · untested**. 소스 근거로 확인하고 수정 후보를 만들었으며, 이 실행에서는 런타임 테스트를 수행하지 않았습니다.

발표 문장: “Red가 소스 근거로 문제를 기록하면 Blue가 독립적으로 확인하고, 최소 수정과 도구 호출 기록을 함께 남깁니다.”

## 3번: 로컬 회귀 테스트 흐름

- 실행: `vouch-agent-trace-demo-devvgi2s__local__seed1__1788943518432__0a2b35bc`
- 화면: <http://127.0.0.1:8787/#/runs/vouch-agent-trace-demo-devvgi2s__local__seed1__1788943518432__0a2b35bc>
- 대상: `add()`의 산술 오류를 수정하는 작은 통합 예제.
- 당시 모델: Red `glm-5.3-flash-uncensored`, Blue `gpt-5.6-sol`.
- 결과: 수정 전 회귀 테스트 1개 실패 → 수정 후 1개 통과. 기능 테스트도 전후 각각 1개 통과.
- 이 화면은 별도 로컬 예제의 동작 증거입니다. JupyterHub의 테스트 결과나 외부 보안 벤치마크 성적으로 설명하지 않습니다.

발표 문장: “이 로컬 예제는 수정 전 실패와 수정 후 통과를 같은 화면에서 비교하고, 새 작업 공간에서 다시 검증한 기록을 보여줍니다.”
