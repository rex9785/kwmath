import { safeError } from './_errors.js';
import { logAudit, diffFields } from './_auditlog.js';
// POST /api/video-update  (admin only)
// 영상의 require_code / class_name / active 변경
// body: { code, require_code?, class_name?, active? }
export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    await logAudit(env, request, {
      action: 'video.update.denied',
      summary: '영상 설정 변경 거부 — 관리자 인증 실패',
      detail: {
        토큰이왔나: !!token,
        서버에관리자비밀번호가설정돼있나: !!env.ADMIN_PASSWORD,
        비고: '토큰·비밀번호 값 자체는 로그에 남기지 않는다(왔는지 여부만).',
        효과: '영상은 하나도 바뀌지 않음 — 학생이 보는 화면 그대로',
      },
    });
    return Response.json({ error: '인증 실패' }, { status: 401 });
  }

  let body = {};
  try { body = await request.json(); } catch {}

  // 어떤 칸을 바꾸라고 보냈는지. 아래 여러 로그에서 공통으로 쓴다.
  //   ⚠️ require_code·active 는 반드시 true/false 여야 반영된다. 'true' 같은 글자값은 조용히 무시된다.
  const 요청값 = {
    코드입력필요: typeof body.require_code === 'boolean' ? body.require_code
      : (body.require_code === undefined ? '(안 보냄)' : '(형식이 true/false가 아님: ' + String(body.require_code).slice(0, 40) + ')'),
    공개여부: typeof body.active === 'boolean' ? body.active
      : (body.active === undefined ? '(안 보냄)' : '(형식이 true/false가 아님: ' + String(body.active).slice(0, 40) + ')'),
    반이름: typeof body.class_name === 'string' ? body.class_name.trim()
      : (body.class_name === undefined ? '(안 보냄)' : '(형식이 글자값이 아님: ' + String(body.class_name).slice(0, 40) + ')'),
  };

  const code = (body.code || '').trim().toUpperCase();
  if (!code) {
    await logAudit(env, request, {
      action: 'video.update.fail',
      summary: '영상 설정 변경 실패 — 어느 영상인지(code)를 안 보냄',
      detail: {
        요청값: 요청값,
        해석: '관리자 화면에서 영상을 고르지 않고 저장을 눌렀거나, 요청 본문이 JSON으로 안 읽혔다',
        효과: '영상은 하나도 바뀌지 않음',
      },
    });
    return Response.json({ error: 'code 필요' }, { status: 400 });
  }

  try {
    const key = `video-codes/${code}.json`;
    const obj = await env.BUCKET.get(key);
    if (!obj) {
      await logAudit(env, request, {
        action: 'video.update.fail',
        target: code,
        summary: '영상 설정 변경 실패 — 코드 [' + code + ']에 해당하는 영상이 없음',
        detail: {
          코드: code, R2키: key,
          요청값: 요청값,
          해석: '코드 오타이거나, 그 사이 이 영상이 지워졌다(직접 삭제 또는 같은 반·같은 날짜 재업로드로 자동 대체). '
            + '같은 시간대의 video.delete · video.code.overwrite 기록을 같이 보면 어느 쪽인지 알 수 있다.',
          효과: '영상은 하나도 바뀌지 않음',
        },
      });
      return Response.json({ error: '해당 코드 영상 없음' }, { status: 404 });
    }

    const data = await obj.json();
    // 🔎 2026-07-31 — 바로 아래 세 줄이 data 를 **그 자리에서** 뜯어고친다(in-place).
    //   손대기 전에 통째로 복사해 두지 않으면 로그의 "전"이 "후"와 같은 객체를 가리켜 아무 의미가 없다.
    //   (class-options.js · staff-approve.js 에서 똑같은 함정에 실제로 걸렸다.)
    const 전 = JSON.parse(JSON.stringify(data));

    let changed = false;
    if (typeof body.require_code === 'boolean') { data.require_code = body.require_code; changed = true; }
    if (typeof body.active === 'boolean')       { data.active = body.active; changed = true; }
    if (typeof body.class_name === 'string')    { data.class_name = body.class_name.trim(); changed = true; }
    if (!changed) {
      // 무변경(no-op)도 남긴다 — "분명히 바꿨는데 그대로다"는 신고가 오면 여기가 답이다.
      await logAudit(env, request, {
        action: 'video.update.noop',
        target: code, targetName: data.title || '',
        summary: '영상 [' + code + '] 설정 변경 요청이 왔지만 바꿀 값이 하나도 없었음 — ' + (data.title || '제목없음'),
        detail: {
          코드: code, R2키: key,
          지금값: {
            제목: 전.title || '', 날짜: 전.date || '', 학원: 전.school || '', 반: 전.class_name || '',
            코드입력필요: 전.require_code === true, 공개여부: 전.active !== false,
          },
          요청값: 요청값,
          해석: 'require_code·active 는 true/false 로, class_name 은 글자값으로 보내야 반영된다. '
            + '셋 다 아예 안 보냈거나 형식이 맞지 않아 한 칸도 반영되지 않았다.',
          효과: 'R2 파일을 아예 건드리지 않음(수정시각도 그대로) — 학생이 보는 화면 변화 없음',
        },
      });
      return Response.json({ error: '변경할 필드 없음' }, { status: 400 });
    }

    data.updated_at = new Date().toISOString();
    await env.BUCKET.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
    });

    // 📓 2026-07-31 — 이 세 칸은 "학생이 이 영상을 볼 수 있느냐"를 직접 좌우한다.
    //   여태 기록이 없어서, 영상이 안 보인다는 신고가 와도 누가 언제 잠갔는지 알 수 없었다.
    const d = diffFields(전, data, ['require_code', 'active', 'class_name']);
    const 효과 = [];
    if (d.바뀐칸.includes('active')) 효과.push(data.active
      ? '학생 앱 영상 목록에 다시 나타나고, 수업코드로도 열린다'
      : '학생 앱 영상 목록에서 사라지고, 수업코드를 넣어도 "비활성화된 코드입니다"가 뜬다');
    if (d.바뀐칸.includes('require_code')) 효과.push(data.require_code
      ? '앱 목록에서 자물쇠가 걸리고 수업코드를 입력해야 볼 수 있다'
      : '앱 목록에서 수업코드 없이 바로 재생된다');
    if (d.바뀐칸.includes('class_name')) 효과.push(
      '이 영상이 보이는 반이 "' + (전.class_name || '(빈칸)') + '" → "' + (data.class_name || '(빈칸)') + '"로 바뀐다 — '
      + '전에 보던 반 학생은 목록에서 사라지고, 새 반 학생에게 나타난다');

    await logAudit(env, request, {
      action: 'video.update',
      target: code, targetName: data.title || '',
      summary: '영상 [' + code + '] 설정 변경 — ' + (d.요약 || '(보낸 값이 원래 값과 같음)')
        + ' · ' + (data.title || '제목없음') + (data.date ? ' · ' + data.date : ''),
      detail: {
        코드: code, R2키: key,
        영상: {
          제목: data.title || '', 날짜: data.date || '', 학원: data.school || '',
          반: data.class_name || '', 유튜브: data.youtube_url || '',
          등록시각: data.created_at || '', 열람횟수: data.access_count || 0,
        },
        바뀐칸: d.바뀐칸,
        변경: d.변경,
        한글로: {
          코드입력필요: d.변경.require_code
            ? ((전.require_code === true ? '필요' : '불필요') + ' → ' + (data.require_code === true ? '필요' : '불필요'))
            : '안 건드림',
          공개여부: d.변경.active
            ? ((전.active !== false ? '공개' : '비공개') + ' → ' + (data.active !== false ? '공개' : '비공개'))
            : '안 건드림',
          반이름: d.변경.class_name
            ? ('"' + (전.class_name || '(빈칸)') + '" → "' + (data.class_name || '(빈칸)') + '"')
            : '안 건드림',
        },
        요청값: 요청값,
        수정시각: { 전: 전.updated_at || '(수정된 적 없음 — 등록 후 처음 손댐)', 후: data.updated_at },
        효과: 효과.length ? 효과.join(' · ')
          : '보낸 값이 원래 값과 같아 학생이 보는 화면은 그대로다(파일 수정시각만 갱신됨)',
      },
    });

    return Response.json({ ok: true, code, video: data });
  } catch (e) {
    await logAudit(env, request, {
      action: 'video.update.fail',
      target: code,
      summary: '영상 [' + code + '] 설정 변경 중 서버 오류 — 저장됐는지 확실하지 않음',
      detail: {
        코드: code, R2키: 'video-codes/' + code + '.json',
        요청값: 요청값,
        오류: String((e && e.message) || e).slice(0, 500),
        효과: '반영 여부 불명 — 영상 관리 화면에서 현재 값을 직접 확인해야 한다',
      },
    });
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
