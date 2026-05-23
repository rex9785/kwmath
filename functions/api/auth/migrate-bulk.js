// POST /api/auth/migrate-bulk
// admin 전용 (Authorization: Bearer <ADMIN_PASSWORD>)
// 학생 DB의 모든 학생을 순회하면서 학부모 휴대폰 + 학생 휴대폰을
// 계정 DB에 초기 비밀번호 '0000'으로 일괄 등록. 이미 있는 휴대폰은 스킵.

import { ACCOUNTS_DB, STUDENTS_DB, normalizePhone, createAccount, findAccountByPhone, jsonError } from '../_auth.js';

const INITIAL_PASSWORD = '0000';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonError('POST만 허용', 405);

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    return jsonError('관리자 인증이 필요합니다.', 401);
  }

  const headers = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // 1) 학생 DB 전체 조회
  const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ page_size: 100 }),
  });
  const sData = await sRes.json();
  if (sData.object === 'error') return jsonError('학생 DB 조회 실패: ' + sData.message, 500);

  const rt = (p, k) => (p[k]?.rich_text || [])[0]?.plain_text || '';
  const ttl= (p, k) => (p[k]?.title || [])[0]?.plain_text || '';

  // 모든 학생에서 휴대폰 수집 (학부모/학생 양쪽) + 비고용 매핑
  const phoneMap = new Map(); // phone -> [{role, studentName}]
  for (const page of (sData.results || [])) {
    if (page.archived || page.in_trash) continue;
    const props = page.properties || {};
    const name = ttl(props, '이름');
    const pp = normalizePhone(rt(props, '학부모 휴대폰'));
    const sp = normalizePhone(rt(props, '학생 연락처'));
    if (pp) {
      const arr = phoneMap.get(pp) || [];
      arr.push({ role: 'parent', studentName: name });
      phoneMap.set(pp, arr);
    }
    if (sp) {
      const arr = phoneMap.get(sp) || [];
      arr.push({ role: 'student', studentName: name });
      phoneMap.set(sp, arr);
    }
  }

  // 2) 계정 DB 기존 휴대폰 조회 (중복 회피용)
  const aRes = await fetch(`https://api.notion.com/v1/databases/${ACCOUNTS_DB}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ page_size: 100 }),
  });
  const aData = await aRes.json();
  const existingPhones = new Set();
  if (aData.results) {
    for (const p of aData.results) {
      if (p.archived || p.in_trash) continue;
      const ph = ttl(p.properties || {}, '휴대폰');
      if (ph) existingPhones.add(ph);
    }
  }

  // 3) 신규 휴대폰만 계정 생성
  const result = { totalPhones: phoneMap.size, created: 0, skipped: 0, failed: 0, errors: [] };
  for (const [phone, infos] of phoneMap.entries()) {
    if (existingPhones.has(phone)) { result.skipped++; continue; }
    const note = infos.map(i => `${i.role}:${i.studentName}`).join(', ');
    const ret = await createAccount(env, phone, INITIAL_PASSWORD, true, note);
    if (ret.ok) result.created++;
    else {
      result.failed++;
      result.errors.push(`${phone}: ${ret.error}`);
    }
  }

  return Response.json({ ok: true, ...result, initialPassword: INITIAL_PASSWORD });
}
