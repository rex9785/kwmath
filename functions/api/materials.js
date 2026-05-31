// GET /api/materials
//   - 무인증: 공개 자료(공개=true & 전화번호끝4자리 비어있음)만 반환
//   - ?phone4=NNNN: 사적 자료 조회는 인증 필수 — 토큰의 본인/자녀 끝4자리 일치 또는 admin만.
//     미인증·타인 번호면 phone4 무시하고 공개 자료만 반환. (4자리 전수조사 IDOR 차단)
import { bearerFromRequest, verifyToken, fetchStudentsByPhone } from './_auth.js';
import { safeError } from './_errors.js';

const DB = '34f134c4b2324685a62357c27c0aa919';

const last4 = (s) => String(s || '').replace(/\D/g, '').slice(-4);

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  let phone4 = (url.searchParams.get('phone4') || '').trim();
  const category = url.searchParams.get('category');

  // 🔒 사적 자료(phone4) 조회는 인증 필수 — 본인/자녀 끝4자리 또는 admin만.
  if (phone4) {
    const token = bearerFromRequest(request);
    const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
    if (!isAdmin) {
      const allowed = new Set();
      const payload = token ? await verifyToken(env, token) : null;
      if (payload && payload.phone) {
        allowed.add(last4(payload.phone));
        try {
          const studs = await fetchStudentsByPhone(env, payload.phone);
          for (const s of (studs || [])) {
            if (s.parentPhone)  allowed.add(last4(s.parentPhone));
            if (s.studentPhone) allowed.add(last4(s.studentPhone));
          }
        } catch (_) {}
      }
      if (!allowed.has(phone4)) phone4 = ''; // 미인증·타인 번호 → 공개 자료만
    }
  }

  let filter;
  if (phone4) {
    filter = { or: [
      { property: '전화번호끝4자리', rich_text: { equals: phone4 } },
      { and: [{ property: '공개', checkbox: { equals: true } }, { property: '전화번호끝4자리', rich_text: { is_empty: true } }] },
    ]};
  } else {
    filter = { and: [{ property: '공개', checkbox: { equals: true } }, { property: '전화번호끝4자리', rich_text: { is_empty: true } }] };
  }

  if (category) {
    const catFilter = { property: '카테고리', select: { equals: category } };
    filter = filter.and ? { and: [...filter.and, catFilter] } : { and: [filter, catFilter] };
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter, sorts: [{ property: '업로드일', direction: 'descending' }] }),
    });
    const data = await res.json();
    const files = (data.results || []).map(p => ({
      id: p.id,
      title: p.properties['제목']?.title?.[0]?.plain_text || '',
      fileName: p.properties['파일명']?.rich_text?.[0]?.plain_text || '',
      r2Key: p.properties['R2키']?.rich_text?.[0]?.plain_text || '',
      category: p.properties['카테고리']?.select?.name || '',
      fileSize: p.properties['파일크기']?.rich_text?.[0]?.plain_text || '',
      uploadDate: p.properties['업로드일']?.date?.start || '',
      isPublic: p.properties['공개']?.checkbox || false,
    }));
    return Response.json(files);
  } catch (e) {
    return safeError(e, env, { message: '자료를 불러오지 못했습니다.' });
  }
}
