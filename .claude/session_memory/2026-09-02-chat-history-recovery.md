# 2026-09-02 — 채팅 이력 복구 및 메뉴 정리

## 수행

### 원인 추적

증상 — 이전 세션 클릭 시 대화 목록 미표시. 에러 없음, 서버 로그 없음.

| 확인 | 결과 |
|---|---|
| `engined` 저장 로그 | `chat turn stored (session=..., messages=2)` — 저장 정상 |
| DB 직접 조회 | `chat_session` 3건, `chat_message` 각 2~4건 — 데이터 존재 |
| 상세 쿼리를 owner 조인 포함 그대로 실행 | 2행 정상 반환 |
| `mgmtd` 읽기 실패 로그 | 없음 |
| 정적 파일 캐시 / 브라우저 캐시 | `Cache-Control: no-cache` + ETag. 해당 없음 |
| 브라우저 콘솔 | `GET api/chat/session?oid=... → 404` — 원인 확정 |

서버 쪽을 3회 순회한 뒤에야 브라우저를 확인. 네트워크 탭이 첫 수였어야 함.

### 계정 기준 확인

`ownerOf()` 가 세션 쿠키 → 사용자명 → `local_users.oid` 반환. 모든 쿼리가 이 값으로 필터.
로그아웃·다른 브라우저·다른 머신에서 동일 계정이면 동일 목록. **서버 측은 이미 요구사항 충족 상태였음.**

localStorage 는 환경설정만 보유 — 열려 있던 대화 id, 모델, 모드, 레일 상태.

### 라우팅 — `mgmtd/service/web/WebService.cpp`

매처가 쿼리스트링 포함 전체 target 을 비교:

```cpp
(r.match == Match::Exact) ? (target == r.path) : (target.rfind(r.path, 0) == 0);
```

`/api/chat/session?oid=cv_...` != `/api/chat/session` → 404. 핸들러 미호출이라 로그도 없음.

- `/api/chat/sessions`, `/api/chat/session` 을 `Match::Exact` → `Match::Prefix`
- 순서 유지(`sessions` 가 앞). samples/sample 과 동일 사유 — 짧은 경로가 긴 경로를 가로챔
- 목록도 Prefix 로 변경. Exact 유지 시 나중에 쿼리 파라미터 추가하면 조용히 `session` 핸들러로 낙하

동일 함정이 topology 라우트 주석에 이미 기록돼 있었음 — *"an Exact row stops matching the moment a query string is appended, which fails as a 404 with no handler ever called"*.

### 부팅 시 메시지 미조회 — `mgmtd/www/js/chatbot.js`

`ensureLoaded` 호출 지점이 `selectConvo` 하나뿐. prefs 에서 복원된 `activeId` 는 그 경로를 거치지 않고, 해당 세션 클릭 시 `state.activeId === id` 로 early return.

- `DOMContentLoaded` 에서 `mount()` 후 복원된 세션의 메시지 조회
- `selectConvo` early return 조건에 `c.loaded` 추가

`mount()` 뒤에 배치 — 레일과 빈 스레드가 먼저 그려지고 메시지가 채워짐. `selectConvo` 와 동일 순서.

### `kind` 미복원 — `mgmtd/www/js/chatbot.js`

`msgFromRow` 가 저장된 행을 전부 `kind: 'text'` 로 되살려 실패·차단 턴이 빈 말풍선으로 표시.

- `role === 'assistant' && ok === false` 일 때 `scan.verdict === 'block'` 이면 `'block'`, 아니면 `'error'`
- `error` 인 경우 `scanned = !!(scan && scan.present)`

`kind` 를 컬럼으로 저장하지 않고 재구성 — 행이 보유한 것은 *무슨 일이 있었나*(`ok` `code` `scan`)이고 어느 카드를 그릴지는 거기서 도출. 저장하면 같은 질문에 답이 둘.
`ok` 가 없는 옛 행은 평문 유지. 추측하지 않음.

### 배지 `undefined` — `mgmtd/www/js/chatbot.js`

가드레일 미설정 시 `scan` 이 `{present: false}` 로 도착. `verdict` 필드가 없어 `VERDICT_ICON[undefined]` → 배지에 문자열 `undefined` 출력.

- `present === false` → `'uninspected'` 매핑. 해당 아이콘은 `VERDICT_ICON` 에 이미 존재
- `VERDICT_ICON[v]` 부재 시 배지 생략

### 실패 사유 유실 — `mgmtd/service/web/controller/ChatController.cpp`

실패한 턴도 `answer.value("reply", ...)`(빈 문자열)을 저장하여 사유 유실.

- `ok` 이면 `reply`, 아니면 `error` 를 `content` 로 저장
- 라이브 스레드의 에러 카드(`text: turn.error`)와 일치
- 기존 저장분은 복구 불가. 앞으로 들어오는 턴에만 적용

### 유니크 제약 — `engined/service/chat/ChatService.cpp`

`chat_message` 에 유니크 제약 2개(`oid` PK, `UNIQUE (session, seq)`)인데 `ON CONFLICT (oid)` 하나만 흡수. seq 재사용 재시도 시 예외 → `chat_message write failed` 경고와 함께 반쪽 턴 유실.

- `ON CONFLICT DO NOTHING` (대상 없음)으로 변경. 모든 유니크 위반 흡수

### 낡은 주석 — `mgmtd/www/js/chatbot.js`

