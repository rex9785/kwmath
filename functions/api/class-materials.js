// GET /api/class-materials?key=... — 개인 키 인증 후 그 반 자료 목록
// 자료는 업로드 시 R2의 class/{학원}_{반}/{MMDD}/ 구조로 저장됨 → 그 prefix를 나열한다.
// (이전엔 Notion 자료 DB에서 읽었으나, 새 업로드는 R2 키로만 분류되므로 R2를 직접 읽도록 전환)
import { safeError } from './_errors.js';

function fileEntry(obj) {
  const fname = (obj.key || '').split('/').pop().replace(/^\d+_/, '');
  return {
    id: obj.key,
    title: fname,
    fileName: fname,
    r2Key: obj.key,
    category: '수업자료',
    fileSize: obj.size > 1024 * 1024
      ? (obj.size / (1024 * 1024)).toFixed(1) + 'MB'
      : Math.round(obj.size / 1024) + 'KB',
    uploadDate: obj.uploaded ? new Date(obj.uploaded).toISOString().slice(0, 10) : '',
  };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = (url.searchParams.get('key') || '').trim();
  if (!key) return Response.json({ error: '키가 필요합니다' }, { status: 400 });

  try {
    const st = await env.DB.prepare(
      'SELECT name, academy, class_name FROM students WHERE personal_key = ? LIMIT 1'
    ).bind(key).first();
    if (!st) return Response.json({ error: '인증 실패' }, { status: 401 });

    const studentName = st.name || '';
    const academy = st.academy || '';
    const className = st.class_name || '';
    if (!className) return Response.json({ error: '배정된 반이 없습니다. 선생님께 문의하세요.' }, { status: 403 });

    // 업로드 폴더 구조: class/{학원}_{반}/{MMDD}/{파일}
    const prefix = 'class/' + academy + '_' + className + '/';
    const listed = await env.BUCKET.list({ prefix, limit: 200 });
    const files = (listed.objects || [])
      .filter(o => ((o.key || '').split('/').pop() || '').length > 0)
      .map(fileEntry)
      .sort((a, b) => (b.uploadDate || '').localeCompare(a.uploadDate || ''));

    return Response.json({ ok: true, studentName, className, files });
  } catch (e) {
    return safeError(e, env, { message: '자료를 불러오지 못했습니다.' });
  }
}
