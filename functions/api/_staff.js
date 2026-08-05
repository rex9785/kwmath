// 운영진(조교) 레지스트리 — R2에 저장. D1 스키마 변경 없이 역할/승인 상태 관리.
//   키:  staff/{normalizedPhone}.json
//   값:  { phone, name, role:'staff', approved:bool, createdAt, approvedAt?, academy?, hourlyWage?, account?,
//          lockedUpto?, lockedAt? }
//        account = 월급 받을 계좌(은행명+번호 자유텍스트). 가입시 입력, 본인/원장이 나중에 변경 가능.
//        lockedUpto = 급여 확정 마감일 'YYYY-MM-DD'. 이 날짜까지(그날 포함) 근무기록을 조교가 못 고친다.
//          원장이 /admin-staff에서 「지급확정」을 누르면 그 구간 끝(지급월 5일)으로 세팅된다.
//          ⚠️ 레코드를 새로 만들어 덮어쓰면 이 값이 날아간다 — 반드시 getStaffRecord로 읽어 필드만 고쳐 저장할 것.
//          (staff-register.js는 같은 번호면 409로 막고 아예 안 쓴다. 2026-08-05 확인)
//   원장(owner)은 별도 ADMIN_PHONES로 식별하므로 이 레지스트리에 없어도 됨.
//   비밀번호 자체는 기존 accounts(D1)에 저장 — 여기엔 역할/승인/배정 메타만.
import { normalizePhone } from './_auth.js';

const KEY = (phone) => 'staff/' + encodeURIComponent(phone) + '.json';

export async function getStaffRecord(env, phone) {
  if (!phone) return null;
  try {
    const obj = await env.BUCKET.get(KEY(phone));
    if (!obj) return null;
    return JSON.parse(await obj.text());
  } catch (_) { return null; }
}

export async function putStaffRecord(env, phone, rec) {
  await env.BUCKET.put(KEY(phone), JSON.stringify(rec), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function deleteStaffRecord(env, phone) {
  try { await env.BUCKET.delete(KEY(phone)); } catch (_) {}
}

// 전체 조교 목록 (승인 관리 화면용). 최신 신청이 위로 오게 createdAt 내림차순.
export async function listStaff(env) {
  const out = [];
  try {
    const listed = await env.BUCKET.list({ prefix: 'staff/' });
    for (const o of (listed.objects || [])) {
      try {
        const obj = await env.BUCKET.get(o.key);
        if (!obj) continue;
        out.push(JSON.parse(await obj.text()));
      } catch (_) {}
    }
  } catch (_) {}
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

// ───────────────────────────────────────────────────────────
// 학원 스코프 — 미들웨어가 검증해 세팅한 X-Staff-Phone 헤더로 "이 조교가 맡은 학원"을 알아낸다.
//   반환값:
//     null      → 원장/비조교 (헤더 없음) = 전체 접근, 스코핑 안 함
//     ''        → 조교지만 담당 학원 미배정 = 아무 학생도 못 봄(빈 결과)
//     '학원명'  → 그 학원 학생만
//   ⚠️ X-Staff-Phone은 _middleware.js가 ast_ 토큰을 검증한 뒤에만 세팅하며, 외부 주입 헤더는 지운다.
//      따라서 이 값은 위조 불가(클라이언트는 ADMIN_PASSWORD를 모르므로 번역을 못 통과).
export async function staffScopeAcademy(env, request) {
  const ph = String(request.headers.get('X-Staff-Phone') || '').replace(/\D/g, '');
  if (!ph) return null;                                   // 원장 등 → 전체
  const rec = await getStaffRecord(env, normalizePhone(ph) || ph);
  return rec ? (rec.academy || '') : '';                  // 레코드 없거나 학원 미배정 → '' (빈 결과)
}