파일 헤더가 *"Conversations live in localStorage: this browser, this machine"*. 서버 저장 도입 이후 사실이 아님. 계정 기준이라는 사실과 localStorage 의 실제 용도(환경설정)로 갱신.

### 메뉴 중복 — `mgmtd/www/js/main.js`

`system-operation` 이 Administrator 로 승격되며 `section` 필드를 제거했으나, Configuration 플라이아웃이 `SETTINGS_GROUPS` 를 필터 없이 매핑. `SETTINGS_SECTIONS[undefined] || ''` 로 접혀 헤더 없이 계속 렌더.

- `SETTINGS_GROUPS.filter(g => g.section)` 추가
- `SETTINGS_GROUPS` 자체는 유지 — `SETTINGS_TABS`(탭 해석), `groupOfTab`, 탑바 `activeGroup.label` 이 사용
- 부수 해소 — 사이드바에서 Configuration 과 System Operation 이 동시에 활성화되던 것

`section` 유무가 플라이아웃 포함 여부라는 불변식을 그룹 정의와 필터 양쪽에 명시.

### PA Tech Docs 추가 — `mgmtd/www/js/main.js`

- 사이드바에 `Knowledge Service` 섹션 신설. Infra Service 아래
- `PA Tech Docs` → `tech-doc` 링크
- `PAGES['tech-doc'].title` 을 `Tech Documentation` → `PA Tech Docs` 로 정렬

별도 섹션 사유 — Infra Service(Topology, API Collection)는 고객 인프라, 이것은 벤더 제품 문서. 크롤러가 있다는 공통점뿐. 같이 묶으면 Infra Service 가 "수집기가 붙은 전부" 를 의미하게 됨.
`Knowledge Service` 명명 — 이웃의 `<X> Service` 형태 유지, 보유물이 아닌 제공물 기준이라 소스 추가 시 개명 불필요.

진입 경로 분리 — 열람은 Knowledge Service, 수집은 Administrator ▸ System Operation ▸ Tech Documentation 카드. System Operation 승격 때와 동일 논리.
Operation 카드명은 `Tech Documentation` 유지. 그쪽은 동작.

## 처리한 결함

| 위치 | 원인 |
|---|---|
| `mgmtd/service/web/WebService.cpp` | `Match::Exact` 가 쿼리스트링 포함 비교. `?oid=` 붙는 순간 404, 핸들러 미호출이라 로그 없음 |
| `mgmtd/www/js/chatbot.js` `DOMContentLoaded` | `ensureLoaded` 호출 지점이 `selectConvo` 뿐이고, 복원된 `activeId` 는 그 경로 미경유 |
| `mgmtd/www/js/chatbot.js` `selectConvo` | `state.activeId === id` early return 이 미로드 상태를 구분 안 함 |
| `mgmtd/www/js/chatbot.js` `msgFromRow` | 저장된 행을 전부 `kind: 'text'` 로 복원 |
| `mgmtd/www/js/chatbot.js` `verdictPill` | `{present: false}` 에 `verdict` 필드 부재 → `undefined` 출력 |
| `mgmtd/.../ChatController.cpp` | 실패 턴의 `error` 미저장 |
| `engined/.../ChatService.cpp` | `ON CONFLICT (oid)` 가 `UNIQUE (session, seq)` 미흡수 |
| `mgmtd/www/js/main.js` | 승격 그룹이 플라이아웃에서 미제외 |

## 검증

- `pz-mgmtd` `pz-engined` 빌드 및 링크 통과
- DB 직접 조회로 데이터 존재·owner 일치 확인. `chat_session` 3건 모두 owner `2dc502cb-...`
- 상세 조회 쿼리를 owner 조인 포함 그대로 실행하여 2행 반환 확인
- 정적 파일 서빙 경로(`/opt/pretzel/share/mgmtd/www`)와 mgmtd 기동 시각 대조로 캐시 원인 배제
- `Cache-Control: no-cache` + ETag 헤더 확인으로 브라우저 캐시 배제
- 최상위 `http/` 패키지가 stdlib `http` 를 가려 `urllib.request` 가 죽는 것을 실증

**미검증** — 브라우저에서의 실제 동작. 빌드만 완료, 미배포 상태

## TODO

| 항목 | 왜 안 됐나 | 어디를 |
|---|---|---|
| 설치 + 재시작 | 웹 세션이 끊기는 작업이라 미실행 | `script/install.py`, `pz-mgmtd` `pz-engined`. mgmtd 는 정적 파일 메모리 캐시라 JS 변경도 재시작 필요 |
| 나머지 64개 라우트의 동일 함정 | 미확인. chat 만 수정 | `mgmtd/service/web/WebService.cpp` `kRoutes` |
| 라우트 테이블 테스트 | 미착수. 이번 404 는 `EXPECT_EQ(resolve("GET", "/api/chat/session?oid=x").route, WebRoute::ChatSession)` 한 줄로 잡혔을 사안 | `tests/` 신규 |
| `grpc/` 로거 중복 | 6개 파일이 bare `pretzel-ai` 공유. 운영자가 grep 하는 문자열이라 임의 변경 보류 | `mgmtd` 아님 — pretzel-ai 쪽 |
| 개발 시 재시작 회피 | 미적용 | `PRETZEL_MGMTD_STATIC_RELOAD=1` 로 기동 |
| 테스트 커버리지 | 1,891줄 / 프로덕션 약 69,000줄(2.6%). 웹 라우팅·챗 경로·DB 계층 미커버 | `tests/` |
| CI | 없음 | 신규 |
