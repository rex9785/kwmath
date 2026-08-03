// POST /api/student-register — 학생 등록 신청 (Cloudflare D1 students, 이전엔 Notion)
// 승인 대기('대기중') 상태로 생성. 계정은 admin 승인 후 생성(admin-approve-student).
import { normalizePhone } from './_auth.js';
import { createStudent } from './_db.js';
import { safeError } from './_errors.js';
import { resolveClassCode } from './class-options.js';
import { sendPushToUsers } from './_push.js';
import { logAudit, describeDevice } from './_auditlog.js';

// 새 회원가입 신청 → 원장(관우T) 앱 푸시 (inquiry.js와 동일 규약: __admin__ 채널)
const ADMIN_PUSH_USERS = ['__admin__'];

// best-effort — 절대 throw 안 함(푸시가 실패해도 등록은 성공 처리해야 함)
function notifyAdminNewSignup(context, env, info) {
  try {
    const who = String(info.name || '학생').slice(0, 20);
    const parts = [];
    if (info.grade) parts.push(String(info.grade).slice(0, 20));
    if (info.className) parts.push(String(info.className).slice(0, 30));
    const sub = parts.join(' · ');
    const p = sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: '🙋 새 학생 회원가입 신청 — 승인 대기중',
      body: who + (sub ? (' · ' + sub) : '') + ' — 탭하여 승인해 주세요',
      url: '/admin.html#pending',
      tag: 'kwmath-signup-pending',
    });
    if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
    else if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* best-effort */ }
}

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자 제외 (I, O, 0, 1)
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

// ═══════════════════════════════════════════════════════════════════════════
// 📓 2026-08-03 (§11-13) — 앞문(가입)을 뒷문(셀프수정 me-update.js)과 같은 규칙으로 막는다.
//   그전까지 이 API가 살균한 건 이름·학교·유입경로 4칸뿐이었고, 나머지는 body에서 꺼낸
//   그대로 createStudent로 넘어갔다. 그래서 두 가지가 새어 들어왔다.
//   (a) **길이 상한이 아예 없었다** — 감사로그는 칸마다 잘라 담지만(입력요약) D1은 안 자른다.
//       특이사항에 1MB를 넣어도 그대로 저장됐다.
//   (b) **고정 선택지에 폼에 없는 값이 들어갈 수 있었다** — 학년 "고4", 등급 "S등급" 같은 값도
//       통과했다. 그러면 학생이 나중에 me.html에서 저장을 누를 때 me-update.js가 그 값을
//       거부해서, **가입은 되는데 수정은 안 되는 학생**이 생긴다.
//   ⚠️ 아래 7개 목록은 me-update.js 21~27행 · register.html의 <option value>와 **글자 그대로**
//      같아야 한다. 한쪽만 고치면 앞문/뒷문이 다시 갈라진다(폼에 선택지를 추가할 땐 3곳 모두).
//   ⚠️ 저장형 XSS는 지금 확인한 범위에서는 0건이다(모든 렌더 사이트가 escape 중). 그래도 세척은
//      한다 — inquiry.js·surveys.js가 이미 같은 이유로 "이중 방어"를 걸어 뒀고, 나중에 escape를
//      빠뜨린 렌더 한 곳만 생겨도 바로 실물이 되기 때문이다.
// ═══════════════════════════════════════════════════════════════════════════
const GRADES = ['중2', '중3', '고1', '고2', '고3', 'N수'];
const RELATIONS = ['어머니', '아버지', '기타'];
const LEVELS = ['잘 모름', '1등급', '2등급', '3등급', '4등급', '5등급 이하'];
const MOCK_GRADES = ['1등급','2등급','3등급','4등급','5등급','6등급','7등급','8등급','9등급','미응시','모름'];
const ADVANCE = ['중3 과정','공통수학1','공통수학2','대수','미적분1','미적분2','확률과통계','기하','심화/실전','모름'];
const GOALS = ['수능', '내신', '기초다지기', '선행'];
const DAYS = ['월', '화', '수', '목', '금', '토', '일', '협의'];

