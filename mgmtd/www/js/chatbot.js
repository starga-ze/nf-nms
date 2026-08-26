/* chatbot.js — AI › Assistant
 *
 * What this page is
 * -----------------
 * The internal chatbot itself — the application employees actually talk to — living inside the
 * console rather than beside it, because the interesting half of it is not the conversation. Every
 * turn here is supposed to leave through an AI gateway (Portkey) that hands the text to AI Runtime
 * Security for inspection before it reaches a model, and hands the answer back through the same
 * scan on the way out. This page is where that path becomes visible.
 *
 * Prompt   → gateway → AIRS scan → model
 * Response → AIRS scan → gateway → here
 *
 * Three outcomes, and the UI is built around the distinction:
 *   allow   nothing found. The pill is grey and says so once, quietly.
 *   mask    something identifying was found and REPLACED before the text left the appliance. The
 *           conversation still works; the inspector shows what actually egressed.
 *   block   the turn does not go upstream at all. There is no answer to show, so the answer is
 *           replaced by an enforcement card, not by a model apology.
 *
 * Where the answers come from
 * ---------------------------
 * POST /api/chat → mgmtd → inferd → the gateway. The verdicts drawn here are AIRS's own, read out
 * of the `hook_results` the gateway returns, so what is on screen is what actually happened rather
 * than what this page believes should have.
 *
 * When there is no gateway — no route deployed, none configured — the local mock below answers
 * instead, and the strip says so on every turn. That is the only case it fires: a REAL gateway
 * failing produces an error card, never a mock reply, because a made-up answer presented as a live
 * one is the single worst thing this page could do.
 *
 * The mock scanner is a set of regexes, not a model. It is honest about the SHAPE of the flow and
 * says nothing about AIRS's detection quality.
 *
 * A fourth outcome the gateway can report, which no pass/fail badge can express:
 *   flagged  AIRS detected something and the gateway forwarded it anyway (enforcement off, or an
 *            async guardrail that structurally cannot deny). Drawn as its own state, never as a
 *            block — mistaking the two is exactly the failure the AIRS lab exists to catch.
 *   uninspected  no hook_results at all: the guardrail is not on this call's path.
 *
 * Conversations live in localStorage: this browser, this machine. There is no server-side thread
 * store, and dropping the history on reload would lose real work.
 */
