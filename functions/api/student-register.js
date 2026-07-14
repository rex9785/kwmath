// POST /api/student-register — 학생 등록 신청 (Cloudflare D1 students, 이전엔 Notion)
// 승인 대기('대기중') 상태로 생성. 계정은 admin 승인 후 생성(admin-approve-student).
import { normalizePhone } from './_auth.js';
import { createStudent } from './_db.js';
import { safeError } from './_errors.js';
import { resolveClassCode } from './class-options.js';
import { sendPushToUsers } from './_push.js';

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
    notes,
  } = body;

  if (!name || !grade) return Response.json({ error: '이름과 학년은 필수입니다.' }, { status: 400 });
  // 이름 살균 — HTML 위험문자(< > " ') 제거. 저장형 XSS 방지: admin 화면 onclick 등 모든 렌더 사이트 보호.
  const safeName = String(name).replace(/[<>"']/g, '').trim().slice(0, 60);
  if (!safeName) return Response.json({ error: '이름에 사용할 수 없는 문자가 포함되어 있습니다.' }, { status: 400 });
  const requiredExtras = { mathMockGrade, korMockGrade, engMockGrade, schoolMathGrade, advanceProgress, weakness, dreamUniv };
  for (const [k, v] of Object.entries(requiredExtras)) {
    if (!v || (typeof v === 'string' && !v.trim())) {
      return Response.json({ error: '추가 정보가 누락되었습니다: ' + k + ' (모르면 "모름" 선택)' }, { status: 400 });
    }
  }
  if (!Array.isArray(availableDays) || !availableDays.length) {
    return Response.json({ error: '등원 가능 요일을 선택해주세요. (모르면 "협의")' }, { status: 400 });
  }

  // 🔑 반 코드 → 학원/반 자동 배정 (서버측 권위 검증). 코드 없거나 틀리면 등록 불가(스팸 차단).
  const resolvedClass = await resolveClassCode(env, classCode);
  if (!resolvedClass) {
    return Response.json({ error: '반 코드가 올바르지 않습니다. 선생님께 받은 코드를 다시 확인해주세요.' }, { status: 400 });
  }

  let phone4 = (parentPhone4 || '').replace(/[^0-9]/g, '').slice(-4);
  if (phone4.length !== 4 && parentPhone) {
    const digits = parentPhone.replace(/[^0-9]/g, '');
    if (digits.length >= 4) phone4 = digits.slice(-4);
  }
  if (phone4.length !== 4) return Response.json({ error: '학부모 휴대폰 번호가 정확하지 않습니다.' }, { status: 400 });

  if (mathMockScore !== null && mathMockScore !== undefined && mathMockScore !== '') {
    const n = Number(mathMockScore);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return Response.json({ error: '모의고사 수학 원점수는 0~100 사이여야 합니다.' }, { status: 400 });
    }
  }

  const goalsArray = Array.isArray(goals) ? goals : (goals ? [goals] : []);
  const daysArray  = Array.isArray(availableDays) ? availableDays : [];
  const personalKey = generateKey();

  const r = await createStudent(env, {
    name: safeName, school, grade,
    parentPhone4: phone4,
    studentPhone: normalizePhone(studentPhone) || studentPhone || '',
    parentPhone:  normalizePhone(parentPhone)  || parentPhone  || '',
    parentRelation,
    goals: goalsArray,
    level: level || '잘 모름',
    academy: resolvedClass.academy,
    className: resolvedClass.className,
    mathMockGrade, mathMockScore, korMockGrade, engMockGrade,
    schoolMathGrade, advanceProgress,
    availableDays: daysArray,
    weakness, dreamUniv, notes,
    personalKey,
    approvalStatus: '대기중',
  });
  if (!r.ok) return safeError(r.error || 'createStudent failed', env, { message: '학생 등록에 실패했습니다.' });

  // 원장(관우T) 앱으로 "새 회원가입 · 승인 대기중" 즉시 푸시 (best-effort, 실패해도 등록은 성공)
  notifyAdminNewSignup(context, env, { name: safeName, grade, className: resolvedClass.className });

  return Response.json({
    ok: true,
    pending: true,
    personalKey,
    id: String(r.id),
    message: '등록 신청이 접수됐습니다. 관우T 승인 후 로그인 가능합니다.\n승인되면 학부모/학생 휴대폰 번호로 로그인하실 수 있어요. (초기 비밀번호 0000)',
  });
}