// 목록 순서로 정렬 + 중복 제거 + 목록 밖 값 버리기 (me-update.js normDays/normGoals와 동일 규약)
function normDays(arr) {
  const set = new Set((Array.isArray(arr) ? arr : []).map(String));
  return DAYS.filter((d) => set.has(d));
}
function normGoals(arr) {
  const set = new Set((Array.isArray(arr) ? arr : []).map(String));
  return GOALS.filter((g) => set.has(g));
}

// 자유입력 세척 — inquiry.js·surveys.js와 동일 규약.
//   ⚠️ 위 safeName·safeSchool은 [<>"'] 로 **따옴표까지** 지운다 — 그 두 값은 admin 화면의
//      onclick="..." 속성 안으로 들어가기 때문이다. 반면 취약단원·희망대학·특이사항은 속성에
//      안 들어가고 textContent로만 그려지므로 [<>] 만 지운다. 따옴표를 지우면
//      「'수학의 정석' 3단원」 같은 정상 입력이 뭉개진다.
function clean(v) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').trim();
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}
  const {
    name, school, grade,
    parentPhone4, parentPhone, parentRelation, studentPhone,
    goals, level, classCode,
    mathMockGrade, mathMockScore, korMockGrade, engMockGrade,
    schoolMathGrade, advanceProgress, weakness, dreamUniv, availableDays,
    notes, referral, referralDetail,
  } = body;

  // ═══════════════════════════════════════════════════════════════════════════
  // 📓 2026-07-31 — 학생/학부모 가입 신청도 성공·거부·실패를 전부 남긴다.
  //   ⚠️ 가입은 로그인 **전**이라 actorOf(request)가 아무도 못 잡는다(헤더가 없다).
  //      → 신청자 본인을 actor로 못박는다(선례: inquiry.js 방문자 / makeup.js 학생).
  //   왜 거부까지 남기나: "가입했는데 목록에 안 보여요" 문의가 왔을 때,
  //   (a) 애초에 제출이 막혔는지 (b) 저장이 실패했는지 (c) 승인만 안 됐는지를 가르는 유일한 근거다.
  //   ⚠️ 이 API는 비밀번호를 아예 받지 않는다(승인 후 초기비번 0000 발급) → 남길 비번 자체가 없다.
  // ═══════════════════════════════════════════════════════════════════════════
  const 기기 = describeDevice(request.headers.get('User-Agent')) || '(알 수 없음)';
  const 짧게 = (v, n) => (v === null || v === undefined || v === '') ? '(빈칸)' : String(v).slice(0, n || 60);
  const 신청자이름 = String(name || '').replace(/[<>"']/g, '').trim().slice(0, 60);
  const 신청자 = {
    actor: String(parentPhone || studentPhone || '').replace(/\D/g, '') || '(번호없음)',
    actorRole: 'applicant',
    actorName: 신청자이름 || '(이름없음)',
  };
  // 신청서 전체를 그대로 넣으면 자유입력(취약단원·특이사항)이 길어 detail 20000자를 넘길 수 있다.
  //   → 칸마다 상한을 걸어 잘라 담는다.
  const 입력요약 = () => ({
    이름: 짧게(name, 60), 학교: 짧게(school, 60), 학년: 짧게(grade, 20),
    학부모연락처: 짧게(parentPhone, 20),
    학부모번호뒤4: (String(parentPhone4 || parentPhone || '').replace(/\D/g, '').slice(-4) || '(빈칸)'),
    학생연락처: 짧게(studentPhone, 20), 관계: 짧게(parentRelation, 20),
    모의고사수학등급: 짧게(mathMockGrade, 20), 모의고사수학원점수: 짧게(mathMockScore, 20),
    모의고사국어등급: 짧게(korMockGrade, 20), 모의고사영어등급: 짧게(engMockGrade, 20),
    내신수학등급: 짧게(schoolMathGrade, 20), 선행진도: 짧게(advanceProgress, 60),
    취약단원: 짧게(weakness, 300), 희망대학: 짧게(dreamUniv, 60),
    등원요일: Array.isArray(availableDays) ? availableDays.slice(0, 7).map((d) => String(d).slice(0, 10)) : 짧게(availableDays, 40),
    수강목적: Array.isArray(goals) ? goals.slice(0, 10).map((g) => String(g).slice(0, 40)) : 짧게(goals, 60),
    현재수준: 짧게(level, 40),
    특이사항: 짧게(notes, 500),
    유입경로: 짧게(referral, 40) + (referralDetail ? (' / ' + String(referralDetail).slice(0, 60)) : ''),
    반코드: String(classCode || '').replace(/\D/g, '') ? '입력됨' : '(빈칸)',
    기기: 기기,
  });
  const 거부 = async (사유) => {
    await logAudit(env, request, {
      action: 'student.register.reject',
      ...신청자,
      target: 신청자.actor, targetName: 신청자이름,
      summary: '학생 가입 신청 거부 — ' + 사유 + ' · ' + (신청자이름 || '(이름없음)'),
      detail: {
        결과: '거부(400). students 테이블에 아무 행도 생기지 않았다.',
        사유: 사유,
        입력값: 입력요약(),
        효과: '없음 — 신청서가 저장되지 않았다. 원장에게 승인 대기 알림도 가지 않았다. '
          + '신청자는 그 칸을 채워 다시 제출해야 한다.',
        비고: '이 API는 비밀번호를 받지 않는다(승인 후 초기비번 0000 발급). 긴 자유입력은 잘라서 남긴다.',
      },
    });
  };

  if (!name || !grade) { await 거부('이름 또는 학년 미입력'); return Response.json({ error: '이름과 학년은 필수입니다.' }, { status: 400 }); }
  // 이름 살균 — HTML 위험문자(< > " ') 제거. 저장형 XSS 방지: admin 화면 onclick 등 모든 렌더 사이트 보호.
  const safeName = String(name).replace(/[<>"']/g, '').trim().slice(0, 60);
  if (!safeName) { await 거부('이름이 살균 후 빈 값 — 금지문자(< > " \')만 들어왔다'); return Response.json({ error: '이름에 사용할 수 없는 문자가 포함되어 있습니다.' }, { status: 400 }); }
  // 학교명 — 필수(2026-07-24 관우T 지시). 이름과 동일 살균(저장형 XSS 방지: admin 렌더 보호).
  const safeSchool = String(school || '').replace(/[<>"']/g, '').trim().slice(0, 60);
  if (!safeSchool) { await 거부('학교명 미입력'); return Response.json({ error: '학교명을 입력해주세요.' }, { status: 400 }); }
  // 필수(2026-07-21 관우T 지시 + 07-24 학교명·유입경로 추가): 학교명 + 수학 성적(모의고사·내신 등급) + 선행 진도 + 취약단원 + 희망대학 + 등원요일 + 유입경로.
  // 선택(빈 값 허용): 국어·영어 등급, 원점수 등. 빈 값은 createStudent에서 ''/[]로 안전 저장.
  if (!mathMockGrade || !String(mathMockGrade).trim()) {
    await 거부('모의고사 수학 등급 미선택');
    return Response.json({ error: '모의고사 수학 등급을 선택해주세요. (모르면 "모름")' }, { status: 400 });
  }
  if (!schoolMathGrade || !String(schoolMathGrade).trim()) {
    await 거부('내신 수학 등급 미선택');
    return Response.json({ error: '내신 수학 등급을 선택해주세요. (모르면 "모름")' }, { status: 400 });
  }
  if (!advanceProgress || !String(advanceProgress).trim()) {
    await 거부('선행 진도 미선택');
    return Response.json({ error: '선행 진도를 선택해주세요. (모르면 "모름")' }, { status: 400 });
  }
  if (!weakness || !String(weakness).trim()) {
    await 거부('취약 단원 미입력');
    return Response.json({ error: '취약 단원을 입력해주세요. (특별히 없으면 "없음")' }, { status: 400 });
  }
  if (!dreamUniv || !String(dreamUniv).trim()) {
    await 거부('희망 대학/계열 미입력');
    return Response.json({ error: '희망 대학/계열을 입력해주세요. (아직 없으면 "미정")' }, { status: 400 });
  }
  if (!Array.isArray(availableDays) || availableDays.length === 0) {
    await 거부('등원 가능 요일 미선택');
    return Response.json({ error: '등원 가능 요일을 하나 이상 선택해주세요.' }, { status: 400 });
  }
  if (!referral || !String(referral).trim()) {
    await 거부('유입경로 미선택');
    return Response.json({ error: '저를 어떻게 알게 되셨는지 선택해주세요. (없으면 "기타")' }, { status: 400 });
  }

  // 🔑 반 코드 → 학원/반 자동 배정 (서버측 권위 검증). 코드 없거나 틀리면 등록 불가(스팸 차단).
  const resolvedClass = await resolveClassCode(env, classCode);
  if (!resolvedClass) {
    // 🔎 반 코드는 아무나 등록 못 하게 막는 관문이다. 틀린 코드가 반복되면
    //   (a) 코드를 잘못 안내했거나 (b) 코드를 모르는 외부인이 계속 시도 중이라는 뜻 →
    //   판별하려면 **입력된 코드까지** 남아야 한다(코드는 비밀번호가 아니라 반 식별자다).
    await logAudit(env, request, {
      action: 'student.register.code.reject',
      ...신청자,
      target: 신청자.actor, targetName: 신청자이름,
      summary: '학생 가입 신청 거부 — 반 코드 불일치 · ' + (신청자이름 || '이름없음')
        + ' · 입력코드 ' + (String(classCode || '').replace(/\D/g, '').slice(0, 20) || '(빈칸)'),
      detail: {
        결과: '거부(400). students 테이블에 아무 행도 생기지 않았다.',
        사유: '입력한 반 코드가 등록된 어느 학원·반 코드와도 일치하지 않는다.',
        입력한반코드: String(classCode || '').replace(/\D/g, '').slice(0, 20) || '(빈칸)',
        입력값: 입력요약(),
        효과: '없음. 학생도 안 생기고 원장 알림도 가지 않았다.',
        비고: '같은 사람이 반복해서 틀리면 안내한 코드가 바뀌었을 수 있다(반 코드는 /api/class-options에서 관리). '
          + '전혀 모르는 번호가 여러 코드를 시도하면 스팸 가입 시도로 본다.',
      },
    });
    return Response.json({ error: '반 코드가 올바르지 않습니다. 선생님께 받은 코드를 다시 확인해주세요.' }, { status: 400 });
  }

  let phone4 = (parentPhone4 || '').replace(/[^0-9]/g, '').slice(-4);
  if (phone4.length !== 4 && parentPhone) {
    const digits = parentPhone.replace(/[^0-9]/g, '');
    if (digits.length >= 4) phone4 = digits.slice(-4);
  }
  if (phone4.length !== 4) {
    await 거부('학부모 휴대폰 번호에서 뒤 4자리를 못 뽑음(형식 오류)');
    return Response.json({ error: '학부모 휴대폰 번호가 정확하지 않습니다.' }, { status: 400 });
  }

  if (mathMockScore !== null && mathMockScore !== undefined && mathMockScore !== '') {
    const n = Number(mathMockScore);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      await 거부('모의고사 수학 원점수가 0~100 범위 밖 — 입력값 "' + String(mathMockScore).slice(0, 20) + '"');
      return Response.json({ error: '모의고사 수학 원점수는 0~100 사이여야 합니다.' }, { status: 400 });
    }
  }

  // ── 고정 선택지 검증 (§11-13, 2026-08-03) ──────────────────────────────────
  //   register.html의 <option value>와 1:1이라 **정상적인 폼 제출은 여기서 안 걸린다**.
  //   걸리는 건 폼을 거치지 않고 API를 직접 호출한 경우다.
  //   빈 값 허용 여부:
  //     · 학년·모의수학·내신수학·선행진도 → 위에서 이미 "미입력"으로 막았다(빈 값 불허).
  //     · 관계·모의국어·모의영어 → register.html에 빈 선택지("")가 있다 → 빈 값 그대로 통과.
  //     · 현재수준(level) → 폼엔 빈 선택지가 없지만, 빈 값이면 아래에서 '잘 모름'으로 채운다.
  const 선택지 = [
    ['grade', '학년', grade, GRADES, false],
    ['parentRelation', '학부모와의 관계', parentRelation, RELATIONS, true],
    ['level', '현재 수학 수준', level, LEVELS, true],
    ['mathMockGrade', '모의고사 수학 등급', mathMockGrade, MOCK_GRADES, false],
    ['korMockGrade', '모의고사 국어 등급', korMockGrade, MOCK_GRADES, true],
    ['engMockGrade', '모의고사 영어 등급', engMockGrade, MOCK_GRADES, true],
    ['schoolMathGrade', '내신 수학 등급', schoolMathGrade, MOCK_GRADES, false],
    ['advanceProgress', '선행 진도', advanceProgress, ADVANCE, false],
  ];
  const 고른값 = {};
  for (const [키, 라벨, 원값, 목록, 빈값허용] of 선택지) {
    const v = String(원값 == null ? '' : 원값).trim();
    if (!v) {
      if (빈값허용) { 고른값[키] = ''; continue; }
      await 거부(라벨 + ' 미선택');
      return Response.json({ error: 라벨 + '을(를) 선택해주세요.' }, { status: 400 });
    }
    if (!목록.includes(v)) {
      await 거부(라벨 + ' 값이 선택지에 없음 — 입력값 "' + v.slice(0, 40) + '"');
      return Response.json({ error:라벨 + ' 값이 올바르지 않습니다. 목록에서 선택해주세요.' }, { status: 400 });
    }
    고른값[키] = v;
  }

  // ── 자유입력 세척 + 길이 (§11-13) ─────────────────────────────────────────
  //   길이 초과는 **자르지 않고 되돌려 보낸다** — me-update.js와 같은 규약이다.
  //   조용히 자르면 신청자는 다 저장된 줄 알고, 뒤 절반은 아무 데도 안 남는다.
  const safeWeakness  = clean(weakness);
  const safeDreamUniv = clean(dreamUniv);
  const safeNotes     = clean(notes);
  if (!safeWeakness) {
    await 거부('취약 단원이 세척 후 빈 값 — 금지문자(< >)만 들어왔다');
    return Response.json({ error: '취약 단원에 사용할 수 없는 문자만 입력되었습니다.' }, { status: 400 });
  }
  if (!safeDreamUniv) {
    await 거부('희망 대학/계열이 세척 후 빈 값 — 금지문자(< >)만 들어왔다');
    return Response.json({ error: '희망 대학/계열에 사용할 수 없는 문자만 입력되었습니다.' }, { status: 400 });
  }
  if (safeWeakness.length > 500) {
    await 거부('취약 단원 500자 초과 — ' + safeWeakness.length + '자');
    return Response.json({ error: '취약 단원은 500자 이내로 입력해주세요.' }, { status: 400 });
  }
  if (safeDreamUniv.length > 100) {
    await 거부('희망 대학/계열 100자 초과 — ' + safeDreamUniv.length + '자');
    return Response.json({ error: '희망 대학/계열은 100자 이내로 입력해주세요.' }, { status: 400 });
  }
  // 특이사항은 me-update.js에 선례가 없다(셀프수정 대상이 아니다) → 여기서 새로 정한다.
  //   register.html 안내가 "자유롭게 적어주세요"라 취약단원보다 넉넉히 1000자.
  if (safeNotes.length > 1000) {
    await 거부('특이사항 1000자 초과 — ' + safeNotes.length + '자');
    return Response.json({ error: '특이사항은 1000자 이내로 입력해주세요.' }, { status: 400 });
  }

  // 체크박스 2종 — 목록 밖 값은 버리고 목록 순서로 정렬한다(me-update.js와 동일).
  //   ⚠️ 등원요일은 위에서 "1개 이상"을 이미 막았지만, 목록 밖 값만 보내면 세척 후 0개가 된다 → 다시 막는다.
  //   ⚠️ 수강목적은 register.html이 0개 제출을 허용한다(필수 아님) → 0개를 막지 않는다.
  //      me-update.js는 "1개 이상"을 요구하지만 그건 **학생이 그 칸을 고쳤을 때만** 도는 검사라 서로 안 부딪힌다.
  const goalsArray = normGoals(Array.isArray(goals) ? goals : (goals ? [goals] : []));
  const daysArray  = normDays(availableDays);
  if (daysArray.length === 0) {
    await 거부('등원 가능 요일이 세척 후 0개 — 목록에 없는 값만 들어왔다');
    return Response.json({ error: '등원 가능 요일을 하나 이상 선택해주세요.' }, { status: 400 });
  }

  // 전화번호 — 정상 형식이면 normalizePhone이 010-1234-5678로 맞춰 준다.
  //   맞춰지지 않는 값(자릿수가 다른 번호 등)은 예전처럼 원문을 살리되, 세척하고 20자로 자른다.
  const safeStudentPhone = normalizePhone(studentPhone) || clean(studentPhone).slice(0, 20);
  const safeParentPhone  = normalizePhone(parentPhone)  || clean(parentPhone).slice(0, 20);

  const personalKey = generateKey();

  // 유입경로(필수, 2026-07-24) — 이름과 동일 살균(저장형 XSS 방지)
  const safeReferral = String(referral || '').replace(/[<>"']/g, '').trim().slice(0, 40);
  const safeReferralDetail = String(referralDetail || '').replace(/[<>"']/g, '').trim().slice(0, 60);

  // 유입경로 컬럼(2026-07 추가) — 기존 DB에 없으면 생성(멱등, 이미 있으면 조용히 실패)
  //   📓 예외가 나면 "이미 있음"(정상), 예외가 안 나면 **실제로 스키마가 바뀐 것**이다.
  //      그래서 성공했을 때만 남긴다 — 매 신청마다 남기면 의미 없는 로그가 쌓인다.
  //      DB 하나당 평생 한 번 찍히는 기록이고, "언제부터 유입경로가 쌓이기 시작했나"의 근거가 된다.
  const 새로만든컬럼 = [];
  try { await env.DB.prepare('ALTER TABLE students ADD COLUMN referral TEXT').run(); 새로만든컬럼.push('referral'); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE students ADD COLUMN referral_detail TEXT').run(); 새로만든컬럼.push('referral_detail'); } catch (_) {}
  if (새로만든컬럼.length) {
    await logAudit(env, request, {
      action: 'student.register.migrate',
      actor: 'system', actorRole: 'system', actorName: '가입 API 자동 스키마 보정',
      target: 'students', targetName: 'students 테이블',
      summary: 'students 테이블에 컬럼 추가 — ' + 새로만든컬럼.join(', ') + ' (학생 가입 신청 처리 중 자동 실행)',
      detail: {
        추가된컬럼: 새로만든컬럼,
        계기: '학생 가입 신청을 처리하다가 유입경로를 저장할 컬럼이 없어 자동으로 만들었다(멱등).',
        효과: '이제부터 유입경로(어떻게 알고 왔는지)가 학생마다 저장된다. '
          + '이 로그는 컬럼이 실제로 없었을 때만 남으므로 평소에는 찍히지 않는다.',
        비고: '기존 학생 행의 유입경로는 빈 값이다 — 이 시점 이후 신청자만 값이 있다.',
      },
    });
  }

  // 📓 여기 들어가는 값은 **전부 위에서 검증·세척을 통과한 것**이다(§11-13).
  //   body에서 꺼낸 원본을 그대로 쓰는 칸은 mathMockScore 하나뿐이고, 그건
  //   (a) 위에서 0~100 범위를 확인했고 (b) _db.js가 Number()로 바꿔 넣는다(빈 값이면 null).
  const r = await createStudent(env, {
    name: safeName, school: safeSchool, grade: 고른값.grade,
    parentPhone4: phone4,
    studentPhone: safeStudentPhone,
    parentPhone:  safeParentPhone,
    parentRelation: 고른값.parentRelation,
    goals: goalsArray,
    level: 고른값.level || '잘 모름',
    academy: resolvedClass.academy,
    className: resolvedClass.className,
    mathMockGrade: 고른값.mathMockGrade,
    mathMockScore,
    korMockGrade: 고른값.korMockGrade,
    engMockGrade: 고른값.engMockGrade,
    schoolMathGrade: 고른값.schoolMathGrade,
    advanceProgress: 고른값.advanceProgress,
    availableDays: daysArray,
    weakness: safeWeakness, dreamUniv: safeDreamUniv, notes: safeNotes,
    referral: safeReferral, referralDetail: safeReferralDetail,
    personalKey,
    approvalStatus: '대기중',
  });
  if (!r.ok) {
    // 🔴 신청자는 "실패했다"는 화면만 보고 끝난다. 여기 안 남기면 시도 자체가 증발한다.
    await logAudit(env, request, {
      action: 'student.register.fail',
      ...신청자,
      target: 신청자.actor, targetName: safeName,
      summary: '학생 가입 신청 저장 실패 — ' + safeName + ' · ' + resolvedClass.academy + ' / ' + resolvedClass.className,
      detail: {
        결과: '실패. students 테이블에 행이 만들어지지 않았다(D1 INSERT 오류).',
        오류: String(r.error || '(내용 없음)').slice(0, 1000),
        입력값: 입력요약(),
        배정될뻔한학원반: resolvedClass.academy + ' / ' + resolvedClass.className,
        효과: '신청이 접수되지 않았다. 승인 대기 목록에도 없고 원장 푸시도 가지 않았다. 다시 신청해야 한다.',
        비고: '이 로그가 "신청했는데 목록에 없다"는 문의의 유일한 근거다.',
      },
    });
    return safeError(r.error || 'createStudent failed', env, { message: '학생 등록에 실패했습니다.' });
  }

  // 📓 학생 1명이 실제로 생긴 자리. createStudent가 돌려주는 after(실제 저장 컬럼)를 통째로 남긴다.
  //   전(before)은 없다 — 새로 만드는 행이라 이전 값이라는 게 존재하지 않는다.
  await logAudit(env, request, {
    action: 'student.register',
    ...신청자,
    target: String(r.id || ''), targetName: safeName,
    summary: '학생 가입 신청 접수 — ' + safeName + ' · ' + resolvedClass.academy + ' / '
      + resolvedClass.className + ' (승인 대기) · ' + 기기,
    detail: {
      결과: 'students 테이블에 1행 생성(승인상태 "대기중"). 계정은 아직 없다.',
      학생id: r.id || null,
      // 저장된 컬럼 전부. 자유입력(특이사항 등)이 길 수 있어 칸마다 300자로 자른다(detail 20000자 상한).
      저장된값: (() => {
        const o = {};
        try {
          for (const [k, v] of Object.entries(r.after || {})) o[k] = (typeof v === 'string') ? v.slice(0, 300) : v;
        } catch (_) {}
        return o;
      })(),
      배정: {
        학원: resolvedClass.academy, 반: resolvedClass.className,
        근거: '신청자가 입력한 반 코드를 서버가 대조해 정했다(클라이언트가 고를 수 없다).',
      },
      개인키: personalKey,
      기기: 기기,
      효과: '아직 로그인 계정이 없다. 원장이 /admin에서 승인해야 계정(초기비번 0000)이 만들어지고 로그인이 된다. '
        + '승인 전까지는 학생 명단·랭킹·통계·출결 대상에 나오지 않는다.',
      비고: '원장 앱으로 "승인 대기" 푸시를 보내지만, 푸시가 실패해도 이 접수는 그대로 유지된다 '
        + '(푸시 성패는 push 계열 로그에서 확인).',
    },
  });

  // 원장(관우T) 앱으로 "새 회원가입 · 승인 대기중" 즉시 푸시 (best-effort, 실패해도 등록은 성공)
  notifyAdminNewSignup(context, env, { name: safeName, grade: 고른값.grade, className: resolvedClass.className });

  return Response.json({
    ok: true,
    pending: true,
    personalKey,
    id: String(r.id),
    message: '등록 신청이 접수됐습니다. 관우T 승인 후 로그인 가능합니다.\n승인되면 학부모/학생 휴대폰 번호로 로그인하실 수 있어요. (초기 비밀번호 0000)',
  });
}
