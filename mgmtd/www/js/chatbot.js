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
 * POST /api/chat → mgmtd → pretzel-ai → the vendor. The verdicts drawn here are AIRS's own, read out
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
 * Conversations live in localStorage: this browser, this machine. Every read and write goes
 * through `threads` below, which is the seam the server-side store will be dropped into — see the
 * note on it for what that needs and what is still undecided.
 */
(function () {
  'use strict';

  const esc = (s) => window.NMS.utils.esc(s);
  const fmtTs = (v) => window.NMS.utils.fmtTs(v);

  // Threads live in this browser only — there is no server-side thread store yet. That makes them
  // the signed-in person's data sitting on a shared appliance console, so the key is registered for
  // clearing at logout; without that, the next person to sign in on this machine opens the rail
  // and reads the previous one's conversations, scan verdicts and all.
  //
  // ── Where this is going ─────────────────────────────────────────────────────────────────────
  // Threads move to the appliance database, so they survive a browser and follow the person rather
  // than the machine. The shape that decision already fixed:
  //
  //   chat_thread   (oid, owner, service 'chat'|'agent', title, model, created_at, updated_at)
  //   chat_message  (oid, thread, seq, role, content, model, ok, code, latency_ms, scan, created_at)
  //
  // State, not configuration — so it lives beside api_collection rather than in running_config,
  // engined is the only writer (new IPC Writes), and mgmtd reads for the list and the history.
  // Visibility is the author's own threads only.
  //
  // What is NOT decided, and has to be before any of it is built:
  //   * what `owner` is. A local login is one row today, but SAML makes it many: a subject id
  //     breaks every thread when the IdP reissues one, and a username hands the previous holder's
  //     history to whoever is created with that name next.
  //   * what happens to a person's threads when their account goes.
  //   * retention — api_collection prunes bodies on a window; a conversation probably should too.
  //
  // Until then: every read and write goes through `threads` below and nothing else touches
  // localStorage, so the swap is one object rather than a search through this file. The interface
  // is already async for the same reason — a server-backed store cannot be made synchronous later
  // without touching every caller.
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

  // ── What the wait bubble says, and in what order ────────────────────────────
  //
  // A turn is not one wait, it is four, and they fail in different places: the hop to the gateway,
  // the request-side guardrail, the model itself, and the response-side guardrail. "검사 중" for
  // all four tells the operator nothing and, for three of them, is not even true.
  //
  // Each leg carries its own icon, because the icon is what identifies the state at a glance —
  // the label is what confirms it. The two guardrail legs deliberately share both: it IS the same
  // control, run twice, and giving them different faces would imply two different checks.
  //
  // WHERE THE STAGE COMES FROM, and what is actually known. Only `gw` is observed today: the POST
  // is in flight, that is a fact. The rest are ESTIMATED on a timer, because /api/chat/result
  // answers {status:"pending", text} and nothing else — prompt-scan, inference and response-scan
  // are one indistinguishable window from the browser. askServer hands `d.stage` straight through
  // whenever the poll carries one, so the day the pending poll reports a stage
  // (ChatChunk.stage → mgmtd chatStage(ticket) → this field) these become observed rather than
  // guessed, with no change on this side.
  const STAGES = {
    gw:    { label: '게이트웨이 처리 중…',  icon: 'transit' },
    scan:  { label: '가드레일 검사 중…',    icon: 'shield'  },   // AIRS, request side
    infer: { label: 'LLM 응답 대기 중…',    icon: 'spark'   },
    guard: { label: '가드레일 검사 중…',    icon: 'shield'  },   // AIRS, response side
  };

  // How long the browser waits before it stops saying "검사" and starts saying "대기". A guess,
  // and a deliberately short one: the request-side scan is a single API call and the model is the
  // slow part of every turn, so erring early means the label is wrong for a moment rather than
  // for most of the wait.
  const EST_SCAN_MS = 1200;

  // The turn in flight, or null. Module-level because the control that cancels it lives in the
  // composer and not in send()'s scope.
  let turnCtl = null;

  // How fast an answer is written onto the screen. One rate, for every answer, start to finish.
  //
  // 46 characters a second sits just above a comfortable Korean reading pace (~15-25/s) and inside
  // the range a model streaming live would produce (~30-80/s), so the two are indistinguishable to
  // read. As words per minute — divide by 5.5 characters a word, multiply by 60 — that is ~500 wpm.
  // FRAME_MS is one animation frame.
  //
  // Deliberately NOT scaled by length, and deliberately without a deadline after which the rest is
  // dumped. Both were tried and both are the same mistake: they make a long answer arrive faster
  // than a short one, which is backwards — the reader of a long answer is the one who most needs
  // to be able to follow it. Every chat UI worth copying streams at a roughly constant rate and
  // lets a long answer simply take longer, so a 3,000-character reply runs about a minute here.
  //
  // The cost of that is real and it is paid by the composer, which stays disabled for the length
  // of the reveal (see finish()). A stop/skip control is what closes that gap.
  const STREAM_CPS = 46;
  const FRAME_MS = 16;
  // How often the DOM is rebuilt while text is arriving. The text advances every frame; the DOM
  // does not have to, because re-parsing a growing answer sixty times a second is what used to
  // lock the page.
  //
  // This was 110ms, and 110ms was the stutter. Nine repaints a second against a 46/s rate is five
  // characters appearing at once, five times a second — which the eye reads as lurching, not as
  // writing. 45ms is twenty-two a second: two characters a repaint, below the threshold where the
  // steps are visible at all, and still a third of the parse budget 60fps would cost.
  const PAINT_MS = 45;
  // Above this, formatting waits for the end. The parse is over the whole answer every time, so on
  // a very long one even eight a second costs more than italics mid-flight are worth.
  const LIVE_MD_MAX = 8000;

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
    mode: 'chat',      // 'chat' | 'agent' — which service the rail is showing
  };

  // The one place that knows where threads are kept. Everything else calls load()/save() and does
  // not know, which is what makes the move to the appliance database a change to this object.
  //
  // Async on both halves although localStorage is not: a server-backed read is a fetch, and a
  // caller written against a synchronous read would have to be found and rewritten. Awaiting a
  // resolved promise costs a microtask.
  const threads = {
    async read() {
      try {
        return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      } catch (_) { return {}; }   // corrupt or absent — start clean
    },
    async write(doc) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(doc));
      } catch (_) { /* quota or private mode — the session still works, it just will not survive */ }
    },
    // The cap exists because this store is a browser quota. A server-backed one drops it and prunes
    // on a retention window instead, the way api_collection does.
    CAP: 30,
  };

  async function load() {
    const raw = await threads.read();
    if (Array.isArray(raw.convos)) state.convos = raw.convos;
    // A wait bubble belongs to a turn in flight, and no turn survives the page. Stored ones are
    // debris from a reload mid-answer: harmless before, but the elapsed counter would now sit
    // there counting up from a timestamp in a session that ended.
    state.convos.forEach(c => {
      if (Array.isArray(c.messages)) c.messages = c.messages.filter(m => m.kind !== 'wait');
    });
    // Not validated here: the catalog has not arrived yet, and dropping a stored choice
    // against the one-entry fallback would reset every operator to the first model on load.
    // loadCatalog() checks it once the real list is in.
    if (raw.activeId) state.activeId = raw.activeId;
    if (raw.model) state.model = raw.model;
    if (raw.mode === 'chat' || raw.mode === 'agent') state.mode = raw.mode;
    if (typeof raw.badges === 'boolean') state.badges = raw.badges;
    if (typeof raw.railOpen === 'boolean') state.railOpen = raw.railOpen;
  }

  // Fire-and-forget by design: a save is never on the path of anything the operator is waiting
  // for, and awaiting it at every call site would put a round trip inside keystroke handling once
  // the store is remote.
  function save() {
    threads.write({
      convos: state.convos.slice(0, threads.CAP),
      // Persisted so a reload can put the operator back where they were. Whether it is USED is
      // decided at load — see the navigation-type check there.
      activeId: state.activeId,
      model: state.model, mode: state.mode,
      badges: state.badges, railOpen: state.railOpen,
    });
  }

  const activeConvo = () => state.convos.find(c => c.id === state.activeId) || null;

  // The session dialog is opened from several places — the rail's New, and the row menu's Edit —
  // so its openers cannot live inside wire()'s closure. Assigned there once it is in the DOM.
  let openNewSession = () => {};
  let openEditSession = () => {};

  // ── Confirm ────────────────────────────────────────────────────────────────
  // One dialog, reused. The action is only run from its own button, so an operator who lands here
  // by mistake leaves by every other route — scrim, Escape, Cancel, the close cross.
  let confirmRun = null;

  function askConfirm(title, body, label, run) {
    const el = document.getElementById('chatConfirm');
    if (!el) return;
    document.getElementById('cfT').textContent = title;
    document.getElementById('cfB').textContent = body;
    document.getElementById('cfGo').textContent = label;
    confirmRun = run;
    el.hidden = false;
    setTimeout(() => document.getElementById('cfGo')?.focus(), 0);
  }

  function closeConfirm() {
    confirmRun = null;
    const el = document.getElementById('chatConfirm');
    if (el) el.hidden = true;
  }

  function wireConfirm() {
    const el = document.getElementById('chatConfirm');
    if (!el) return;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-cx]')) return closeConfirm();
      if (e.target.closest('#cfGo')) {
        const run = confirmRun;
        closeConfirm();
        if (run) run();
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
    });
  }

  // ── Row menu ───────────────────────────────────────────────────────────────
  // Anchored to the button that opened it, mounted on <body> so the rail's overflow cannot crop
  // it and so there is one open menu at a time by construction. Edit and Remove are the two things
  // an operator does to a session that are not "open it" — one of which had no affordance at all
  // and the other of which was a single unguarded click on a bare icon.
  let rowMenuFor = '';

  function closeRowMenu() {
    rowMenuFor = '';
    document.getElementById('chatRowMenu')?.classList.remove('open');
  }

  function rowMenuEl() {
    let el = document.getElementById('chatRowMenu');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chatRowMenu';
      el.className = 'chat-rmenu';
      document.body.appendChild(el);
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const id = rowMenuFor;
        closeRowMenu();
        if (b.dataset.act === 'edit') openEditSession(id);
        else if (b.dataset.act === 'remove') deleteConvo(id);
        else if (b.dataset.act === 'clear') deleteAllConvos();
      });
    }
    return el;
  }

  function openListMenu(anchor) {
    const el = rowMenuEl();
    rowMenuFor = '*';
    el.innerHTML = `<button class="chat-rmenu-i is-danger" type="button" data-act="clear">
        ${IC.trash}<span>Delete all sessions</span></button>`;
    el.classList.add('open');
    placeMenu(el, anchor);
  }

  function placeMenu(el, anchor) {
    // Below the button, right edges aligned; flipped above only if it would leave the viewport.
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.min(r.right - w, window.innerWidth - 8 - w);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8 && r.top - 4 - h > 8) top = r.top - 4 - h;
    el.style.left = `${Math.max(8, left) + window.scrollX}px`;
    el.style.top = `${top + window.scrollY}px`;
  }

  function openRowMenu(anchor, id) {
    const el = rowMenuEl();
    rowMenuFor = id;
    el.innerHTML = `
      <button class="chat-rmenu-i" type="button" data-act="edit">${IC.pencil}<span>Edit</span></button>
      <button class="chat-rmenu-i is-danger" type="button" data-act="remove">${IC.trash}<span>Remove</span></button>`;
    el.classList.add('open');
    placeMenu(el, anchor);
  }

  document.addEventListener('pointerdown', (e) => {
    if (!rowMenuFor) return;
    if (e.target.closest('#chatRowMenu') || e.target.closest('[data-menu]')
        || e.target.closest('#listMenu')) return;
    closeRowMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRowMenu(); });

  // A conversation's id is also its AIRS session id: it is sent as session_id on every turn, and
  // pretzel-ai forwards it to the gateway as the scan's tr_id. So it is minted once, here, and
  // never regenerated for the life of the thread — a new id mid-conversation splits one exchange
  // into two unrelated sessions in the AIRS console, which is exactly what "new chat" is for and
  // exactly what must not happen otherwise.
  // The model is chosen when the session is created and kept on it, rather than being one global
  // setting the whole rail shares. What that buys: an old session reads back as the thing that
  // actually answered it, and switching model to try something else no longer silently rewrites
  // the history of every other thread. It costs a choice at creation — which is why the composer's
  // picker still works, and moves this session only.
  //
  // `mode` is chat or agent. Carried from the start even though only chat serves turns today,
  // because a session's mode is not something that can be inferred afterwards.
  function newConvo(makeActive, model, mode) {
    const c = {
      id: randId('cv_', 10), title: '', mode: mode || state.mode,
      model: model || state.model,
      createdAt: Date.now(), updatedAt: Date.now(), messages: [],
    };
    state.convos.unshift(c);
    if (makeActive !== false) state.activeId = c.id;
    return c;
  }

  // What the active session is set to, with the global default behind it for a session stored
  // before the model moved onto sessions.
  const convoModel = (c) => (c && c.model) || state.model;

  // "New chat" is a security control as much as a UI affordance: it is the only way to start a
  // session AIRS will not correlate with what came before. Reusing the empty thread already open
  // rather than stacking a second one keeps the rail from filling with blank sessions that were
  // never sent — and an unsent thread has no scans behind it, so there is nothing to separate.
  function startNewChat(model) {
    // Always a new one. This used to reuse an empty thread that was already open, which was right
    // when New was a bare button and the only thing it could produce was another blank session —
    // but New now takes a name and a model, so the operator has described the session they want.
    // Reusing meant the second one they described silently renamed the first.
    const c = newConvo(true, model);

    state.activeId = c.id;
    state.inspectId = '';
    save();
    renderRail();
    renderThread();
    const input = document.getElementById('chatInput');
    if (input) input.focus();
    return c;
  }

  // Asks first, unless the caller has already asked — which is what lets one dialog cover both
  // "this session" and "all of them" without putting two in a row.
  function deleteAllConvos() {
    const rows = sessionsInMode();
    if (!rows.length) return;
    const msgs = rows.reduce((n, c) => n + c.messages.filter(m => m.role === 'user').length, 0);
    askConfirm(
      `Delete all ${state.mode === 'agent' ? 'Agent' : 'Chat'} sessions`,
      `${rows.length} session${rows.length === 1 ? '' : 's'}`
        + (msgs ? ` and ${msgs} message${msgs === 1 ? '' : 's'}` : '')
        + ' will be deleted. Sessions are stored in this browser only, so this cannot be undone.',
      `Delete ${rows.length}`,
      () => {
        const ids = new Set(rows.map(c => c.id));
        state.convos = state.convos.filter(c => !ids.has(c.id));
        state.activeId = '';
        state.inspectId = '';
        save();
        renderRail(); renderThread();
      });
  }

  function deleteConvo(id, skipConfirm) {
    const i = state.convos.findIndex(c => c.id === id);
    if (i < 0) return;
    const c = state.convos[i];
    if (!skipConfirm) {
      const n = c.messages.filter(m => m.role === 'user').length;
      askConfirm(
        'Delete session',
        `${c.title ? `“${c.title}”` : 'This session'} will be deleted`
          + (n ? ` along with its ${n} message${n === 1 ? '' : 's'}` : '')
          + '. Sessions are stored in this browser only, so this cannot be undone.',
        'Delete',
        () => deleteConvo(id, true));
      return;
    }
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

  // ── Icons ──────────────────────────────────────────────────────────────────

  const svg = (inner, w) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w || 2}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  const IC = {
    plus:    svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    trash:   svg('<polyline points="3 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>'),
    dots:    svg('<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>'),
    chat:    svg('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-3.2-.5L3 21l1.7-4.6A8.2 8.2 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>'),
    agent:   svg('<path d="M12 2v3"/><rect x="4" y="5" width="16" height="14" rx="4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/>'),
    pencil:  svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>'),
    shield:  svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    shieldOk: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15.5 9.5"/>'),
    shieldX: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="9.5" y1="9.5" x2="14.5" y2="14.5"/><line x1="14.5" y1="9.5" x2="9.5" y2="14.5"/>'),
    eye:     svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
    mask:    svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="8.5" y1="12" x2="15.5" y2="12"/>'),
    send:    svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
    transit: svg('<polyline points="16 4 21 9 16 14"/><line x1="21" y1="9" x2="7" y2="9"/><polyline points="8 20 3 15 8 10"/><line x1="3" y1="15" x2="17" y2="15"/>'),
    stop:    svg('<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>'),
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

  // Markdown that is still being written is markdown with an open delimiter, and the one that does
  // real damage is the code fence: an unclosed ``` swallows everything after it, so the reader
  // watches the answer disappear into a code block and come back out when the closing fence
  // arrives. Closing it for the duration of the render costs one string concat and keeps the text
  // visible; the real closer arrives a moment later and this stops being needed.
  //
  // Only fences. An unclosed ** or _ renders as the literal characters, which is what it is.
  function closeFences(s) {
    const src = String(s == null ? '' : s);
    const open = (src.match(/```/g) || []).length % 2;
    return open ? src + '\n```' : src;
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

  // The picker shows and sets the ACTIVE SESSION's model. `state.model` is only the default the
  // next new session starts from, so an operator who settles on one model does not re-pick it every
  // time — but the session is what a turn is actually sent with.
  function currentModel() {
    const want = convoModel(activeConvo());
    return MODELS.find(m => m.id === want) || MODELS[0] || FALLBACK_MODELS[0];
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
        const on = m.id === currentModel().id;
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
    picker.active = Math.max(0, picker.rows.findIndex(m => m.id === currentModel().id));
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
    const c = activeConvo();
    if (c) c.model = id;
    // Also the default for the next new session — changing model here is the ordinary way an
    // operator says which one they want to be using.
    state.model = id;
    save();
    closePicker(true);
    renderRail();          // the session's subline carries the model
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
            <!-- Mode, not a filter: a session belongs to one of the two and cannot be moved
                 between them, because what answers a turn is a different thing in each. -->
            <div class="chat-mode" id="chatMode" role="tablist">
              <span class="chat-mode-slide" id="chatModeSlide"></span>
              <button class="chat-mode-b" type="button" role="tab" data-mode="chat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-3.2-.5L3 21l1.7-4.6A8.2 8.2 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>
                <span>Chat</span>
              </button>
              <button class="chat-mode-b" type="button" role="tab" data-mode="agent">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 2v3"/><rect x="4" y="5" width="16" height="14" rx="4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/></svg>
                <span>Agent</span>
              </button>
            </div>
            <!-- Split: the button starts a session on the model last used, the caret says which
                 model to start it on. The fast path stays one click. -->
            <div class="chat-rail-nav">
              <!-- Where the page lands, and the way back to it. Common to both modes: it is about
                   starting work, and neither service owns that. -->
              <button class="chat-home" type="button" id="chatHome">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/></svg>
                <span>Home</span>
              </button>
              <button class="chat-new" type="button" id="chatNew">${IC.plus}<span>New</span></button>
            </div>
          </div>
          <div class="chat-rail-list" id="chatList"></div>
        </div>
        <div class="chat-main">
          <!-- Where you are, stated once. With nothing open that is the mode; inside a session it
               is the session's name and what answers it. Read-only either way: the model is
               settled by the first message, and the name is edited from the row menu. -->
          <div class="chat-head" id="chatHead">
            <div class="chat-head-txt" id="chatHeadTxt"></div>
            <div class="chat-head-mp" id="chatHeadMp"><div class="mp" id="modelPicker"></div></div>
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
      </div>

      <!-- New session. A dialog rather than a rail-width popover because there are four things to
           say about a session and only one of them is the model: a popover would have made the name
           the name an afterthought, and the name is the whole reason a list of sessions is still
           readable a week later. -->
      <div class="chat-modal" id="chatConfirm" hidden>
        <div class="chat-modal-scrim" data-cx></div>
        <div class="chat-modal-card is-narrow" role="alertdialog" aria-modal="true"
             aria-labelledby="cfT" aria-describedby="cfB">
          <div class="chat-modal-h">
            <h2 id="cfT"></h2>
            <button class="chat-modal-x" type="button" data-cx aria-label="Close">&times;</button>
          </div>
          <div class="chat-modal-b"><p class="chat-cf-b" id="cfB"></p></div>
          <div class="chat-modal-f">
            <button class="btn-sm" type="button" data-cx>Cancel</button>
            <button class="btn-sm chat-cf-go" type="button" id="cfGo">Delete</button>
          </div>
        </div>
      </div>

      <div class="chat-modal" id="chatModal" hidden>
        <div class="chat-modal-scrim" data-close></div>
        <div class="chat-modal-card" role="dialog" aria-modal="true" aria-labelledby="chatModalT">
          <div class="chat-modal-h">
            <h2 id="chatModalT">New session</h2>
            <button class="chat-modal-x" type="button" data-close aria-label="Close">&times;</button>
          </div>
          <div class="chat-modal-b" id="chatModalBody"></div>
          <div class="chat-modal-f">
            <button class="btn-sm" type="button" data-close>Cancel</button>
            <button class="btn-primary btn-sm" type="button" id="chatModalGo">Create</button>
          </div>
        </div>
      </div>`;

    wire();
    wireConfirm();
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
    if (!first) return 'New session';
    const t = first.text.replace(/\s+/g, ' ').trim();
    return t.length > 34 ? t.slice(0, 34) + '…' : t;
  }

  // The subline: when it was started, and what answers it. Both are what an operator scans a rail
  // for — "the one from this morning" and "the one I asked the big model" — and neither can be
  // recovered from the title, which is usually just the first thing they typed.
  //
  // The date is relative for the recent past and absolute beyond it. "3d ago" stops being useful
  // about the point it stops being this week.
  function convoWhen(ts) {
    const d = new Date(ts || 0);
    if (isNaN(d.getTime())) return '';
    const days = (Date.now() - d.getTime()) / 86400000;
    if (days < 1) return window.NMS.utils.relAge(d);
    if (days < 7) return `${Math.round(days)}d ago`;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const modelLabel = (id) => {
    const m = MODELS.find(x => x.id === id) || FALLBACK_MODELS.find(x => x.id === id);
    return m ? m.label : (id || '').split('/').pop();
  };

  // A session belongs to the mode it was created in. Filtering rather than mixing keeps the two
  // services separate in the one place an operator would otherwise conflate them.
  const sessionsInMode = () => state.convos.filter(c => (c.mode || 'chat') === state.mode);

  // The header always says where you are, and it is the same shape in both states so nothing
  // shifts when a session opens: a title, then one line under it.
  //
  // What that second line holds is the difference. With nothing open it is the model picker — the
  // model is not yet fixed, and this is the moment to choose it. Inside a session it is what the
  // session is and what it runs on, stated and not editable: the model is settled the moment the
  // first message goes out, and a control offering to change it there would be offering to
  // relabel a thread as having run on something it did not.
  function renderHead() {
    const el = document.getElementById('chatHead');
    const txt = document.getElementById('chatHeadTxt');
    const mp = document.getElementById('chatHeadMp');
    if (!el || !txt) return;
    el.classList.remove('is-empty');

    const c = activeConvo();
    const agent = state.mode === 'agent';
    const home = !c || agent;

    // The icon carries the identity and the words say what it is. "Pretzel AI Agent Assistant"
    // spent four words to distinguish one, and the one that mattered was in the middle; the badge
    // is the same glyph as the mode switch, so the rail and the header agree at a glance.
    txt.innerHTML = home
      ? `<div class="chat-head-id">
           <span class="chat-head-ic">${agent ? IC.agent : IC.chat}</span>
           <span class="chat-head-t">${agent ? 'Agent' : 'Chat'} Assistant</span>
         </div>`
      : `<div class="chat-head-t">${esc(convoTitle(c))}</div>
         <div class="chat-head-m">${esc(modelLabel(convoModel(c)))}
           <span class="chat-head-w">${esc(convoWhen(c.createdAt))}</span></div>`;

    // The wrapper, never the picker itself: renderPicker rewrites #modelPicker's className on
    // every repaint, so a class set on it survives exactly until the next one.
    if (mp) mp.hidden = !home;
    if (home) renderPicker();
  }

  function renderRail() {
    renderHead();
    const list = document.getElementById('chatList');
    if (!list) return;

    const rows = sessionsInMode();

    // An empty rail says why it is empty. The two reasons are different and must not read the
    // same: Chat has nowhere to list because nothing has been started, Agent has nowhere to list
    // because the service does not answer here at all — and a blank column would have an operator
    // waiting for either one to fill in on its own.
    if (state.mode === 'agent') {
      list.innerHTML = '<div class="chat-rail-empty">Agent is not available yet</div>';
    } else if (!rows.length) {
      list.innerHTML = '<div class="chat-rail-empty">No sessions yet</div>';
    } else {
      list.innerHTML = `<div class="chat-rail-sec">Sessions
          <button class="chat-sec-x" type="button" id="listMenu"
                  aria-haspopup="menu" aria-label="Session list actions">${IC.dots}</button>
        </div>` + rows.map(c => {
        const flagged = c.messages.some(m => m.scan && m.scan.verdict === 'block');
        return `<div class="chat-convo${c.id === state.activeId ? ' active' : ''}" data-convo="${c.id}">
          <span class="chat-convo-b">
            <span class="chat-convo-t">
              ${flagged ? '<span class="chat-convo-flag" data-tip="A turn in this session was blocked"></span>' : ''}
              ${esc(convoTitle(c))}
            </span>
            <span class="chat-convo-s">${esc(convoWhen(c.createdAt))} · ${esc(modelLabel(convoModel(c)))}</span>
          </span>
          <button class="chat-convo-x" type="button" data-menu="${c.id}"
                  aria-haspopup="menu" aria-label="Session actions">${IC.dots}</button>
        </div>`;
      }).join('');
    }

    const slide = document.getElementById('chatModeSlide');
    if (slide) slide.style.transform = `translateX(${state.mode === 'agent' ? '100%' : '0'})`;
    document.querySelectorAll('#chatMode .chat-mode-b').forEach(b =>
      b.classList.toggle('on', b.dataset.mode === state.mode));

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
      live:  'The last turn was answered by a model through pretzel-ai.',
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

    // The operator pressed stop. Its own kind, not an error card: nothing failed, and a thread
    // read back next week must not show a deliberate interruption as an outage.
    if (m.kind === 'stopped') {
      return `<div class="chat-turn is-bot" data-msg="${m.id}">
        <div class="chat-stopped">
          <span class="chat-stopped-ic">${IC.stop}</span>
          <span>중단했습니다 · ${Math.round((m.elapsedMs || 0) / 1000)}s 경과</span>
          <span class="chat-stopped-n">요청은 이미 전송되어 검사 기록에는 남습니다</span>
        </div>
      </div>`;
    }

    // Three things and no fourth: which leg is running (the icon), what that leg is (the label),
    // and how long it has been running (the counter). A stepper and a dot animation were both
    // tried here and both were noise — the icon already carries the state, and the counter
    // already carries the fact that something is still moving.
    if (m.kind === 'wait') {
      const st = STAGES[m.stage] || STAGES.gw;
      return `<div class="chat-turn is-bot" data-msg="${m.id}">
        <div class="chat-bubble"><span class="chat-wait">
          <span class="chat-wait-ic" aria-hidden="true">${IC[st.icon] || IC.transit}</span>
          <span class="chat-wait-l">${esc(st.label)}</span>
          <span class="chat-wait-t" data-wait-t="${m.id}">${elapsedLabel(m.startedAt)}</span>
        </span></div>
      </div>`;
    }

    const body = m.typing ? '' : renderText(m.text);
    // Offered only once the text is final. A copy button on a message still streaming in would
    // hand over half an answer, which is worse than no button at all.
    const copy = m.typing ? '' :
      `<button class="chat-copy" type="button" data-copy="${m.id}"
               data-tip="Copy">${IC.copy}<span class="chat-copy-t">복사</span></button>`;
    return `<div class="chat-turn is-${m.role === 'user' ? 'user' : 'bot'}" data-msg="${m.id}">
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

    renderHead();

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

  // Post, then poll. The turn is not answered on the POST: mgmtd hands it to pretzel-ai and returns a
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

  // Returns the finished turn document from pretzel-ai — ok or not — because the interesting failures
  // carry a scan too. A blocked prompt and a provider that ran out of credit are both `ok:false`,
  // and both were inspected; only a missing gateway throws, so the mock can take over.
  // The turns already on screen, in the shape pretzel-ai's ChatRequest.history expects. Only the
  // plain text ones: block cards and enforcement notices are this console's own
  // furniture, and replaying them as things the person or the model said would put words in both
  // their mouths. A turn the guardrail denied never reached the model, so the model must not be
  // told it did.
  function historyFor(c) {
    if (!c || !Array.isArray(c.messages)) return [];
    return c.messages
      .filter(m => m.kind === 'text' && (m.role === 'user' || m.role === 'assistant') && m.text)
      .map(m => ({ role: m.role, content: String(m.text) }));
  }

  // ── Stop ───────────────────────────────────────────────────────────────────
  //
  // One object per turn holding everything an interruption has to reach: the fetch that is open,
  // the timer waiting on the next poll, and the pacer writing the answer onto the screen. Stop has
  // to work in both halves of a turn, and they are not the same act:
  //
  //   while the turn is upstream   the wait is abandoned. The request itself cannot be recalled —
  //                                it is at the gateway, it will finish, and it will appear in the
  //                                scan log — so the notice says that rather than implying the
  //                                appliance clawed something back.
  //   while the answer is drawing  the rest is put on screen at once. NOT truncated: the answer
  //                                is already here, already scanned and already cleared, so
  //                                throwing it away would be destroying something the guardrail
  //                                had approved for delivery. Stop here means "don't make me
  //                                wait", which is the only thing left to be impatient about.
  function newTurnCtl(onStage) {
    const listeners = [];
    const ctl = {
      ac: new AbortController(),
      stopped: false,
      phase: 'request',              // request | render — decides what the button promises
      stage: onStage || function () {},

      // Returns its own unsubscribe, so a listener that belongs to one phase does not fire in the
      // next one.
      whenStopped(fn) {
        if (ctl.stopped) { fn(); return function () {}; }
        listeners.push(fn);
        return function () {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },

      // Timers the turn owns. Held here so stopping or finishing a turn cannot leave one behind
      // to fire against a wait bubble that is no longer on the page.
      timers: [],
      later(ms, fn) { ctl.timers.push(setTimeout(fn, ms)); },
      clearTimers() { ctl.timers.splice(0).forEach(clearTimeout); },

      // A sleep that stop can cut short. Without it the button would feel dead for up to a poll
      // interval, which on a control whose whole job is to respond now is the wrong feeling.
      wait(ms) {
        return new Promise(resolve => {
          if (ctl.stopped) return resolve();
          let off = null;
          const t = setTimeout(() => { if (off) off(); resolve(); }, ms);
          off = ctl.whenStopped(() => { clearTimeout(t); resolve(); });
        });
      },

      stop() {
        if (ctl.stopped) return;
        ctl.stopped = true;
        ctl.clearTimers();
        try { ctl.ac.abort(); } catch (_) { /* already gone */ }
        listeners.splice(0).forEach(fn => { try { fn(); } catch (_) { /* one bad listener is not the others' problem */ } });
      },
    };
    return ctl;
  }

  const elapsedLabel = (t0) => Math.max(0, Math.round((Date.now() - (t0 || Date.now())) / 1000)) + 's';

  // The elapsed counter ticks on its own interval and writes one text node. Driving it through
  // renderThread() would rebuild every message in the thread once a second to animate two
  // characters at the bottom of it.
  let waitTick = null;
  function startWaitTick(msg) {
    stopWaitTick();
    waitTick = setInterval(() => {
      const el = document.querySelector(`[data-wait-t="${msg.id}"]`);
      if (el) el.textContent = elapsedLabel(msg.startedAt);
    }, 250);
  }
  function stopWaitTick() {
    if (waitTick) { clearInterval(waitTick); waitTick = null; }
  }

  // A stage change DOES repaint the thread — it happens a handful of times a turn, not sixty times
  // a second, and the label and the stepper both move.
  function setStage(msg, id) {
    if (!msg || !STAGES[id] || msg.stage === id) return;
    msg.stage = id;
    renderThread(true);
  }

  async function askServer(text, model, history, sessionId, onDelta, ctl) {
    // Not an error the operator needs explained — they caused it. It travels as one so it unwinds
    // the same path every other outcome does, and send() picks it out by code.
    const aborted = () => gwError('중단했습니다', 'ABORTED', false);

    let res;
    ctl.stage('gw');
    try {
      res = await fetch(CHAT_URL, {
        signal: ctl.ac.signal,
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, message: text,
          history: history || [],
          // The conversation id doubles as the AIRS session id — pretzel-ai forwards it to the
          // gateway, which passes it to Prisma AIRS as tr_id. Sent per turn because it is what
          // makes a thread one session in the AIRS console rather than N unrelated scans.
          session_id: sessionId || '',
        }),
      });
    } catch (_) {
      // An aborted fetch throws exactly like an unreachable one. Told apart before the mock is
      // reached for: falling back to a made-up answer because the operator pressed stop would be
      // the same lie the fallback exists to avoid.
      if (ctl.stopped) throw aborted();
      throw gwError('mgmtd could not be reached', 'OFFLINE', true);
    }

    if (res.status === 404) throw gwError('no /api/chat route on this appliance', 'NO_ROUTE', true);
    if (!res.ok) throw gwError('mgmtd refused the turn (HTTP ' + res.status + ')', 'HTTP_' + res.status, false);

    const start = await res.json().catch(() => null);
    const ticket = start && start.ticket;
    if (!ticket) throw gwError('mgmtd returned no ticket', 'BAD_TICKET', false);

    // The ticket is held, so the hop to the gateway is done and the turn is upstream. What it is
    // doing up there is the part this side cannot see, so the next two legs run on a timer until
    // the server starts reporting its own — see STAGES.
    ctl.stage('scan');
    ctl.later(EST_SCAN_MS, () => ctl.stage('infer'));

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      await ctl.wait(POLL_MS);
      if (ctl.stopped) throw aborted();
      if (Date.now() > deadline) throw gwError('the gateway did not answer in time', 'TIMEOUT', false);

      let d = null;
      try {
        const r = await fetch(`${CHAT_RESULT_URL}?ticket=${ticket}`,
                              { credentials: 'same-origin', signal: ctl.ac.signal });
        if (r.ok) d = await r.json();
      } catch (_) {
        /* a dropped poll is not a failed turn — the next one asks again. A stopped one is. */
        if (ctl.stopped) throw aborted();
      }

      // The server's own stage wins whenever it sends one, and it retires the estimate outright:
      // a timer that kept firing behind an observed stage would drag the label backwards.
      if (d && d.status === 'pending' && d.stage) {
        ctl.clearTimers();
        ctl.stage(d.stage);
      }

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
  // own and arrive verbatim from pretzel-ai — including ones not listed here, which is the point: a
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

  // pretzel-ai's normalised scan → the shape renderTurn/renderInspector consume. Kept as a translation
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

  // What a stopped turn leaves behind. Deliberately not an error card — see renderTurn — and
  // deliberately explicit that the request is not recalled: it is at the gateway, it will finish,
  // and it will show up in the scan log whether or not anyone is still reading.
  function stopHere(c, drop, t0) {
    drop();
    c.messages.push({
      id: randId('m_', 10), role: 'assistant', kind: 'stopped',
      text: '', ts: Date.now(), elapsedMs: Date.now() - t0,
    });
    finish(c);
  }

  async function send(raw) {
    const text = raw.trim();
    if (!text || state.sending) return;

    state.sending = true;
    renderPicker();

    let c = activeConvo();
    if (!c) { c = newConvo(); renderRail(); }

    const now = Date.now();
    // Snapshotted BEFORE this turn joins the thread: history is what came before, and pushing
    // first would send the question twice — once as the last history entry and once as the turn.
    const history = historyFor(c);
    const userMsg = { id: randId('m_', 10), role: 'user', kind: 'text', text, ts: now };
    c.messages.push(userMsg);
    c.updatedAt = now;

    // The wait is a sequence of steps the operator should see happen, not a hidden pause before
    // the answer. `stage` is what it is doing and `startedAt` is how long it has been doing it —
    // between them a turn that is slow and a turn that is stuck stop looking the same, which is
    // the whole reason a bare spinner was not enough.
    const waitMsg = { id: randId('m_', 10), role: 'assistant', kind: 'wait',
      stage: 'gw', startedAt: Date.now(), ts: Date.now() };
    c.messages.push(waitMsg);

    turnCtl = newTurnCtl((id) => setStage(waitMsg, id));
    setSendEnabled();                  // the send button is now the stop button
    renderThread();
    startWaitTick(waitMsg);
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
    try {
      // The answer as it is written. The wait bubble is replaced by a real assistant turn the
      // first time text arrives — from then on the reader is watching the answer appear, which is
      // the point of streaming it. It stays `typing` until the turn resolves, so neither the copy
      // button nor the verdict pill offers itself over a half-finished answer.
      const onDelta = (soFar) => {
        if (!liveMsg) {
          drop();
          liveMsg = { id: randId('m_', 10), role: 'assistant', kind: 'text',
                      text: '', ts: Date.now(), typing: true };
          c.messages.push(liveMsg);
          renderThread();                      // creates the bubble the streamer writes into
          streamer = streamInto(liveMsg);
        }
        streamer.push(soFar);
      };

      turn = await askServer(text, convoModel(c), history, c.id, onDelta, turnCtl);

      // A turn that streamed but did not end with an answer — blocked on the response side, or an
      // upstream error after the first tokens — must not leave its fragment on screen. The branch
      // below replaces it with the card that says what actually happened.
      if (liveMsg && !(turn.ok && typeof turn.reply === 'string')) {
        const i = c.messages.indexOf(liveMsg);
        if (i >= 0) c.messages.splice(i, 1);
        liveMsg = null;
        streamer = null;
      }
      state.gateway = turn.ok ? 'live' : (turn.code === 'BLOCKED' ? 'live' : 'error');
    } catch (e) {
      // Stopped, not failed. Checked before the cleanup below because the two want opposite
      // things: a failure retracts what it streamed, and a stop keeps it — the operator asked for
      // the interruption, so the words already on screen are theirs.
      if (e.code === 'ABORTED') {
        if (streamer) streamer.flush();
        return stopHere(c, drop, t0);
      }

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
        model: convoModel(c),
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
        turnCtl.phase = 'render';
        turnCtl.whenStopped(() => streamer.flush());
        setSendEnabled();
        await streamer.end(String(turn.reply || ''));
        renderThread(true);        // repaint once, now that the pill and copy button apply
        finish(c);
        return;
      }

      // Nothing streamed — the whole answer landed on one poll. Revealed through the SAME pacer
      // the streamed path uses, not a second one: whether the text arrived in pieces or all at
      // once is a fact about the transport, and the reader should not be able to tell. `text`
      // starts empty and the pacer fills it in.
      const botMsg = {
        id: randId('m_', 10), role: 'assistant', kind: 'text',
        text: '', ts: Date.now(),
        scan: scanOrNull,
        typing: true,
        route,
      };
      c.messages.push(botMsg);
      renderThread();
      const pacer = streamInto(botMsg);
      turnCtl.phase = 'render';
      turnCtl.whenStopped(() => pacer.flush());
      setSendEnabled();
      await pacer.end(String(turn.reply || ''));
      renderThread(true);        // repaint once, now that the pill and copy button apply
      finish(c);
      return;
    }

    // ── No gateway: the local mock answers, and says so ─────────────────────
    const promptScan = scan(text, 'prompt');
    setStage(waitMsg, 'scan');
    await turnCtl.wait(320 + promptScan.latencyMs);
    if (turnCtl.stopped) return stopHere(c, drop, t0);
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
    setStage(waitMsg, 'infer');

    await turnCtl.wait(420 + Math.random() * 400);
    if (turnCtl.stopped) return stopHere(c, drop, t0);
    const reply = mockReply(outbound);

    setStage(waitMsg, 'guard');
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
      text: '', ts: Date.now(), scan: respScan, typing: true,
      route: {
        model: convoModel(c),
        tokensIn: tokensOf(outbound), tokensOut: tokensOf(delivered),
        latencyMs: Date.now() - t0, source: 'mock',
      },
    };
    c.messages.push(botMsg);
    renderThread();
    const mockPacer = streamInto(botMsg);
    turnCtl.phase = 'render';
    turnCtl.whenStopped(() => mockPacer.flush());
    setSendEnabled();
    await mockPacer.end(delivered);
    renderThread(true);

    finish(c);
  }

  function finish(c) {
    stopWaitTick();
    if (turnCtl) turnCtl.clearTimers();
    turnCtl = null;
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
    let lastPaint = 0;
    // Set by flush(), and it is sticky: once the operator has said "stop making me wait", nothing
    // that arrives afterwards gets to start pacing again.
    let flushed = false;

    // Reveal on a word boundary, not on the character the budget happened to land on.
    //
    // This is the difference between the animation reading as streaming and reading as an
    // animation, and it matters more than the rate did. A model emits tokens: whole words appear
    // at once, in bursts, and the eye tracks words. Sliding a cursor through characters at the
    // same average speed looks like a machine typing, which is why every rate tried here was
    // either too fast to read or too slow to be plausible.
    //
    // Korean and Chinese have no spaces, so the search is bounded — past a short look-ahead the
    // budget is taken as it is, which for CJK means a few characters at a time. That is what those
    // scripts look like arriving anyway, since a token there is a syllable or two.
    const boundary = (s, from) => {
      if (from >= s.length) return s.length;
      const limit = Math.min(s.length, from + 10);
      for (let i = from; i < limit; i++) {
        if (/\s/.test(s[i])) return i + 1;
      }
      return from;
    };
    const instant = !!(window.matchMedia &&
                       window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // While the text is still arriving it is painted as PLAIN TEXT, and the markdown is rendered
    // once at the end.
    //
    // Two reasons, one of which is a bug this fixes. Re-parsing the whole answer every frame is
    // O(n) work sixty times a second against an n that is still growing: at 6,000 characters with
    // a few code fences it saturated the main thread for the length of the animation, and the page
    // stopped responding — which is exactly what a long Gemini answer did. And half-written
    // markdown renders as damage anyway: an unclosed fence swallows everything after it, so the
    // reader watches the answer flicker between "code" and "not code" as the delimiter arrives.
    //
    // textContent, not innerHTML: no HTML parse per frame, and no way for a partial answer to be
    // interpreted as markup. The caret is a CSS pseudo-element on .is-streaming rather than an
    // appended node, so it costs nothing per frame either.
    const paint = (force) => {
      const el = document.querySelector(`[data-body="${msg.id}"]`);
      if (!el) return;

      const streaming = msg.text.length < full.length || !done;

      // The text advances every frame; the DOM does not have to. Re-parsing the whole answer sixty
      // times a second is what locked the page, and it was never needed — a repaint every 110ms is
      // eight a second, which is far finer than the eye resolves and an eighth of the work.
      const now = Date.now();
      if (!force && streaming && now - lastPaint < PAINT_MS) return;
      lastPaint = now;

      const pinned = atBottom();

      if (streaming && full.length > LIVE_MD_MAX) {
        // Past this size the parse is heavy enough that eight a second still costs more than the
        // formatting is worth mid-flight. The markdown lands when the answer does.
        el.classList.add('is-streaming', 'is-raw');
        el.textContent = msg.text;
      } else if (streaming) {
        el.classList.add('is-streaming');
        el.classList.remove('is-raw');
        el.innerHTML = renderText(closeFences(msg.text));
      } else {
        el.classList.remove('is-streaming', 'is-raw');
        el.innerHTML = renderText(msg.text);
      }

      if (pinned) scrollToEnd();
      if (onGrow) onGrow();
    };

    const tick = () => {
      const backlog = full.length - msg.text.length;
      if (backlog > 0) {
        // A flat rate, independent of how much text is waiting.
        //
        // The obvious rule — drain a fixed share of the backlog each frame — is wrong here, and
        // measurably so: it makes a long answer appear FASTER than a short one (3,000 characters
        // came out at ~3,300/s, which is not reading, it is a page-load). Deriving the rate from
        // the answer's length was the same mistake one step removed. So: one rate, and a long
        // answer takes longer, which is what it should do.
        //
        // Be clear about what this is. The gateway call is not streaming — the response-side
        // guardrail has to see the whole answer to rule on it, so by the time the first character
        // is drawn the last one already exists. This paces a finished answer. It is presentation,
        // not transport, and the honest reason to do it is that the alternative is a four-second
        // blank followed by a wall of text.
        if (instant) {
          // Someone who has asked their system not to animate things gets the answer, not a show.
          msg.text = full;
          paint(true);
        } else {
          // Jittered, because a real stream is not metronomic. Without this the bursts land on a
          // perfectly even beat, which reads as a timer rather than as something being written.
          carry += STREAM_CPS * (FRAME_MS / 1000) * (0.88 + Math.random() * 0.24);
          if (carry < 1) { timer = setTimeout(tick, FRAME_MS); return; }

          const budget = Math.floor(carry);
          carry -= budget;
          const at = Math.min(full.length, msg.text.length + budget);
          msg.text = full.slice(0, Math.min(full.length, boundary(full, at)));
          paint();
        }
      } else if (done) {
        msg.typing = false;
        timer = null;
        paint(true);
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
        if (flushed) { msg.text = full; paint(true); return; }
        if (!timer) timer = setTimeout(tick, 0);
      },
      // Stop pacing and put everything that has actually arrived on screen, now. This is Stop's
      // render half: the answer is already local and already cleared by the response-side
      // checkpoint, so there is nothing to withhold — only a wait to cut short. Safe before the
      // turn resolves too, in which case it finalises on whatever had streamed.
      flush() {
        flushed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        msg.text = full;
        done = true;
        msg.typing = false;
        paint(true);
        if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); }
      },
      // Called with the final text once the turn resolves. Anything the display has not caught up
      // to yet is still drained rather than snapped in, so the answer never ends with a lurch.
      end(finalText) {
        if (typeof finalText === 'string' && finalText.length >= full.length) full = finalText;
        done = true;
        // Already flushed — the stop landed while the answer was still on its way. The remaining
        // text is shown, not paced: re-pacing it here would let the turn out-live the instruction
        // that ended it.
        if (flushed) { msg.text = full; msg.typing = false; paint(true); return Promise.resolve(); }
        if (!timer) timer = setTimeout(tick, 0);
        return new Promise(resolve => {
          if (!timer && msg.text.length >= full.length) { msg.typing = false; paint(true); return resolve(); }
          resolveEnd = resolve;
        });
      },
      get text() { return full; },
    };
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  // The send button and the stop button are the same button. Exactly one of the two actions is
  // ever available — you cannot send during a turn and there is nothing to stop outside one — so a
  // second control would sit disabled and meaningless for almost all of the page's life.
  function setSendEnabled() {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('chatSend');
    if (!input || !btn) return;

    const stopping = state.sending && !!turnCtl && !turnCtl.stopped;

    // Swapped only on the transition. setSendEnabled runs on every keystroke, and rewriting the
    // button's innerHTML on each one would throw away and rebuild an SVG for nothing.
    if (btn.classList.contains('is-stop') !== stopping) {
      btn.classList.toggle('is-stop', stopping);
      btn.innerHTML = stopping ? IC.stop : IC.send;
      btn.setAttribute('aria-label', stopping ? 'Stop' : 'Send');
    }
    // What stop means depends on which half of the turn is running, and the two are different
    // enough that the button has to say which one it is offering.
    btn.title = stopping
      ? (turnCtl.phase === 'render' ? '나머지 전체 표시' : '요청 중단')
      : '';

    btn.disabled = stopping ? false : (state.sending || !input.value.trim());
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
      send(v).catch(() => {
        stopWaitTick();
        turnCtl = null;
        state.sending = false;
        renderPicker();
        setSendEnabled();
      });
    };

    input.addEventListener('input', () => { autoGrow(input); setSendEnabled(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    sendBtn.addEventListener('click', () => {
      // Same button, and which act it performs is decided by whether a turn is running — never by
      // what the button looked like when the click started.
      if (state.sending) {
        if (turnCtl) { turnCtl.stop(); setSendEnabled(); }
        return;
      }
      submit();
    });

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

    // ── New session dialog ────────────────────────────────────────────────────
    const modal = document.getElementById('chatModal');
    const modalBody = document.getElementById('chatModalBody');

    const closeModal = () => { modal.hidden = true; };

    function openDialog(editing) {
      if (state.sending) return;
      if (!editing && state.mode !== 'chat') return;
      const c = editing ? state.convos.find(x => x.id === editing) : null;
      if (editing && !c) return;

      const list = MODELS.length ? MODELS : FALLBACK_MODELS;
      document.getElementById('chatModalT').textContent = c ? 'Edit session' : 'New session';
      document.getElementById('chatModalGo').textContent = c ? 'Save' : 'Create';
      modalBody.dataset.editing = editing || '';
      modalBody.innerHTML = `
        <label class="chat-f">
          <span class="chat-f-l">Mode</span>
          <!-- Fixed, and shown rather than hidden: a session belongs to the mode it was created in
               and cannot be moved, so the dialog states which one this will be instead of letting
               an operator discover it afterwards. -->
          <span class="chat-f-fixed">${esc(state.mode === 'agent' ? 'Agent' : 'Chat')}</span>
        </label>
        <label class="chat-f">
          <span class="chat-f-l">Name <em>optional</em></span>
          <input id="nsName" type="text" maxlength="80" autocomplete="off"
                 value="${esc(c ? (c.title || '') : '')}"
                 placeholder="What this session is for"/>
        </label>
        ${c ? `
        <label class="chat-f">
          <span class="chat-f-l">Model</span>
          <span class="chat-f-fixed">${esc(modelLabel(convoModel(c)))}</span>
        </label>
        <p class="chat-f-note">Changed from the composer, where it applies to the next message —
          a session is not relabelled after the fact as having run on something it did not.</p>`
        : `
        <label class="chat-f">
          <span class="chat-f-l">Model</span>
          <select id="nsModel">
            ${list.map(m => `<option value="${esc(m.id)}"${m.id === state.model ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </label>
        <p class="chat-f-note">Kept on the session, so the thread reads back as the one that
          answered it. Changeable later from the composer.</p>`}`;
      modal.hidden = false;
      window.NMS.utils.enhanceSelects(modalBody);
      setTimeout(() => document.getElementById('nsName')?.focus(), 0);
    }

    openNewSession = () => openDialog('');
    openEditSession = (id) => openDialog(id);

    function commitModal() {
      const name = (document.getElementById('nsName')?.value || '').trim();
      const editing = modalBody.dataset.editing || '';

      if (editing) {
        const c = state.convos.find(x => x.id === editing);
        if (c) c.title = name;
      } else {
        const model = document.getElementById('nsModel')?.value || state.model;
        const c = startNewChat(model);
        // A name is optional: an unnamed session still titles itself from the first thing typed
        // into it, which is what the rail did before this dialog existed.
        if (name) c.title = name;
        state.model = model;
      }

      closeModal();
      renderRail(); renderThread(); renderPicker(); save();
      if (!editing) document.getElementById('chatInput')?.focus();
    }

    document.getElementById('chatNew').addEventListener('click', () => openNewSession());
    document.getElementById('chatModalGo').addEventListener('click', commitModal);
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); commitModal(); }
    });

    // Mode. Switching carries the operator to that mode's most recent session, or to nothing if it
    // has none — it never creates one, because an empty session nobody asked for is what fills a
    // rail with noise.
    document.getElementById('chatMode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b || state.sending) return;
      const next = b.dataset.mode;
      if (next === state.mode) return;
      closeModal();
      state.mode = next;
      const first = sessionsInMode()[0];
      state.activeId = first ? first.id : '';
      save();
      renderRail(); renderThread(); renderPicker();
    });

    // Home: no session open.
    document.getElementById('chatHome').addEventListener('click', () => {
      if (state.sending) return;
      closeRowMenu();
      state.activeId = '';
      state.inspectId = '';
      save();
      renderRail(); renderThread();
    });

    document.getElementById('chatList').addEventListener('click', (e) => {
      if (state.sending) return;

      // The overflow button is inside the row it belongs to, so a click on it is also a click on
      // the row. Checked first, and stopped, or opening the menu would also open the session.
      const listBtn = e.target.closest('#listMenu');
      if (listBtn) {
        e.stopPropagation();
        openListMenu(listBtn);
        return;
      }
      const menu = e.target.closest('[data-menu]');
      if (menu) {
        e.stopPropagation();
        openRowMenu(menu, menu.dataset.menu);
        return;
      }
      const row = e.target.closest('[data-convo]');
      if (row) selectConvo(row.dataset.convo);
    });

    // The topbar's refresh means "repaint from what is stored" here; there is nothing to re-fetch.
    window.NMS.onRefresh(async () => {
      if (state.sending) return;
      await load();
      renderRail();
      renderThread();
      loadCatalog();
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  // A reload is not an arrival. Coming to this page from somewhere else should land on Home — the
  // page used to mint a session on arrival, which put a blank thread in the rail for every visit
  // that turned out to be someone looking for an old one. But pressing refresh inside a session is
  // not leaving it, and dropping the operator back to Home for it loses their place for no reason.
  //
  // The browser knows which happened: a reload (or a back/forward restore) reports itself as such,
  // and everything else is a navigation.
  function resumedNavigation() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.type) return nav.type === 'reload' || nav.type === 'back_forward';
      // Pre-Navigation-Timing-2 browsers.
      const legacy = performance.navigation && performance.navigation.type;
      return legacy === 1 || legacy === 2;
    } catch (_) { return false; }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();

    // The stored id is only worth honouring if it still names a session in the mode being shown —
    // it can outlive the thread it points at (deleted in another tab, or dropped by the cap).
    const resume = resumedNavigation() && state.convos.some(
      c => c.id === state.activeId && (c.mode || 'chat') === state.mode);
    if (!resume) state.activeId = '';

    mount();
  });
}());