(function () {
  'use strict';

  const esc = (s) => window.NMS.utils.esc(s);
  const fmtTs = (v) => window.NMS.utils.fmtTs(v);

  // Threads live in this browser only — there is no server-side thread store. That makes them the
  // signed-in person's data sitting on a shared appliance console, so the key is registered for
  // clearing at logout; without that, the next person to sign in on this machine opens the rail
  // and reads the previous one's conversations, scan verdicts and all.
  const STORE_KEY = 'pz.chat.v1';
  window.NMS.clearOnLogout(STORE_KEY);
  // The mock's own profile name. Deliberately not a plausible-looking real one: an inspector
  // that named a corporate profile under a browser regex would be inventing provenance.
  const PROFILE = 'local-mock';
  const GATEWAY = 'Portkey';
  const CHAT_URL = '/api/chat';
  const CHAT_RESULT_URL = '/api/chat/result';
  // A turn is never answered on the POST — see askServer below for why.
  const POLL_MS = 400;
  const POLL_TIMEOUT_MS = 90000;

  // How fast an answer is written onto the screen. 55 characters a second sits just above a
  // comfortable Korean reading pace (~15-25/s) and inside the range a model streaming live would
  // produce (~30-80/s), so the two are indistinguishable to read.
  //
  // MAX_STREAM_MS is the ceiling: past roughly a thousand characters, holding the base rate would
  // make the reader wait longer for the end of the answer than the gateway took to produce it, so
  // longer answers speed up to land inside it. FRAME_MS is one animation frame.
  const READ_CPS = 55;
  const MAX_STREAM_MS = 18000;
  const FRAME_MS = 16;

  // Model choice belongs to the gateway, not to the app — the app names a model and the gateway
  // decides which provider and key serve it. Each entry is one gateway integration, so switching
  // model switches upstream account. The id is Portkey's own routing syntax,
  // @<integration-slug>/<model>; a bare model name is refused by the gateway itself
  // ("x-portkey-config or x-portkey-provider header is required"), so the slug is not decoration.
  //
  // The catalog is ASKED FOR, not declared here: GET /api/chat/models → pretzel-ai's ListModels,
  // which answers out of prisma-airs/config.json. That file is the daemon's allowlist, so a list
  // kept here too could disagree with it, and the disagreement only shows up as a refusal after
  // the operator has already typed a message.
  //
  // FALLBACK_MODELS is for the one case where asking fails. An empty picker cannot be told apart
  // from a broken page and cannot send anything either way, so one known-good model is offered and
  // the strip says plainly that the list is stale.
  const FALLBACK_MODELS = [
    { id: '@openai/gpt-4o-2024-11-20', label: 'GPT-4o', provider: 'OpenAI' },
  ];

  let MODELS = FALLBACK_MODELS.slice();

  // 'loading' until the daemon answers, then 'ready', or 'fallback' when it did not.
  let catalog = { status: 'loading', error: '' };

  // ── Scan profile ───────────────────────────────────────────────────────────
  // The categories the profile checks. All of them are listed in the inspector on every scan,
  // cleared ones included — "PII: none" is information, and a panel that only lists hits can never
  // say it.
  const CATEGORIES = [
    { id: 'prompt_injection', label: 'Prompt Injection'      },
    { id: 'pii',              label: 'PII'                   },
    { id: 'dlp',              label: 'Sensitive Data (DLP)'  },
    { id: 'malicious_url',    label: 'Malicious URL'         },
    { id: 'toxicity',         label: 'Toxic Content'         },
    { id: 'db_security',      label: 'Database Security'     },
  ];

  // Detectors. `action` is what the profile does when this one fires:
  //   block  the turn is refused; nothing egresses.
  //   mask   the match is replaced by its token and the rest of the turn goes through.
  // A masked match keeps its TYPE in the token ([RRN], [EMAIL]) rather than becoming a row of
  // asterisks, so the model still knows a person was named and the answer stays coherent.
  const DETECTORS = [
    {
      cat: 'prompt_injection', action: 'block', name: 'Instruction override',
      re: /(ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?|disregard\s+(?:all\s+)?(?:previous|prior)\s+\w+|reveal\s+(?:your\s+)?system\s+prompt|jailbreak|DAN\s*mode|이전\s*(?:의\s*)?(?:지시|명령|프롬프트)[^\n]{0,8}무시|시스템\s*프롬프트[^\n]{0,10}(?:출력|알려|보여)|개발자\s*모드)/gi,
      why: 'Phrasing that tries to countermand or extract the system prompt. A model that complies stops being bound by the policy it was given.',
    },
    {
      cat: 'pii', action: 'mask', name: 'Korean resident registration number', token: '[RRN]',
      re: /\b\d{6}[-\s]?[1-4]\d{6}\b/g,
      why: 'A 13-digit RRN identifies one person for life and cannot be reissued. It never leaves the appliance in clear text.',
    },
    {
      cat: 'pii', action: 'mask', name: 'Email address', token: '[EMAIL]',
      re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g,
      why: 'A work address identifies an individual and is the usual pivot for phishing built on leaked prompts.',
    },
    {
      cat: 'pii', action: 'mask', name: 'Phone number', token: '[PHONE]',
      re: /\b01[016-9][-\s.]?\d{3,4}[-\s.]?\d{4}\b/g,
      why: 'A mobile number is directly reachable personal data.',
    },
    {
      cat: 'pii', action: 'mask', name: 'Payment card number', token: '[CARD]',
      re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
      why: 'A 16-digit PAN. Sending one to a third-party model is a cardholder-data disclosure regardless of intent.',
    },
    {
      cat: 'dlp', action: 'block', name: 'Cloud or API credential',
      re: /(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN\s+[A-Z ]*PRIVATE KEY-----)/g,
      why: 'A live credential. Once it is in a prompt it is in someone else’s logs, so the turn is refused rather than redacted.',
    },
    {
      cat: 'dlp', action: 'block', name: 'Internal classification marking',
      re: /(대외비|사내\s*한정|CONFIDENTIAL\s*[-–—]\s*INTERNAL|INTERNAL\s+USE\s+ONLY)/gi,
      why: 'The document says on its face that it may not be disclosed outside the company. A model endpoint is outside the company.',
    },
    {
      cat: 'db_security', action: 'block', name: 'Destructive SQL',
      re: /\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(?:;|$)|UPDATE\s+\w+\s+SET\s+[^\n]*(?:;|$)(?![^\n]*WHERE))/gi,
      why: 'An unqualified destructive statement. Assistants are given database tools more often than they are given brakes.',
    },
    {
      cat: 'malicious_url', action: 'block', name: 'Untrusted link',
      re: /https?:\/\/[^\s]*\.(?:ru|top|xyz|tk|cf|zip|mov)\b[^\s]*/gi,
      why: 'A link on a domain outside the allowed set. Fetching it turns the assistant into the delivery path.',
    },
    {
      cat: 'toxicity', action: 'block', name: 'Abusive language',
      re: /(씨발|개새끼|병신|fuck\s*you|\bkys\b)/gi,
      why: 'Abuse aimed at a person. Logged against the account rather than answered.',
    },
  ];

  const MASK_TOKENS = ['RRN', 'EMAIL', 'PHONE', 'CARD'];
  const TOKEN_RE = new RegExp('\\[(?:' + MASK_TOKENS.join('|') + ')\\]', 'g');

  // ── The scanner ────────────────────────────────────────────────────────────

  function randId(prefix, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += '0123456789abcdef'[(Math.random() * 16) | 0];
    return prefix + s;
  }

  // Every detector over the whole text, then overlaps dropped left-to-right so one stretch of text
  // is only ever attributed to one finding — a card number that also matches a phone pattern must
  // not be reported twice, or the counts stop meaning anything.
  function findSpans(text) {
    const spans = [];
    for (const d of DETECTORS) {
      d.re.lastIndex = 0;
      let m, guard = 0;
      while ((m = d.re.exec(text)) !== null && guard++ < 64) {
        if (!m[0].length) { d.re.lastIndex++; continue; }
        spans.push({ start: m.index, end: m.index + m[0].length, det: d, raw: m[0] });
      }
    }
    spans.sort((a, b) => (a.start - b.start) || (b.end - a.end));
    const kept = [];
    let cursor = -1;
    for (const s of spans) {
      if (s.start >= cursor) { kept.push(s); cursor = s.end; }
    }
    return kept;
  }

  // A scan result is self-contained: it carries the decision, every category that was checked, the
  // findings, and — the part that matters — the text that would actually egress. Stored on the
  // message, so an old conversation can still be audited.
  function scan(text, direction) {
    const spans = findSpans(text);
    const blocked = spans.some(s => s.det.action === 'block');
    const masked = !blocked && spans.some(s => s.det.action === 'mask');

    const cats = CATEGORIES.map(c => {
      const hits = spans.filter(s => s.det.cat === c.id);
      return {
        id: c.id,
        label: c.label,
        action: hits.length ? hits[0].det.action : '',
        findings: hits.map(h => ({ name: h.det.name, why: h.det.why, sample: sampleOf(h) })),
      };
    });

    // Nothing egresses on a block, and saying "this is what we sent" under a refused turn would be
    // exactly backwards.
    let outbound = null;
    if (!blocked) {
      let out = '', at = 0;
      for (const s of spans) {
        out += text.slice(at, s.start) + (s.det.token || '[REDACTED]');
        at = s.end;
      }
      outbound = out + text.slice(at);
    }

    return {
      id: randId('scn_', 12),
      direction,                                     // 'prompt' | 'response'
      verdict: blocked ? 'block' : (masked ? 'mask' : 'allow'),
      profile: PROFILE,
      categories: cats,
      outbound,
      // The scan is a network round trip in the real path; the mock quotes a plausible one rather
      // than zero, which would read as "no scan happened".
      latencyMs: 18 + Math.round(Math.random() * 34) + spans.length * 3,
      at: Date.now(),
    };
  }

  // What the finding matched, shown back to the operator. A masked category must not be un-masked
  // by its own evidence panel, so only the shape survives; a blocked one is quoted, because the
  // whole question there is "what did I write that did this".
  function sampleOf(span) {
    const raw = span.raw;
    if (span.det.action === 'mask') {
      const head = raw.slice(0, Math.min(4, raw.length));
      return head + '…' + '•'.repeat(Math.max(3, Math.min(8, raw.length - 4)));
    }
    return raw.length > 90 ? raw.slice(0, 90) + '…' : raw;
  }

  // What to name on the card. The two scan shapes carry the reason differently — the mock knows
  // which detector fired, AIRS reports which categories came back true — so this returns the one
  // thing both can answer: a human name for what was found.
  function firstBlocker(sc) {
    if (!sc) return null;

    if (sc.source === 'airs') {
      const hits = (sc.categories || []).filter(c => c.hit);
      if (!hits.length) return null;
      return {
        cat: hits[0],
        finding: { name: hits[0].label },
        all: hits.map(h => h.label),
      };
    }

    for (const c of sc.categories || []) {
      if (c.action === 'block' && c.findings.length) {
        return { cat: c, finding: c.findings[0], all: [c.label] };
      }
    }
    return null;
  }

  // ── The mock model ─────────────────────────────────────────────────────────
  // Canned answers in the register an internal assistant actually answers in. Matched against the
  // OUTBOUND text — the redacted one — because that is what a model would see, and the answer
  // should visibly be built without the identifiers.

  const REPLIES = [
    {
      re: /연차|휴가|반차/,
      text: '연차는 그룹웨어 **근태 > 연차 현황**에서 확인하실 수 있습니다.\n\n' +
            '· 잔여 일수는 회계연도 기준(1/1~12/31)으로 계산됩니다\n' +
            '· 입사 1년 미만이면 매월 1일씩 발생하고, 발생 즉시 사용 가능합니다\n' +
            '· 미사용 연차는 익년 3월까지 이월되며, 그 이후 소멸됩니다\n\n' +
            '반차는 오전(09–14시) / 오후(14–18시) 중 선택해 신청하고, 결재선은 팀장 1인입니다.',
    },
    {
      re: /법인\s*카드|경비|정산|영수증/,
      text: '법인카드 정산은 사용일로부터 **7일 이내**에 완료해 주셔야 합니다.\n\n' +
            '1. 그룹웨어 > 지출결의 > 카드사용내역에서 해당 건 선택\n' +
            '2. 영수증 이미지 첨부 (간이영수증은 불가, 신용카드 매출전표 또는 세금계산서)\n' +
            '3. 계정과목·목적·참석자 입력 후 상신\n\n' +
            '접대비는 1건 3만원 초과 시 참석자 명단이 필수이고, 주말·공휴일 사용 건은 사유서가 함께 올라가야 승인됩니다.',
    },
    {
      re: /vpn|원격|재택|접속이?\s*안/i,
      text: 'VPN 접속이 안 될 때는 아래 순서로 확인해 주세요.\n\n' +
            '1. **OTP 시간 동기화** — 앱과 단말 시계가 30초 이상 어긋나면 인증이 실패합니다\n' +
            '2. **사번 계정 잠김** — 5회 연속 실패 시 30분 잠깁니다\n' +
            '3. **클라이언트 버전** — 6.2 미만은 신규 게이트웨이를 붙지 못합니다\n\n' +
            '터널 상태는 클라이언트에서 바로 확인할 수 있습니다.\n\n' +
            '```\nglobalprotect show --status\n```\n\n' +
            '위 세 가지로 해결되지 않으면 헬프데스크(내선 1234)로 사번과 함께 문의해 주세요.',
    },
    {
      re: /비밀번호|패스워드|계정\s*잠|초기화/,
      text: '사번 계정 비밀번호는 포털 로그인 화면의 **비밀번호 재설정**에서 직접 바꾸실 수 있습니다.\n\n' +
            '· 12자 이상, 영문 대소문자·숫자·특수문자 중 3종 이상 조합\n' +
            '· 최근 사용한 4개는 재사용할 수 없습니다\n' +
            '· 90일마다 변경 알림이 발송됩니다\n\n' +
            '계정이 잠긴 경우에는 재설정도 막히므로, 헬프데스크를 통해 잠금 해제를 먼저 받으셔야 합니다.',
    },
    {
      re: /회의실|예약|자원\s*예약/,
      text: '회의실 예약은 그룹웨어 **자원예약** 메뉴에서 하실 수 있습니다.\n\n' +
            '· 대회의실(3층)은 20인 이상 행사만 예약 가능하며 팀장 승인이 필요합니다\n' +
            '· 노쇼가 2회 누적되면 30일간 예약이 제한됩니다\n' +
            '· 외부 방문객이 있으면 예약 시 방문자 정보를 함께 등록해야 출입증이 발급됩니다',
    },
    {
      re: /급여|연말정산|원천징수|명세서/,
      text: '급여명세서와 원천징수영수증은 그룹웨어 **인사 > 나의 급여**에서 내려받으실 수 있습니다.\n\n' +
            '연말정산 간소화 자료 제출은 매년 1월 중순부터 2주간 열리며, 기간이 지나면 5월 종합소득세 신고로 개별 처리하셔야 합니다. ' +
            '부양가족 자료는 사전에 동의 절차가 끝나 있어야 조회됩니다.',
    },
    {
      // Deliberately answers with contact details: the response scan then has something to find on
      // the way back, which is the half of the flow a request-only demo never shows.
      re: /담당자|연락처|누구(에게|한테)|문의처/,
      text: '해당 업무 담당자는 아래와 같습니다.\n\n' +
            '· 인사/근태 — 김서연 책임 (hr.kim@example.co.kr, 010-2345-6789)\n' +
            '· 경비/정산 — 박지훈 선임 (fin.park@example.co.kr, 010-3456-7890)\n' +
            '· 계정/VPN — 헬프데스크 (helpdesk@example.co.kr, 내선 1234)\n\n' +
            '급한 건은 헬프데스크로 먼저 연락 주시면 담당자에게 연결해 드립니다.',
    },
  ];

  function mockReply(prompt) {
    for (const r of REPLIES) {
      if (r.re.test(prompt)) return r.text;
    }
    const redacted = TOKEN_RE.test(prompt);
    TOKEN_RE.lastIndex = 0;
    return (redacted
        ? '요청은 확인했습니다. 다만 전달된 내용에서 개인정보에 해당하는 부분이 가려진 상태로 도착해서, 특정 개인을 지목한 처리는 도와드리기 어렵습니다.\n\n'
        : '') +
      '사내 규정·근태·경비·계정 관련 질문에 답변해 드릴 수 있습니다. ' +
      '예를 들어 연차 잔여 확인, 법인카드 정산 절차, VPN 접속 문제, 회의실 예약 규칙 같은 주제라면 바로 안내가 가능합니다.\n\n' +
      '조금 더 구체적으로 어떤 상황인지 알려주시면 해당 규정을 찾아 정리해 드리겠습니다.';
  }

  // ── State ──────────────────────────────────────────────────────────────────

  const state = {
    convos: [],        // [{ id, title, createdAt, updatedAt, messages: [] }]
    activeId: '',
    model: FALLBACK_MODELS[0].id,
    railOpen: true,
    inspectId: '',     // message id whose scan is open
    sending: false,
    gateway: 'unknown',// 'unknown' | 'live' | 'mock' | 'error' — what answered the last send
    profile: '',       // the AIRS profile name the gateway last reported
    badges: true,      // inline verdict pills
    rag: true,         // ground answers in the Prisma Access corpus
    topK: 5,           // passages to retrieve when it is on
  };

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (Array.isArray(raw.convos)) state.convos = raw.convos;
      if (raw.activeId) state.activeId = raw.activeId;
      if (typeof raw.rag === 'boolean') state.rag = raw.rag;
      if (Number.isFinite(raw.topK)) state.topK = Math.min(20, Math.max(1, raw.topK));
      // Not validated here: the catalog has not arrived yet, and dropping a stored choice
      // against the one-entry fallback would reset every operator to GPT-4o on load.
      // loadCatalog() checks it once the real list is in.
      if (raw.model) state.model = raw.model;
      if (typeof raw.badges === 'boolean') state.badges = raw.badges;
      if (typeof raw.railOpen === 'boolean') state.railOpen = raw.railOpen;
    } catch (_) { /* corrupt or absent — start clean */ }
  }

  function save() {
    try {
      // Thirty threads is already more history than anyone scrolls; the cap is what keeps a busy
      // browser from filling its storage quota and losing the write that matters.
      const convos = state.convos.slice(0, 30);
      localStorage.setItem(STORE_KEY, JSON.stringify({
        convos, activeId: state.activeId, model: state.model,
        badges: state.badges, railOpen: state.railOpen,
      }));
    } catch (_) { /* quota or private mode — the session still works, it just will not survive */ }
  }

  const activeConvo = () => state.convos.find(c => c.id === state.activeId) || null;

  // A conversation's id is also its AIRS session id: it is sent as session_id on every turn, and
  // pretzel-ai forwards it to the gateway as the scan's tr_id. So it is minted once, here, and
  // never regenerated for the life of the thread — a new id mid-conversation splits one exchange
  // into two unrelated sessions in the AIRS console, which is exactly what "new chat" is for and
  // exactly what must not happen otherwise.
  function newConvo(makeActive) {
    const c = { id: randId('cv_', 10), title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.convos.unshift(c);
    if (makeActive !== false) state.activeId = c.id;
    return c;
  }

  // "New chat" is a security control as much as a UI affordance: it is the only way to start a
  // session AIRS will not correlate with what came before. Reusing the empty thread already open
  // rather than stacking a second one keeps the rail from filling with blank sessions that were
  // never sent — and an unsent thread has no scans behind it, so there is nothing to separate.
  function startNewChat() {
    const cur = activeConvo();
    if (cur && !cur.messages.length) {
      state.activeId = cur.id;
    } else {
      newConvo();
    }
    state.inspectId = '';
    save();
    renderRail();
    renderThread();
    const input = document.getElementById('chatInput');
    if (input) input.focus();
  }

  function deleteConvo(id) {
    const i = state.convos.findIndex(c => c.id === id);
    if (i < 0) return;
    state.convos.splice(i, 1);
    // Deleting the open thread has to leave one open. Falling back to the neighbour rather than
    // always minting a fresh conversation avoids burning a session id on a click that was about
    // tidying the rail, not about starting something new.
    if (state.activeId === id) {
      const next = state.convos[i] || state.convos[i - 1] || null;
      state.activeId = next ? next.id : (newConvo().id);
    }
    state.inspectId = '';
    save();
    renderRail();
    renderThread();
  }

  function selectConvo(id) {
    if (!state.convos.some(c => c.id === id) || state.activeId === id) return;
    state.activeId = id;
    state.inspectId = '';
    save();
    renderRail();
    renderThread();
  }

  function findMessage(id) {
    for (const c of state.convos) {
      const m = c.messages.find(x => x.id === id);
      if (m) return m;
    }
    return null;
  }

  // The open conversation only. A running total across every thread in the browser answers a
  // question nobody is asking — "how much has this laptop ever sent" — and it moves for reasons
  // that have nothing to do with what is on screen, so a block from a thread three days ago sits
  // in the count under a conversation where nothing was blocked. Per conversation the numbers
  // describe the thing the reader is looking at, and reset when they start a new one.
  function stats() {
    let scanned = 0, masked = 0, blocked = 0, flagged = 0, uninspected = 0;
    const c = activeConvo();
    for (const m of (c ? c.messages : [])) {
      if (!m.scan) continue;
      // A prompt-block card carries the same scan as the user message above it — count the turn
      // once. A response-block card is the only carrier of ITS scan, so it does count.
      if (m.kind === 'block' && m.scan.direction === 'prompt') continue;
      scanned++;
      if (m.scan.verdict === 'mask') masked++;
      else if (m.scan.verdict === 'block') blocked++;
      else if (m.scan.verdict === 'flagged') flagged++;
      else if (m.scan.verdict === 'uninspected') uninspected++;
    }
    return { scanned, masked, blocked, flagged, uninspected };
  }

  // ── Icons ──────────────────────────────────────────────────────────────────

  const svg = (inner, w) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w || 2}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  const IC = {
    plus:    svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    trash:   svg('<polyline points="3 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>'),
    shield:  svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    shieldOk: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15.5 9.5"/>'),
    shieldX: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="9.5" y1="9.5" x2="14.5" y2="14.5"/><line x1="14.5" y1="9.5" x2="9.5" y2="14.5"/>'),
    eye:     svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
    mask:    svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="8.5" y1="12" x2="15.5" y2="12"/>'),
    send:    svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
    x:       svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    panel:   svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>'),
    spark:   svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
    check:   svg('<polyline points="4 12 9 17 20 6"/>'),
    copy:    svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    shieldOff: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="4" y1="4" x2="20" y2="20"/>'),
    alert:   svg('<path d="M12 3l9.5 16.5H2.5z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    caret:   svg('<polyline points="6 9 12 15 18 9"/>'),
    search:  svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  };

  // ── Minimal markdown ───────────────────────────────────────────────────────
  // Only what the answers actually use: fenced blocks, inline code, bold. Everything is escaped
  // first — the text on this page is by definition untrusted, half of it comes back from a model,
  // and the whole point of the page is that hostile input reaches it.

  // Markdown, because that is what a model emits whether or not anyone asked it to: headings,
  // numbered steps, tables, fenced code. Rendered here rather than shown raw — a reader looking at
  // literal `###` and `|---|` is reading the model's formatting instructions, not its answer.
  //
  // Written out rather than pulled from a library on purpose. This page renders text that came back
  // from a third-party model through a security gateway, which is the definition of untrusted
  // input; every branch below starts from esc()'d text and only ever re-introduces tags this
  // function itself wrote. Nothing here can emit an attribute from the source string, so there is
  // no path from model output to script execution.
  // A fenced block written inside a list item arrives indented by whatever the list needed, and
  // that indentation is markdown's, not the code's — rendered as-is it shows a shell command sitting
  // four spaces in for no reason a reader can see. The common prefix is removed and the relative
  // shape kept, so a nested if/else still reads as nested. Blank lines are ignored when measuring:
  // one stray empty line would otherwise make the common prefix zero.
  function dedent(code) {
    const lines = String(code).split('\n');
    let pad = Infinity;
    for (const l of lines) {
      if (!l.trim()) continue;
      pad = Math.min(pad, l.length - l.replace(/^[ \t]+/, '').length);
      if (!pad) return String(code);
    }
    if (!isFinite(pad) || pad === 0) return String(code);
    return lines.map(l => l.slice(pad)).join('\n');
  }

  function renderText(s) {
    const src = String(s == null ? '' : s);

    // Fenced code is lifted out first and parked behind a placeholder, so the inline rules below
    // cannot reach inside it — a shell script full of ** and _ is code, not emphasis.
    const blocks = [];
    let text = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, body) => {
      // The header is real markup rather than a ::before, because it holds a button now. The
      // button carries no copy of the code: the handler reads it back out of the <code> element,
      // so what lands on the clipboard cannot drift from what is on screen.
      blocks.push(
        `<div class="chat-code">` +
          `<div class="chat-code-h">` +
            `<span class="chat-code-l">${esc(lang || 'code')}</span>` +
            `<button class="chat-code-c" type="button" data-codecopy="1" data-tip="Copy">` +
              `${IC.copy}<span class="chat-copy-t">복사</span></button>` +
          `</div>` +
          `<pre><code>${esc(dedent(body.replace(/\n+$/, '')))}</code></pre>` +
        `</div>`);
      return `\uE000CODE${blocks.length - 1}\uE001`;
    });

    // Inline rules run on escaped text, so a literal <b> in the answer stays literal.
    const inline = (t) => {
      let h = esc(t);
      h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      h = h.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>');
      h = h.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
      // Only http(s). javascript: and data: URLs are the reason this is a whitelist and not a
      // general link rule — the href here is written by whatever answered the prompt.
      h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      h = h.replace(TOKEN_RE, m => `<span class="chat-redact">${m}</span>`);
      return h;
    };

    const lines = text.split('\n');
    const out = [];
    let list = null;      // 'ul' | 'ol' while one is open
    let para = [];

    const flushPara = () => {
      if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
    };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\uE000CODE\d+\uE001$/.test(line.trim())) {
        flushPara(); closeList();
        out.push(line.trim());
        continue;
      }
      if (!line.trim()) { flushPara(); closeList(); continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const lvl = Math.min(6, Math.max(3, h[1].length + 2));   // never h1/h2: the page owns those
        out.push(`<h${lvl} class="chat-md-h">${inline(h[2])}</h${lvl}>`);
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara(); closeList();
        out.push('<hr class="chat-hr">');
        continue;
      }

      // A table needs its separator row to be a table at all; without it these are just lines
      // that happen to contain pipes, and rendering them as a grid would invent structure.
      if (line.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] || '')) {
        flushPara(); closeList();
        const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
        const head = cells(line).map(c => `<th>${inline(c.trim())}</th>`).join('');
        const body = [];
        let j = i + 2;
        for (; j < lines.length && lines[j].includes('|'); j++) {
          body.push('<tr>' + cells(lines[j]).map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>');
        }
        out.push(`<div class="chat-tablewrap"><table class="chat-table">` +
                 `<thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table></div>`);
        i = j - 1;
        continue;
      }

      const q = line.match(/^>\s?(.*)$/);
      if (q) {
        flushPara(); closeList();
        out.push(`<blockquote class="chat-quote">${inline(q[1])}</blockquote>`);
        continue;
      }

      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ol || ul) {
        flushPara();
        const want = ol ? 'ol' : 'ul';
        if (list !== want) { closeList(); out.push(`<${want} class="chat-list">`); list = want; }
        out.push(`<li>${inline((ol || ul)[1])}</li>`);
        continue;
      }

      closeList();
      para.push(line);
    }
    flushPara(); closeList();

    return out.join('').replace(/\uE000CODE(\d+)\uE001/g, (_, n) => blocks[Number(n)]);
  }

  // ── The model catalog ──────────────────────────────────────────────────────
  //
  // Two hops, because that is how every pretzel-ai call reaches the browser: the POST/GET returns
  // a ticket and the answer is polled off /api/chat/result. mgmtd builds responses on the same
  // loop the gRPC socket lives on, so a route that blocked on the round trip would stall every
  // other request for its duration.

  const MODELS_URL = '/api/chat/models';
  const CATALOG_POLL_MS = 180;
  const CATALOG_TRIES = 45;   // ~8s, after which the list is not coming

  // `wait` is the one declared with the send path below — the same helper, so it is shared rather
  // than redeclared. A second `const wait` in this scope is not a shadow, it is a SyntaxError that
  // takes the whole file down before a single line runs.

  async function fetchCatalog() {
    const r = await fetch(MODELS_URL, { credentials: 'same-origin' });
    if (r.status === 404) throw new Error('this appliance has no /api/chat/models route');
    if (!r.ok) throw new Error(`the model list could not be requested (HTTP ${r.status})`);

    const ticket = (await r.json()).ticket;
    if (!ticket) throw new Error('mgmtd issued no ticket for the model list');

    for (let i = 0; i < CATALOG_TRIES; i++) {
      await wait(CATALOG_POLL_MS);
      const p = await fetch(`${CHAT_RESULT_URL}?ticket=${encodeURIComponent(ticket)}`,
                            { credentials: 'same-origin' });
      if (!p.ok) throw new Error(`the model list could not be read (HTTP ${p.status})`);
      const doc = await p.json();
      if (doc.status === 'pending') continue;
      if (doc.error) throw new Error(doc.error);
      return doc;
    }
    throw new Error('pretzel-ai did not answer with a model list');
  }

  async function loadCatalog() {
    catalog = { status: 'loading', error: '' };
    renderPicker();
    try {
      const doc = await fetchCatalog();
      const list = (doc.models || []).filter(m => m && m.id).map(m => ({
        id: m.id,
        label: m.label || m.id,
        provider: m.provider || '',
      }));
      if (!list.length) throw new Error('the appliance reports no models');

      MODELS = list;
      catalog = { status: 'ready', error: '' };

      // A stored choice that has since left the catalog must not stay selected: the daemon would
      // refuse it, and the refusal arrives only after the operator has typed and sent. The
      // server's own default is preferred over "the first one" so the picker starts where the
      // appliance says it should.
      if (!MODELS.some(m => m.id === state.model)) {
        const fallback = MODELS.some(m => m.id === doc.default_model)
          ? doc.default_model : MODELS[0].id;
        state.model = fallback;
        save();
      }
    } catch (e) {
      catalog = { status: 'fallback', error: String((e && e.message) || e) };
    }
    renderPicker();
  }

  // ── Model picker ───────────────────────────────────────────────────────────
  //
  // Deliberately not the shared enhanceSelect dropdown. That control is one flat list of strings,
  // which is right for a settings field and wrong here on three counts: the catalog spans several
  // providers and switching model switches upstream ACCOUNT, the exact routing id is what a
  // gateway refusal will name so the operator has to be able to read it, and a flat list of ten
  // entries is a list you scan rather than one you pick from.

  const providerKey = (p) => (p || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // Search appears once the list outgrows a glance. Below that it is chrome that costs a
  // keystroke and saves none.
  const SEARCH_AT = 7;

  const picker = { open: false, query: '', active: -1, rows: [] };

  function groupModels(list) {
    const order = [], by = new Map();
    list.forEach(m => {
      const p = m.provider || 'Other';
      if (!by.has(p)) { by.set(p, []); order.push(p); }
      by.get(p).push(m);
    });
    return order.map(p => ({ provider: p, models: by.get(p) }));
  }

  function matchingModels() {
    const q = picker.query.trim().toLowerCase();
    if (!q) return MODELS;
    return MODELS.filter(m => (m.label + ' ' + m.id + ' ' + (m.provider || '')).toLowerCase()
                              .includes(q));
  }

  function currentModel() {
    return MODELS.find(m => m.id === state.model) || MODELS[0] || FALLBACK_MODELS[0];
  }

  function pickerTrigger() {
    const cur = currentModel();
    const loading = catalog.status === 'loading';
    return `
      <button class="mp-trigger" type="button" id="mpTrigger"
              aria-haspopup="listbox" aria-expanded="${picker.open ? 'true' : 'false'}"
              ${state.sending ? 'disabled' : ''}>
        <span class="mp-dot" data-p="${providerKey(cur.provider)}" aria-hidden="true"></span>
        <span class="mp-tl">
          <span class="mp-name">${esc(cur.label)}</span>
          <span class="mp-prov">${loading ? '불러오는 중…' : esc(cur.provider || '—')}</span>
        </span>
        ${catalog.status === 'fallback'
          ? '<span class="mp-warn" title="모델 목록을 가져오지 못했습니다">!</span>' : ''}
        <span class="mp-caret" aria-hidden="true">${IC.caret}</span>
      </button>`;
  }

  function pickerPanel() {
    if (!picker.open) return '';

    if (catalog.status === 'loading') {
      return `<div class="mp-panel" role="listbox" aria-busy="true">
                <div class="mp-skel"></div><div class="mp-skel"></div><div class="mp-skel"></div>
              </div>`;
    }

    picker.rows = matchingModels();

    const search = MODELS.length >= SEARCH_AT ? `
      <div class="mp-search">
        ${IC.search}
        <input type="text" id="mpSearch" autocomplete="off" spellcheck="false"
               placeholder="모델 검색" value="${esc(picker.query)}"
               aria-label="모델 검색" aria-controls="mpList"/>
      </div>` : '';

    return `<div class="mp-panel" role="listbox" id="mpList">
              ${search}<div class="mp-list" id="mpOpts">${optionsHtml()}</div>
              <div class="mp-foot-slot">${footHtml()}</div>
            </div>`;
  }

  function optionsHtml() {
    const list = picker.rows;
    return list.length ? groupModels(list).map(g => `
      <div class="mp-group" role="presentation">
        <span class="mp-dot" data-p="${providerKey(g.provider)}" aria-hidden="true"></span>
        ${esc(g.provider)}
        <span class="mp-count">${g.models.length}</span>
      </div>
      ${g.models.map(m => {
        const i = list.indexOf(m);
        const on = m.id === state.model;
        return `
        <div class="mp-opt${on ? ' is-on' : ''}${i === picker.active ? ' is-active' : ''}"
             id="mpOpt${i}" role="option" aria-selected="${on}" data-id="${esc(m.id)}" data-i="${i}">
          <span class="mp-opt-t">
            <span class="mp-opt-name">${esc(m.label)}</span>
            <span class="mp-opt-id">${esc(m.id)}</span>
          </span>
          ${on ? `<span class="mp-check" aria-hidden="true">${IC.check}</span>` : ''}
        </div>`;
      }).join('')}`).join('')
      : `<div class="mp-empty">“${esc(picker.query)}”에 해당하는 모델이 없습니다.</div>`;
  }

  // The failure line is inside the panel, not a toast: it is the reason the list is one entry
  // long, and it has to be readable at the moment the operator is wondering why.
  function footHtml() {
    return catalog.status === 'fallback'
      ? `<div class="mp-foot is-err">
           <span>${esc(catalog.error)}</span>
           <button type="button" class="mp-retry" id="mpRetry">다시 시도</button>
         </div>`
      : `<div class="mp-foot">
           <span>${MODELS.length}개 · pretzel-ai 카탈로그</span>
           <button type="button" class="mp-retry" id="mpRetry">새로고침</button>
         </div>`;
  }

  // Repaint the rows only. Typing and arrowing both come through here rather than through a full
  // render, because replacing the panel would take the search input with it — and an input that is
  // rebuilt on every keystroke loses the caret and, with a Korean IME, drops the syllable being
  // composed. Keeping the input alive is the whole reason this is split in two.
  function renderOptions() {
    const list = document.getElementById('mpOpts');
    if (!list) return;
    list.innerHTML = optionsHtml();

    const panel = document.getElementById('mpList');
    if (panel) {
      panel.setAttribute('aria-activedescendant',
                         picker.active >= 0 ? 'mpOpt' + picker.active : '');
    }
    const slot = document.querySelector('.mp-foot-slot');
    if (slot) slot.innerHTML = footHtml();

    const active = list.querySelector('.mp-opt.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function renderPicker() {
    const el = document.getElementById('modelPicker');
    if (!el) return;
    el.className = 'mp' + (picker.open ? ' is-open' : '');
    el.innerHTML = pickerTrigger() + pickerPanel();
    if (!picker.open) return;

    // The render replaced the focused element. Focus has to be put back inside the picker or the
    // keydown handler below stops seeing arrow keys — the panel would open once and then go deaf.
    const input = document.getElementById('mpSearch');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else {
      const t = document.getElementById('mpTrigger');
      if (t) t.focus();
    }

    const active = el.querySelector('.mp-opt.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function openPicker() {
    if (state.sending) return;
    picker.open = true;
    picker.query = '';
    picker.rows = matchingModels();
    picker.active = Math.max(0, picker.rows.findIndex(m => m.id === state.model));
    renderPicker();
  }

  function closePicker(refocus) {
    if (!picker.open) return;
    picker.open = false;
    picker.query = '';
    picker.active = -1;
    renderPicker();
    if (refocus) { const t = document.getElementById('mpTrigger'); if (t) t.focus(); }
  }

  function choose(id) {
    if (!id || !MODELS.some(m => m.id === id)) return;
    state.model = id;
    save();
    closePicker(true);
  }

  function movePicker(delta) {
    const n = picker.rows.length;
    if (!n) return;
    picker.active = (picker.active + delta + n) % n;
    renderOptions();
  }

  function wirePicker() {
    const el = document.getElementById('modelPicker');
    if (!el) return;

    el.addEventListener('click', (e) => {
      if (e.target.closest('#mpTrigger')) return picker.open ? closePicker(true) : openPicker();
      if (e.target.closest('#mpRetry')) { closePicker(false); return loadCatalog(); }
      const opt = e.target.closest('.mp-opt');
      if (opt) choose(opt.dataset.id);
    });

    el.addEventListener('input', (e) => {
      if (e.target.id !== 'mpSearch') return;
      picker.query = e.target.value;
      picker.rows = matchingModels();
      // Filtering moves the highlight to the top rather than leaving it on a row that scrolled
      // out of the result set — Enter must never commit something the operator cannot see.
      picker.active = picker.rows.length ? 0 : -1;
      renderOptions();
    });

    el.addEventListener('keydown', (e) => {
      if (!picker.open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          if (e.target.closest('#mpTrigger')) { e.preventDefault(); openPicker(); }
        }
        return;
      }
      switch (e.key) {
        case 'Escape':    e.preventDefault(); closePicker(true); break;
        case 'ArrowDown': e.preventDefault(); movePicker(1); break;
        case 'ArrowUp':   e.preventDefault(); movePicker(-1); break;
        case 'Home':      e.preventDefault(); picker.active = 0; renderOptions(); break;
        case 'End':       e.preventDefault(); picker.active = picker.rows.length - 1; renderOptions(); break;
        case 'Tab':       closePicker(false); break;
        case 'Enter':
          e.preventDefault();
          if (picker.rows[picker.active]) choose(picker.rows[picker.active].id);
          break;
        default: break;
      }
    });

    // Clicking anywhere else closes it. Registered once on the document rather than per render,
    // and it does not steal focus back — the operator clicked somewhere for a reason.
    document.addEventListener('pointerdown', (e) => {
      if (picker.open && !e.target.closest('#modelPicker')) closePicker(false);
    });
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  function mount() {
    const root = document.getElementById('contentBody');
    root.innerHTML = `
      <div class="chat-page">
        <div class="chat-rail${state.railOpen ? '' : ' is-hidden'}" id="chatRail">
          <div class="chat-rail-h">
            <button class="chat-new" type="button" id="chatNew">${IC.plus}<span>새 대화</span></button>
          </div>
          <div class="chat-rail-list" id="chatList"></div>
          <div class="chat-rail-f" id="chatStats"></div>
        </div>
        <div class="chat-main">
          <div class="chat-bar">
            <!-- Filled by renderPicker() once the catalog is in; see the model-picker section
                 for why this is not the shared enhanceSelect control. -->
            <div class="mp" id="modelPicker"></div>
          </div>

          <div class="chat-thread" id="chatThread"><div class="chat-col" id="chatCol"></div></div>

          <!-- The scan panel. Rendered empty and hidden until a verdict is opened; renderInspector
               fills it. Previously absent from this markup, which is why "검사 결과 보기" did
               nothing — the renderer looked for an element that was never on the page. -->
          <div class="chat-inspect is-hidden" id="chatInspect"></div>

          <div class="chat-composer">
            <div class="chat-col">
              <div class="chat-box">
                <textarea class="chat-input" id="chatInput" rows="1"
                          placeholder="메시지를 입력하세요"></textarea>
                <button class="chat-send" id="chatSend" type="button" disabled aria-label="Send">${IC.send}</button>
              </div>
              <div class="chat-foot">
                <span><kbd>Enter</kbd> 전송 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄바꿈</span>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    wire();
    wirePicker();
    renderPicker();
    renderRail();
    renderThread();
    // Fired and not awaited: the page is usable while the catalog is in flight, and the picker
    // shows its own loading state rather than the shell holding a blank strip until it lands.
    loadCatalog();
  }

  // ── Rail ───────────────────────────────────────────────────────────────────

  function convoTitle(c) {
    if (c.title) return c.title;
    const first = c.messages.find(m => m.role === 'user');
    if (!first) return 'New chat';
    const t = first.text.replace(/\s+/g, ' ').trim();
    return t.length > 34 ? t.slice(0, 34) + '…' : t;
  }

  function renderRail() {
    const list = document.getElementById('chatList');
    if (!list) return;

    if (!state.convos.length) {
      list.innerHTML = '';
    } else {
      list.innerHTML = `<div class="chat-rail-sec">Conversations</div>` + state.convos.map(c => {
        const flagged = c.messages.some(m => m.scan && m.scan.verdict === 'block');
        return `<div class="chat-convo${c.id === state.activeId ? ' active' : ''}" data-convo="${c.id}">
          ${flagged ? '<span class="chat-convo-flag" data-tip="A turn in this conversation was blocked"></span>' : ''}
          <span class="chat-convo-t">${esc(convoTitle(c))}</span>
          <button class="chat-convo-x" type="button" data-del="${c.id}" aria-label="Delete">${IC.trash}</button>
        </div>`;
      }).join('');
    }

    // `flagged` and `uninspected` are shown only once they happen, but they are the two numbers that
    // actually matter: detected-and-forwarded is enforcement being off, and uninspected is the
    // guardrail not being on the path at all. Both look like a quiet, healthy chat from anywhere else.
    const s = stats();
    document.getElementById('chatStats').innerHTML = `
      <div class="chat-stat-h">이 대화</div>
      <div class="chat-stat"><b>${s.scanned}</b><span>turns scanned</span></div>
      ${s.masked ? `<div class="chat-stat is-mask"><b>${s.masked}</b><span>redacted before egress</span></div>` : ''}
      <div class="chat-stat is-block"><b>${s.blocked}</b><span>blocked</span></div>
      ${s.flagged ? `<div class="chat-stat is-flag"><b>${s.flagged}</b><span>flagged but sent</span></div>` : ''}
      ${s.uninspected ? `<div class="chat-stat is-flag"><b>${s.uninspected}</b><span>not inspected</span></div>` : ''}`;
  }

  function renderGateway() {
    const el = document.getElementById('chatGw');
    if (!el) return;
    const map = {
      unknown: { cls: '', txt: 'not called yet' },
      live:    { cls: ' is-live', txt: 'connected' },
      mock:    { cls: ' is-mock', txt: 'local mock' },
      error:   { cls: ' is-err',  txt: 'failing' },
    };
    const tips = {
      mock:  'No gateway in the path — replies are generated in this browser, not by a model.',
      error: 'The gateway is configured but the last turn failed. Nothing was mocked over it.',
      live:  'The last turn was answered by the gateway through inferd.',
    };
    const m = map[state.gateway] || map.unknown;
    el.className = 'chat-pill' + m.cls;
    el.setAttribute('data-tip', tips[state.gateway] || 'Where the last turn was answered.');
    el.innerHTML = `<span class="chat-dot"></span><span>${GATEWAY}</span><b>${m.txt}</b>`;

    // The profile is not something this page decides — it is whatever AIRS reported on the last
    // turn. Naming a profile the appliance merely intends to use would be the exact failure the
    // lab documents: a console that says the control is on while nothing is inspecting.
    const p = document.getElementById('chatProfile');
    if (p) {
      const known = !!state.profile;
      p.className = 'chat-pill';
      p.innerHTML = `${IC.shield}<span>AIRS</span><b>${esc(known ? state.profile : 'no scan yet')}</b>`;
    }
  }

  // ── Thread ─────────────────────────────────────────────────────────────────

  function renderEmpty() {
    return `<div class="chat-empty">
      <div class="chat-empty-ic">${IC.spark}</div>
      <div class="chat-empty-t">무엇을 도와드릴까요?</div>
    </div>`;
  }

  const VERDICT_LABEL = {
    allow: 'clean',
    mask: 'redacted',
    block: 'blocked',
    // Detected and forwarded anyway — the state a pass/fail badge cannot express, and the one the
    // whole AIRS lab was built to catch. It gets its own word, never "blocked".
    flagged: 'flagged, sent',
    uninspected: 'not inspected',
  };
  const VERDICT_ICON = {
    allow: IC.shieldOk,
    mask: IC.mask,
    block: IC.shieldX,
    flagged: IC.alert,
    uninspected: IC.shieldOff,
  };

  function verdictPill(m) {
    if (!state.badges || !m.scan) return '';
    const v = m.scan.verdict;
    // A clean turn says nothing. The badge exists to mark the exceptions — blocked, redacted,
    // flagged-and-sent, never inspected — and printing "clean" on every ordinary message buries
    // those four under a wall of green that nobody reads by the third turn. The scan is still
    // there for anyone who wants it; it just no longer interrupts a normal conversation.
    if (v === 'allow') return '';
    const cls = ' is-' + v;
    const active = state.inspectId === m.id ? ' active' : '';
    return `<button class="chat-verdict${cls}${active}" type="button" data-scan="${m.id}"
              data-tip="Open the scan for this message">
              ${VERDICT_ICON[v]}<span>AIRS · ${VERDICT_LABEL[v]}</span>
            </button>`;
  }

  // The markdown source is copied, not the rendered text: what the reader wants on the clipboard
  // is the answer as the model wrote it, tables and code fences intact.
  //
  // The async clipboard API needs a secure context, and this console is served over HTTPS with a
  // self-signed certificate on some appliances — where the browser declines, the textarea fallback
  // is the only thing that works, so it is kept rather than assumed unnecessary.
  async function copyText(btn, text) {
    let ok = true;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(String(text || ''));
      } else {
        const ta = document.createElement('textarea');
        ta.value = String(text || '');
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch (_) { ok = false; }

    // Confirmed on the button itself. A toast for something this small is more interruption than
    // the action deserves, and the reader is already looking here.
    const label = btn.querySelector('.chat-copy-t');
    if (!label) return;
    const prev = label.textContent;
    label.textContent = ok ? '복사됨' : '복사 실패';
    btn.classList.add(ok ? 'is-done' : 'is-fail');
    setTimeout(() => {
      label.textContent = prev;
      btn.classList.remove('is-done', 'is-fail');
    }, 1400);
  }

  function renderTurn(m) {
    const time = `<span class="chat-time">${fmtTs(m.ts)}</span>`;

    if (m.kind === 'block') {
      const b = firstBlocker(m.scan);
      // The two directions fail in genuinely different places, and a card that says "not sent to
      // the model" under a blocked ANSWER would describe the wrong half of the round trip.
      const onResponse = m.scan.direction === 'response';
      const title = onResponse ? '모델 응답이 차단되었습니다' : '요청이 차단되었습니다';
      const what = onResponse
        ? '모델이 생성한 답변이 검사에 걸려 전달되지 않았습니다.'
        : '이 내용은 모델로 전달되지 않았습니다.';
      const found = b ? (b.all || [b.cat.label]).join(', ') : 'Policy violation';
      return `<div class="chat-turn is-bot" data-msg="${m.id}">
        <div class="chat-who">Assistant</div>
        <div class="chat-block">
          <div class="chat-block-ic">${IC.shieldX}</div>
          <div class="chat-block-b">
            <div class="chat-block-t">AI Runtime Security · ${title}</div>
            <div class="chat-block-d">${esc(found)}. ${what}</div>
            <button class="chat-block-a" type="button" data-scan="${m.id}">${IC.shield}<span>검사 결과 보기</span></button>
          </div>
        </div>
        <div class="chat-meta">${time}</div>
      </div>`;
    }

    // Not a refusal and not an answer: the turn never reached a model. Deliberately unlike the
    // block card — a security decision and an outage are different events, and an operator reading
    // back through a thread must be able to tell them apart at a glance.
    if (m.kind === 'error') {
      // The distinction the operator needs first: did the security control run? A model that could
      // not answer and a guardrail that never inspected the turn look identical from the chat
      // window, and only one of them is a security problem.
      const scanned = m.scanned
        ? '<div class="chat-fail-n">검사는 정상 수행됨 — 모델 응답 단계에서 실패</div>'
        : '';
      return `<div class="chat-turn is-bot" data-msg="${m.id}">
        <div class="chat-who">Assistant</div>
        <div class="chat-fail">
          <div class="chat-fail-ic">${IC.alert}</div>
          <div class="chat-fail-b">
            <div class="chat-fail-t">응답을 받지 못했습니다</div>
            <div class="chat-fail-d">${esc(m.text)}${m.code ? ` <span class="chat-fail-c">${esc(m.code)}</span>` : ''}</div>
            ${scanned}
          </div>
        </div>
        <div class="chat-meta">${time}</div>
      </div>`;
    }

    // What the corpus returned, before the model saw it. Shown as its own turn rather than
    // folded into the answer, because a retrieval that missed is the failure worth catching —
    // and once an answer is on screen it is far too easy to read the passages as confirming it.
    if (m.kind === 'retrieval') {
      const hits = m.hits || [];
      if (!m.ok) {
        return `<div class="chat-turn is-bot" data-msg="${m.id}">
          <div class="chat-who">Retrieval</div>
          <div class="chat-rag is-warn">
            <div class="chat-rag-h">${IC.book}<span>문서를 찾지 못했습니다</span></div>
            <div class="chat-rag-d">${esc(m.error || '')} — 모델이 문서 없이 답합니다.</div>
          </div>
        </div>`;
      }
      const rows = hits.map((h, i) => `
        <a class="chat-rag-i" href="${esc(h.url)}" target="_blank" rel="noopener">
          <span class="chat-rag-n">${i + 1}</span>
          <span class="chat-rag-b">
            <span class="chat-rag-t">${esc(h.title)}</span>
            <span class="chat-rag-m">${esc(h.docset || '')}${h.version ? ` · v${esc(h.version)}` : ''} · ${(h.score * 100).toFixed(1)}%</span>
          </span>
        </a>`).join('');
      return `<div class="chat-turn is-bot" data-msg="${m.id}">
        <div class="chat-who">Retrieval</div>
        <div class="chat-rag">
          <div class="chat-rag-h">${IC.book}<span>문서 ${hits.length}건을 찾았습니다</span>
            <b>${m.took_ms}ms</b></div>
          <div class="chat-rag-l">${rows || '<div class="chat-rag-d">관련도 기준을 넘은 문서가 없습니다.</div>'}</div>
        </div>
        <div class="chat-meta">${time}</div>
      </div>`;
    }

    // The handoff, said out loud. Without it the passages and the answer read as one step, and
    // the operator cannot tell whether what reached the model is what they just looked at.
    if (m.kind === 'handoff') {
      return `<div class="chat-turn is-bot" data-msg="${m.id}">
        <div class="chat-hand">
          <span class="chat-hand-l"></span>
          <span class="chat-hand-t">${esc(m.text)}</span>
          <span class="chat-hand-l"></span>
        </div>
      </div>`;
    }

    if (m.kind === 'wait') {
      return `<div class="chat-turn is-bot" data-msg="${m.id}">
        <div class="chat-who">Assistant</div>
        <div class="chat-bubble"><span class="chat-wait">
          <span class="chat-dots"><i></i><i></i><i></i></span>${esc(m.text)}</span></div>
      </div>`;
    }

    const who = m.role === 'user' ? 'You' : 'Assistant';
    const body = m.typing ? '' : renderText(m.text);
    // Offered only once the text is final. A copy button on a message still streaming in would
    // hand over half an answer, which is worse than no button at all.
    const copy = m.typing ? '' :
      `<button class="chat-copy" type="button" data-copy="${m.id}"
               data-tip="Copy">${IC.copy}<span class="chat-copy-t">복사</span></button>`;
    return `<div class="chat-turn is-${m.role === 'user' ? 'user' : 'bot'}" data-msg="${m.id}">
      <div class="chat-who">${who}</div>
      <div class="chat-bubble" data-body="${m.id}">${body}</div>
      <div class="chat-meta">${verdictPill(m)}${time}${copy}</div>
    </div>`;
  }

  // Rewriting the thread's HTML drops the scroll position, so it is decided here rather than left
  // to the browser. `keepScroll` is for repaints the reader did not ask for (opening a scan panel,
  // toggling badges) — those must not yank the view; a new message follows only if the reader was
  // already at the bottom, which is the difference between a live thread and one that fights you
  // while you read back through it.
  function renderThread(keepScroll) {
    const col = document.getElementById('chatCol');
    const thread = document.getElementById('chatThread');
    if (!col || !thread) return;

    const prevTop = thread.scrollTop;
    const pinned = atBottom();

    const c = activeConvo();
    const empty = (!c || !c.messages.length);
    col.innerHTML = empty ? renderEmpty() : c.messages.map(renderTurn).join('');

    // With no thread yet, the composer sits vertically centered rather than pinned to the
    // bottom; once the first turn lands it drops to its normal place. See .chat-main.is-empty.
    const main = document.querySelector('.chat-main');
    if (main) main.classList.toggle('is-empty', empty);

    if (keepScroll) thread.scrollTop = prevTop;
    else if (pinned || !c || !c.messages.length) scrollToEnd();
    else thread.scrollTop = prevTop;

    renderInspector();
  }

  function atBottom() {
    const t = document.getElementById('chatThread');
    if (!t) return true;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 90;
  }

  function scrollToEnd() {
    const t = document.getElementById('chatThread');
    if (t) t.scrollTop = t.scrollHeight;
  }

  // ── Inspector ──────────────────────────────────────────────────────────────

  function kv(k, v, mono) {
    return `<div class="chat-kv"><div class="chat-kv-k">${esc(k)}</div>` +
           `<div class="chat-kv-v${mono ? ' mono' : ''}">${esc(v)}</div></div>`;
  }

  function renderInspector() {
    const el = document.getElementById('chatInspect');
    if (!el) return;

    const m = state.inspectId ? findMessage(state.inspectId) : null;
    if (!m || !m.scan) {
      el.className = 'chat-inspect is-hidden';
      el.innerHTML = '';
      return;
    }

    const sc = m.scan;
    const dirLabel = sc.direction === 'response' ? 'Response → user' : 'User → model';
    const model = MODELS.find(x => x.id === (m.route && m.route.model)) || null;

    const airs = sc.source === 'airs';
    const onResponse = sc.direction === 'response';

    // What each verdict means, and it is not the same sentence in the two directions — a panel that
    // said "went upstream unchanged" under an answer would be describing the wrong half of the trip.
    const VERDICT_TITLE = {
      allow: 'Allowed', mask: 'Allowed with redaction', block: 'Blocked',
      flagged: 'Detected, forwarded anyway', uninspected: 'Not inspected',
    };
    const verdictCopy = onResponse ? {
      allow: 'AIRS inspected the answer and found nothing.',
      mask:  'Identifiers in the answer were replaced before it reached the user.',
      block: 'The answer was withheld. It was never shown.',
      flagged: 'AIRS flagged the answer and it was delivered anyway.',
      uninspected: 'No guardrail ran on the response direction.',
    } : {
      allow: 'AIRS inspected the turn and found nothing. It went upstream unchanged.',
      mask:  'Identifiers were replaced before the text left the appliance.',
      block: 'The guardrail denied the turn. The model never saw it.',
      flagged: 'AIRS flagged this and the gateway forwarded it to the model regardless.',
      uninspected: 'The response carried no guardrail result at all.',
    };

    let cats = '';
    if (airs && !sc.present) {
      // The most consequential thing this panel can say. An absent guardrail and a clean prompt
      // look identical in a chat window, and only one of them means the control is off.
      cats = `<div class="chat-ins-empty">
        This response carried no <code>hook_results</code>.<br>
        Either no guardrail is attached to this call's path, or it is configured
        <b>async</b> — in which case its findings go to the gateway's logs only and it can never deny.
      </div>`;
    } else if (airs) {
      for (const c of sc.categories) {
        cats += `<div class="chat-cat${c.hit ? ' is-hit sev-block' : ''}">
          <span class="chat-cat-ic">${c.hit ? IC.alert : IC.check}</span>
          <span class="chat-cat-n">${esc(c.label)}</span>
          <span class="chat-cat-v">${c.hit ? 'detected' : ''}</span>
        </div>`;
      }
      if (!sc.categories.length) {
        cats = `<div class="chat-ins-empty">The guardrail ran but reported no categories.</div>`;
      }
    } else {
      for (const c of sc.categories) {
        const hit = c.findings.length > 0;
        const sev = c.action ? ' sev-' + c.action : '';
        cats += `<div class="chat-cat${hit ? ' is-hit' : ''}${sev}">
          <span class="chat-cat-ic">${hit ? (c.action === 'block' ? IC.alert : IC.mask) : IC.check}</span>
          <span class="chat-cat-n">${esc(c.label)}</span>
          <span class="chat-cat-v">${hit ? (c.action === 'block' ? 'blocked' : 'redacted') : ''}</span>
        </div>`;
        if (hit) {
          for (const f of c.findings) {
            cats += `<div class="chat-hit">
              <div class="chat-hit-w"><b>${esc(f.name)}</b> — ${esc(f.why)}</div>
              <div class="chat-hit-m"><div class="chat-hit-i">${esc(f.sample)}</div></div>
            </div>`;
          }
        }
      }
    }

    // Masking is computed whenever DLP matches, but applying it is a separate decision. Saying which
    // one happened matters: a mask that was computed and not applied means the ORIGINAL text is what
    // went upstream, which is the opposite of what "masked" suggests.
    let outbound = '';
    if (airs && sc.masked) {
      outbound = `<div class="chat-ins-sec">Masking</div>` +
        kv('Applied', sc.masked.applied ? 'yes — this is what was sent'
                                        : 'NO — computed only; the original was sent') +
        (sc.masked.patterns.length ? kv('Patterns', sc.masked.patterns.join(', ')) : '') +
        `<div class="chat-ins-out">${esc(sc.masked.text)}</div>`;
    } else if (!airs && sc.verdict === 'mask' && sc.outbound != null) {
      outbound = `<div class="chat-ins-sec">${onResponse ? 'Delivered to the user' : 'Sent upstream'}</div>
        <div class="chat-ins-out">${renderText(sc.outbound)
          .replace(/<span class="chat-redact">([^<]*)<\/span>/g, '<mark>$1</mark>')}</div>`;
    }

    let scanRows = '';
    if (airs) {
      scanRows =
        kv('Source', 'Prisma AIRS (gateway hook)') +
        kv('Profile', sc.profile || '—') +
        kv('Direction', sc.direction) +
        (sc.action ? kv('AIRS action', sc.action) : '') +
        // The two switches from the lab README, in two different products. Both have to be right,
        // and a profile set to Block with deny off produces a perfect verdict and no enforcement.
        kv('Enforced', sc.enforced ? 'yes — the gateway denied it' : 'no') +
        kv('Async', sc.async ? 'yes — cannot deny, logs only' : 'no') +
        (sc.timeout ? kv('Timeout', 'yes — the AIRS call timed out') : '') +
        (sc.error ? kv('Errored', 'yes') : '') +
        kv('Scan ID', sc.scanId || '—', true) +
        (sc.reportId ? kv('Report ID', sc.reportId, true) : '') +
        kv('Scan latency', sc.latencyMs + ' ms');
    } else {
      scanRows =
        kv('Source', 'local mock (no gateway)') +
        kv('Profile', sc.profile) +
        kv('Direction', sc.direction) +
        kv('Scan ID', sc.id, true) +
        kv('Scan latency', sc.latencyMs + ' ms') +
        kv('Scanned at', fmtTs(sc.at));
    }

    let routing = '';
    if (m.route) {
      const gwModel = MODELS.find(x => x.id === m.route.model) || null;
      routing = `<div class="chat-ins-sec">Routing</div>` +
        kv('Gateway', GATEWAY) +
        kv('Provider', gwModel ? gwModel.provider : '—') +
        kv('Model', m.route.model) +
        kv('Tokens', `${m.route.tokensIn} in · ${m.route.tokensOut} out`) +
        kv('Latency', m.route.latencyMs + ' ms') +
        kv('Answered by', m.route.source === 'gateway' ? 'the AI gateway' : 'local mock');
    }

    el.className = 'chat-inspect';
    el.innerHTML = `
      <div class="chat-ins-h">
        <div>
          <div class="chat-ins-t">Scan detail</div>
          <div class="chat-ins-sub">${esc(dirLabel)}</div>
        </div>
        <button class="chat-ins-x" type="button" id="chatInsX" aria-label="Close">${IC.x}</button>
      </div>
      <div class="chat-ins-b">
        <div class="chat-ins-verdict is-${sc.verdict}">
          ${VERDICT_ICON[sc.verdict] || IC.shield}
          <div>
            <div class="chat-ins-vt">${VERDICT_TITLE[sc.verdict] || sc.verdict}</div>
            <div class="chat-ins-vd">${esc(verdictCopy[sc.verdict] || '')}</div>
          </div>
        </div>

        <div class="chat-ins-sec">Scan</div>
        ${scanRows}

        <div class="chat-ins-sec">Categories</div>
        <div class="chat-cats">${cats}</div>

        ${outbound}
        ${routing}
      </div>`;

    document.getElementById('chatInsX').addEventListener('click', () => {
      state.inspectId = '';
      renderThread(true);
    });
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const tokensOf = (s) => Math.max(1, Math.round(s.length / 3.1));

  // Post, then poll. The turn is not answered on the POST: mgmtd hands it to inferd and returns a
  // ticket, because the gateway round trip takes seconds and mgmtd builds its responses on the loop
  // every other daemon's IPC arrives on. Holding the POST open would hold that loop.
  //
  // Two kinds of failure, and the difference is the whole point of the flag. `fallback` means there
  // is no gateway in the path at all — no route deployed, no gateway configured — and the local mock
  // is the honest answer. Anything else is a REAL failure of a REAL gateway, and quietly mocking over
  // it would be the one thing this page must never do: present a made-up answer as a live one.
  function gwError(message, code, fallback) {
    const e = new Error(message);
    e.code = code || '';
    e.fallback = !!fallback;
    return e;
  }

  // Returns the finished turn document from inferd — ok or not — because the interesting failures
  // carry a scan too. A blocked prompt and a provider that ran out of credit are both `ok:false`,
  // and both were inspected; only a missing gateway throws, so the mock can take over.
  // The turns already on screen, in the shape pretzel-ai's ChatRequest.history expects. Only the
  // plain text ones: block cards, enforcement notices and retrieval cards are this console's own
  // furniture, and replaying them as things the person or the model said would put words in both
  // their mouths. A turn the guardrail denied never reached the model, so the model must not be
  // told it did.
  function historyFor(c) {
    if (!c || !Array.isArray(c.messages)) return [];
    return c.messages
      .filter(m => m.kind === 'text' && (m.role === 'user' || m.role === 'assistant') && m.text)
      .map(m => ({ role: m.role, content: String(m.text) }));
  }

  async function askServer(text, model, onRetrieval, history, sessionId, onDelta) {
    let res;
    try {
      res = await fetch(CHAT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, message: text, rag: state.rag, k: state.topK,
          history: history || [],
          // The conversation id doubles as the AIRS session id — pretzel-ai forwards it to the
          // gateway, which passes it to Prisma AIRS as tr_id. Sent per turn because it is what
          // makes a thread one session in the AIRS console rather than N unrelated scans.
          session_id: sessionId || '',
        }),
      });
    } catch (_) {
      throw gwError('mgmtd could not be reached', 'OFFLINE', true);
    }

    if (res.status === 404) throw gwError('no /api/chat route on this appliance', 'NO_ROUTE', true);
    if (!res.ok) throw gwError('mgmtd refused the turn (HTTP ' + res.status + ')', 'HTTP_' + res.status, false);

    const start = await res.json().catch(() => null);
    const ticket = start && start.ticket;
    if (!ticket) throw gwError('mgmtd returned no ticket', 'BAD_TICKET', false);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      await wait(POLL_MS);
      if (Date.now() > deadline) throw gwError('the gateway did not answer in time', 'TIMEOUT', false);

      let d = null;
      try {
        const r = await fetch(`${CHAT_RESULT_URL}?ticket=${ticket}`, { credentials: 'same-origin' });
        if (r.ok) d = await r.json();
      } catch (_) { /* a dropped poll is not a failed turn — the next one asks again */ }

      // The passages land a poll or two before the answer on a grounded turn. Handed over the
      // moment they arrive: the reader is meant to judge what was retrieved while the model is
      // still working, not to have it appear retroactively underneath a finished answer.
      if (d && d.retrieval && onRetrieval) { onRetrieval(d.retrieval); onRetrieval = null; }

      // The answer as far as it has been written. Cumulative, so this replaces rather than
      // appends — a dropped poll then costs one beat of latency, where appending would silently
      // lose whatever that poll was carrying and leave a hole mid-sentence.
      if (d && d.status === 'pending' && d.text && onDelta) onDelta(d.text);

      if (!d || d.status !== 'done') continue;

      // Only "there is no gateway here" falls back to the mock. Everything else — a denial, a dry
      // provider, a bad response — is a real answer about a real gateway and belongs on screen.
      if (!d.ok && (d.code === 'NOT_CONFIGURED' || d.code === 'NO_ROUTE')) {
        throw gwError(d.error || 'no AI gateway is configured', d.code, true);
      }

      return d;
    }
  }

  // ── AIRS verdicts ──────────────────────────────────────────────────────────
  // The gateway's scan, in the shape the inspector already renders. The category ids are AIRS's
  // own and arrive verbatim from inferd — including ones not listed here, which is the point: a
  // category Palo Alto adds later shows up under a prettified id rather than vanishing.
  const AIRS_LABELS = {
    injection:      'Prompt Injection',
    dlp:            'Sensitive Data (DLP)',
    url_cats:       'Malicious URL',
    toxic_content:  'Toxic Content',
    malicious_code: 'Malicious Code',
    source_code:    'Source Code',
    db_security:    'Database Security',
    agent:          'Agent Behaviour',
  };

  const labelFor = (id) =>
    AIRS_LABELS[id] || String(id || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // inferd's normalised scan → the shape renderTurn/renderInspector consume. Kept as a translation
  // rather than by making the UI speak two dialects: the mock and the gateway then stay renderable
  // by exactly one set of code, and there is one place to look when they disagree.
  function airsScan(scan, direction) {
    if (!scan || !scan.present) {
      // No hook_results at all. This is a FINDING, not an absence of one — it means the guardrail
      // was not on this call's path (or is async and can never deny), which is indistinguishable
      // from "nothing was wrong" unless it is said out loud.
      return {
        source: 'airs', present: false, direction,
        verdict: 'uninspected', profile: '', scanId: '', latencyMs: 0,
        categories: [], masked: null,
      };
    }

    const cats = (scan.categories || []).filter(c => c && c.direction === direction);

    // Collapse duplicates: several checks can report the same category, and a hit anywhere wins.
    const byId = new Map();
    for (const c of cats) {
      const prev = byId.get(c.id);
      if (!prev || (!prev.hit && c.hit)) byId.set(c.id, { id: c.id, hit: !!c.hit });
    }

    return {
      source: 'airs',
      present: true,
      direction,
      // "flagged" is the state a boolean would hide: AIRS found something and the gateway forwarded
      // it anyway. It must never be drawn as a block.
      verdict: scan.verdict || 'allow',
      enforced: !!scan.enforced,
      async: !!scan.async,
      action: scan.action || '',
      profile: scan.profile || '',
      profileId: scan.profile_id || '',
      scanId: scan.scan_id || '',
      reportId: scan.report_id || '',
      latencyMs: scan.latency_ms | 0,
      timeout: !!scan.timeout,
      error: !!scan.error,
      categories: Array.from(byId.values())
        .map(c => ({ id: c.id, label: labelFor(c.id), hit: c.hit }))
        .sort((a, b) => (b.hit - a.hit) || a.label.localeCompare(b.label)),
      masked: scan.masked
        ? { text: scan.masked.text || '', patterns: scan.masked.patterns || [], applied: !!scan.masked.applied }
        : null,
      at: Date.now(),
    };
  }

  async function send(raw) {
    const text = raw.trim();
    if (!text || state.sending) return;

    state.sending = true;
    renderPicker();
    setSendEnabled();

    let c = activeConvo();
    if (!c) { c = newConvo(); renderRail(); }

    const now = Date.now();
    // Snapshotted BEFORE this turn joins the thread: history is what came before, and pushing
    // first would send the question twice — once as the last history entry and once as the turn.
    const history = historyFor(c);
    const userMsg = { id: randId('m_', 10), role: 'user', kind: 'text', text, ts: now };
    c.messages.push(userMsg);
    c.updatedAt = now;

    // The scan is a step the operator should see happen, not a hidden pause before the answer —
    // this placeholder is what distinguishes "being inspected" from "being thought about".
    const waitMsg = { id: randId('m_', 10), role: 'assistant', kind: 'wait',
      text: state.rag ? '문서를 검색하는 중' : '게이트웨이에서 검사 중', ts: Date.now() };
    c.messages.push(waitMsg);
    renderThread();
    save();

    const drop = () => { const i = c.messages.indexOf(waitMsg); if (i >= 0) c.messages.splice(i, 1); };
    const t0 = Date.now();

    // The gateway gets the text as typed. Redacting it here first would be theatre: AIRS is what
    // decides whether anything needs masking, and a prompt pre-chewed by a browser heuristic would
    // hide from the scanner the very thing the scanner exists to find.
    let turn = null;
    // Declared out here so the catch below can clear a half-streamed answer too: a turn that died
    // mid-sentence must not leave its fragment sitting above the failure notice as if it were one.
    let liveMsg = null;
    let streamer = null;
    let streamed = false;   // kept for the catch path below
    try {
      // Fires once, the moment the passages land — before the model has answered. The wait
      // bubble is re-pointed rather than removed: the turn is still in flight, just in a
      // different phase, and dropping it would read as the answer having arrived.
      const onRetrieval = (r) => {
        const i = c.messages.indexOf(waitMsg);
        const cards = [
          { id: randId('m_', 10), role: 'assistant', kind: 'retrieval', ts: Date.now(),
            ok: r.ok !== false, hits: r.hits || [], took_ms: r.took_ms || 0, error: r.error || '' },
          { id: randId('m_', 10), role: 'assistant', kind: 'handoff', ts: Date.now(),
            text: (r.hits && r.hits.length)
              ? `위 문서 ${r.hits.length}건을 프롬프트에 넣어 모델에 전달합니다`
              : '문서 없이 모델에 전달합니다' },
        ];
        if (i >= 0) c.messages.splice(i, 0, ...cards); else c.messages.push(...cards);
        waitMsg.text = '모델이 답변을 작성하는 중';
        renderThread();
        save();
      };

      // The answer as it is written. The wait bubble is replaced by a real assistant turn the
      // first time text arrives — from then on the reader is watching the answer appear, which is
      // the point of streaming it. It stays `typing` until the turn resolves, so neither the copy
      // button nor the verdict pill offers itself over a half-finished answer.
      const onDelta = (soFar) => {
        if (!liveMsg) {
          drop();
          streamed = true;
          liveMsg = { id: randId('m_', 10), role: 'assistant', kind: 'text',
                      text: '', ts: Date.now(), typing: true };
          c.messages.push(liveMsg);
          renderThread();                      // creates the bubble the streamer writes into
          streamer = streamInto(liveMsg);
        }
        streamer.push(soFar);
      };

      turn = await askServer(text, state.model, state.rag ? onRetrieval : null, history, c.id, onDelta);

      // A turn that streamed but did not end with an answer — blocked on the response side, or an
      // upstream error after the first tokens — must not leave its fragment on screen. The branch
      // below replaces it with the card that says what actually happened.
      if (liveMsg && !(turn.ok && typeof turn.reply === 'string')) {
        const i = c.messages.indexOf(liveMsg);
        if (i >= 0) c.messages.splice(i, 1);
        liveMsg = null;
        streamer = null;
        streamed = false;
      }
      state.gateway = turn.ok ? 'live' : (turn.code === 'BLOCKED' ? 'live' : 'error');
    } catch (e) {
      // Whatever had streamed goes with the failure. Half an answer left above an error card
      // reads as an answer that was given and then retracted, which is not what happened.
      if (liveMsg) { const i = c.messages.indexOf(liveMsg); if (i >= 0) c.messages.splice(i, 1); }
      liveMsg = null;
      if (!e.fallback) {
        drop();
        state.gateway = 'error';
        renderGateway();
        c.messages.push({
          id: randId('m_', 10), role: 'assistant', kind: 'error',
          text: e.message, code: e.code, ts: Date.now(),
        });
        finish(c);
        return;
      }
      state.gateway = 'mock';
    }
    renderGateway();

    // ── The gateway answered ────────────────────────────────────────────────
    if (turn) {
      const promptScan = airsScan(turn.scan, 'prompt');
      userMsg.scan = promptScan;
      if (promptScan.profile) { state.profile = promptScan.profile; renderGateway(); }
      drop();

      if (turn.code === 'BLOCKED') {
        c.messages.push({
          id: randId('m_', 10), role: 'assistant', kind: 'block',
          text: '', ts: Date.now(), scan: promptScan,
        });
        finish(c);
        return;
      }

      // Inspected and allowed, but no answer came back — today that is both providers being out of
      // credit. Reported as its own state rather than as a security event or a dead gateway, since
      // it is neither: the guardrail did its job and the model was never the problem.
      if (!turn.ok) {
        c.messages.push({
          id: randId('m_', 10), role: 'assistant', kind: 'error',
          text: turn.error || 'the model did not answer', code: turn.code || 'GATEWAY_ERROR',
          upstream: turn.upstream_type || '', scanned: promptScan.present, ts: Date.now(),
        });
        finish(c);
        return;
      }

      const respScan = airsScan(turn.scan, 'response');
      const route = {
        model: state.model,
        tokensIn: turn.tokens_in | 0,
        tokensOut: turn.tokens_out | 0,
        latencyMs: (turn.latency_ms | 0) || (Date.now() - t0),
        source: 'gateway',
      };
      // A response-direction scan only exists if the gateway ran one; when after_request_hooks is
      // empty there is nothing to show, and an empty verdict pill would imply a check that never ran.
      const scanOrNull = respScan.present ? respScan : null;

      // The message that streamed is the message that stays. Finishing it in place — rather than
      // dropping it and pushing an identical one — is what keeps the answer from flickering out
      // and back at the exact moment the reader reaches the end of it.
      if (liveMsg && streamer) {
        liveMsg.scan = scanOrNull;
        liveMsg.route = route;
        await streamer.end(String(turn.reply || ''));
        renderThread(true);        // repaint once, now that the pill and copy button apply
        finish(c);
        return;
      }

      const botMsg = {
        id: randId('m_', 10), role: 'assistant', kind: 'text',
        text: String(turn.reply || ''), ts: Date.now(),
        scan: scanOrNull,
        typing: true,
        route,
      };
      c.messages.push(botMsg);
      renderThread();
      await typeOut(botMsg);
      finish(c);
      return;
    }

    // ── No gateway: the local mock answers, and says so ─────────────────────
    const promptScan = scan(text, 'prompt');
    await wait(320 + promptScan.latencyMs);
    userMsg.scan = promptScan;

    if (promptScan.verdict === 'block') {
      drop();
      c.messages.push({
        id: randId('m_', 10), role: 'assistant', kind: 'block',
        text: '', ts: Date.now(), scan: promptScan,
      });
      finish(c);
      return;
    }

    const outbound = promptScan.outbound != null ? promptScan.outbound : text;
    waitMsg.text = '모델 응답 생성 중';
    renderThread();

    await wait(420 + Math.random() * 400);
    const reply = mockReply(outbound);

    const respScan = scan(reply, 'response');
    drop();

    if (respScan.verdict === 'block') {
      c.messages.push({
        id: randId('m_', 10), role: 'assistant', kind: 'block',
        text: '', ts: Date.now(), scan: respScan,
      });
      finish(c);
      return;
    }

    const delivered = respScan.outbound != null ? respScan.outbound : reply;
    const botMsg = {
      id: randId('m_', 10), role: 'assistant', kind: 'text',
      text: delivered, ts: Date.now(), scan: respScan, typing: true,
      route: {
        model: state.model,
        tokensIn: tokensOf(outbound), tokensOut: tokensOf(delivered),
        latencyMs: Date.now() - t0, source: 'mock',
      },
    };
    c.messages.push(botMsg);
    renderThread();
    await typeOut(botMsg);

    finish(c);
  }

  function finish(c) {
    c.updatedAt = Date.now();
    // Newest thread first, matching every other message list an operator has used.
    state.convos.sort((a, b) => b.updatedAt - a.updatedAt);
    state.sending = false;
    renderPicker();
    save();
    renderRail();
    renderThread();
    setSendEnabled();
    // The composer was disabled for the duration of the turn, which takes the caret with it. Put it
    // back, or every second question starts with a click.
    const input = document.getElementById('chatInput');
    if (input && !input.disabled) input.focus();
  }

  // Reveal the answer progressively. Not decoration: a wall of text appearing whole reads as a
  // canned page, and the pace is what tells the reader the answer is arriving rather than stuck.
  // A live answer, written the way every chat UI writes one: text appears as it arrives, and when
  // the source runs ahead the display catches up smoothly instead of jumping. One renderer covers
  // both cases on purpose — a source that trickles and a source that dumps its whole answer at
  // once produce the same reading experience, so how fast the gateway happens to answer is not
  // something the reader has to look at.
  //
  // The bubble is written directly rather than through renderThread(): a full thread repaint every
  // 16ms would re-render every earlier message to animate the last one.
  function streamInto(msg, onGrow) {
    let full = '';
    let done = false;
    let resolveEnd = null;
    let timer = null;
    let carry = 0;   // fractional characters owed from the previous frame
    const instant = !!(window.matchMedia &&
                       window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    const paint = () => {
      const el = document.querySelector(`[data-body="${msg.id}"]`);
      if (!el) return;
      const pinned = atBottom();
      el.innerHTML = renderText(msg.text) +
                     (msg.text.length < full.length || !done ? '<span class="chat-caret"></span>' : '');
      if (pinned) scrollToEnd();
      if (onGrow) onGrow();
    };

    const tick = () => {
      const backlog = full.length - msg.text.length;
      if (backlog > 0) {
        // Paced by reading speed, not by how much text is waiting.
        //
        // The obvious rule — drain a fixed share of the backlog each frame — is wrong here, and
        // measurably so: it makes a long answer appear FASTER than a short one (3,000 characters
        // came out at ~3,300/s, which is not reading, it is a page-load). Rate is derived from the
        // answer's length instead, so every answer arrives at a speed a person can follow.
        //
        // Be clear about what this is. The gateway call is not streaming — the response-side
        // guardrail has to see the whole answer to rule on it, so by the time the first character
        // is drawn the last one already exists. This paces a finished answer. It is presentation,
        // not transport, and the honest reason to do it is that the alternative is a four-second
        // blank followed by a wall of text.
        // Someone who has asked their system not to animate things gets the answer, not a show.
        const cps = instant ? Infinity
                            : Math.max(READ_CPS, full.length / (MAX_STREAM_MS / 1000));
        carry += cps * (FRAME_MS / 1000);
        const step = Math.min(backlog, Math.max(1, Math.floor(carry)));
        carry -= step;
        msg.text = full.slice(0, msg.text.length + step);
        paint();
      } else if (done) {
        msg.typing = false;
        timer = null;
        paint();
        if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); }
        return;
      }
      timer = setTimeout(tick, 16);
    };

    return {
      // Cumulative text from the server: the newest snapshot replaces the target outright, so a
      // dropped poll costs a beat of latency and never a hole in the middle of a sentence.
      push(soFar) {
        if (typeof soFar !== 'string' || soFar.length <= full.length) return;
        full = soFar;
        if (!timer) timer = setTimeout(tick, 0);
      },
      // Called with the final text once the turn resolves. Anything the display has not caught up
      // to yet is still drained rather than snapped in, so the answer never ends with a lurch.
      end(finalText) {
        if (typeof finalText === 'string' && finalText.length >= full.length) full = finalText;
        done = true;
        if (!timer) timer = setTimeout(tick, 0);
        return new Promise(resolve => {
          if (!timer && msg.text.length >= full.length) { msg.typing = false; paint(); return resolve(); }
          resolveEnd = resolve;
        });
      },
      get text() { return full; },
    };
  }

  function typeOut(msg) {
    return new Promise(resolve => {
      const el = document.querySelector(`[data-body="${msg.id}"]`);
      if (!el) { msg.typing = false; return resolve(); }

      const total = msg.text.length;
      const step = Math.max(2, Math.ceil(total / 90));
      let i = 0;
      const tick = () => {
        i = Math.min(total, i + step);
        const pinned = atBottom();
        el.innerHTML = renderText(msg.text.slice(0, i)) +
                       (i < total ? '<span class="chat-caret"></span>' : '');
        if (pinned) scrollToEnd();
        if (i >= total) { msg.typing = false; return resolve(); }
        setTimeout(tick, 16);
      };
      tick();
    });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  function setSendEnabled() {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('chatSend');
    if (!input || !btn) return;
    btn.disabled = state.sending || !input.value.trim();
    input.disabled = state.sending;
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 168) + 'px';
  }

  function wire() {
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSend');

    const submit = () => {
      const v = input.value;
      input.value = '';
      autoGrow(input);
      setSendEnabled();
      send(v).catch(() => { state.sending = false; renderPicker(); setSendEnabled(); });
    };

    input.addEventListener('input', () => { autoGrow(input); setSendEnabled(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    sendBtn.addEventListener('click', submit);

    document.getElementById('chatCol').addEventListener('click', (e) => {
      const sug = e.target.closest('[data-sug]');
      if (sug) {
        input.value = sug.dataset.sug;
        autoGrow(input);
        setSendEnabled();
        submit();
        return;
      }
      // Read out of the DOM rather than from a stored copy: what lands on the clipboard is then,
      // by construction, the code the reader is looking at.
      const cc = e.target.closest('[data-codecopy]');
      if (cc) {
        const wrap = cc.closest('.chat-code');
        const code = wrap && wrap.querySelector('code');
        if (code) copyText(cc, code.textContent);
        return;
      }
      const cp = e.target.closest('[data-copy]');
      if (cp) {
        const msg = findMessage(cp.dataset.copy);
        if (msg) copyText(cp, msg.text);
        return;
      }
      const pill = e.target.closest('[data-scan]');
      if (pill) {
        const id = pill.dataset.scan;
        state.inspectId = (state.inspectId === id) ? '' : id;
        renderThread(true);
      }
    });

    document.getElementById('chatNew').addEventListener('click', () => {
      if (state.sending) return;   // a turn in flight belongs to the thread that sent it
      startNewChat();
    });

    document.getElementById('chatList').addEventListener('click', (e) => {
      if (state.sending) return;
      // Delete is checked first: its button sits inside the row, so a click on it is also a click
      // on the row, and selecting a thread on the way to removing it would repaint twice.
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        deleteConvo(del.dataset.del);
        return;
      }
      const row = e.target.closest('[data-convo]');
      if (row) selectConvo(row.dataset.convo);
    });

    // The topbar's refresh means "repaint from what is stored" here; there is nothing to re-fetch.
    window.NMS.onRefresh(() => {
      if (state.sending) return;
      load();
      renderRail();
      renderThread();
      loadCatalog();
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    load();
    if (!state.convos.length) newConvo();
    if (!activeConvo()) state.activeId = state.convos[0].id;
    mount();
    document.getElementById('chatInput').focus();
  });
}());
