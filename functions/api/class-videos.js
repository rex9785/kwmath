// GET /api/class-videos?name=홍길동&phone4=1234
// 학생 인증 후 해당 반의 수업 영상 목록 반환 + 접근 로그 저장

const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const url    = new URL(request.url);
  const name   = (url.searchParams.get('name')   || '').trim();
  const phone4 = (url.searchParams.get('phone4') || '').trim();

  if (!name || !phone4 || phone4.length !== 4)
    return Response.json({ error: '이름과 전화번호 끝 4자리를 입력해주세요.' }, { status: 400 });

  try {
    // 1. Notion에서 학생 인증 + 소속 반 확인
    const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: { and: [
        { property: '이름',                  title:     { equals: name   } },
        { property: '학부모 연락처 끝4자리', rich_text: { equals: phone4 } },
      ]}}),
    });
    const sData = await sRes.json();
    if (!sData.results?.length)
      return Response.json({ error: '이름 또는 전화번호가 일치하지 않습니다.' }, { status: 401 });

    // 2. 학생의 학원·반 가져오기
    const props     = sData.results[0].properties;
    const school    = props['학원']?.select?.name || '';
    const className = props['반']?.select?.name   || ''; // 반이 없으면 학원 전체 영상 표시

    if (!school)
      return Response.json({ error: '수강 정보가 등록되어 있지 않습니다. 선생님께 문의해주세요.' }, { status: 404 });

    // 3. R2에서 해당 반의 영상 코드 목록 조회
    const listed = await env.BUCKET.list({ prefix: 'video-codes/' });
    const videos = [];

    for (const obj of listed.objects) {
      try {
        const item = await env.BUCKET.get(obj.key);
        if (!item) continue;
        const data = await item.json();

        // 학원 일치 + (반이 설정된 경우 반도 일치해야 함)
        const schoolMatch = data.school === school;
        const classMatch  = !className || data.class_name === className;
        if (schoolMatch && classMatch && data.active) {
          const locked = data.require_code === true;
          videos.push({
            code:        data.code,
            // 잠긴 영상은 URL 숨김. 학생이 코드 입력 후 video-access API로 받음.
            youtube_url: locked ? null : data.youtube_url,
            locked:      locked,
            title:       data.title,
            date:        data.date,
            school:      data.school,
            class_name:  data.class_name,
          });
        }
      } catch { /* 개별 파일 오류 무시 */ }
    }

    // 날짜 최신순 정렬
    videos.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    if (!videos.length)
      return Response.json({ error: '등록된 수업 영상이 없습니다. 선생님께 문의해주세요.' }, { status: 404 });

    // 4. 접근 로그 저장 (최신 영상에만)
    const latestCode = videos[0].code;
    if (latestCode) {
      try {
        const logObj = await env.BUCKET.get(`video-codes/${latestCode}.json`);
        if (logObj) {
          const logData = await logObj.json();
          const log = logData.access_log || [];
          const now = Date.now();
          const recent = log.find(l => l.name === name && now - new Date(l.time).getTime() < 5 * 60 * 1000);
          if (!recent) {
            log.push({ name, time: new Date().toISOString() });
            logData.access_log   = log;
            logData.access_count = log.length;
            await env.BUCKET.put(`video-codes/${latestCode}.json`, JSON.stringify(logData), {
              httpMetadata: { contentType: 'application/json' },
            });
          }
        }
      } catch { /* 로그 실패해도 영상은 제공 */ }
    }

    return Response.json({
      ok:         true,
      student:    name,
      school,
      class_name: className,
      videos:     videos.slice(0, 10), // 최근 10개
    });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
