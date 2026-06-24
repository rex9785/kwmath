// 운영진(조교) 레지스트리 — R2에 저장. D1 스키마 변경 없이 역할/승인 상태 관리.
//   키:  staff/{normalizedPhone}.json
//   값:  { phone, name, role:'staff', approved:bool, createdAt, approvedAt? }
//   원장(owner)은 별도 ADMIN_PHONES로 식별하므로 이 레지스트리에 없어도 됨.
//   비밀번호 자체는 기존 accounts(D1)에 저장 — 여기엔 역할/승인 메타만.

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
