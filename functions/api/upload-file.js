// 파일을 직접 R2에 업로드 (native R2 binding, AWS SDK 불필요)
import { logAudit, actorOf } from './_auditlog.js';

// 📓 2026-08-03 (§11-11) — 여태 이 API에는 용량 제한이 **한 줄도 없었다.**
//   숙제 사진 업로드(homework.js)에는 15MB 컷이 이미 있었는데 자료실만 무방비였다.
//   ⚠️ 값을 바꾸려면 이 한 줄만 고치면 된다. 아래 두 군데(헤더 검사·파싱 후 검사)가 같은 값을 쓴다.
//   ⚠️ Cloudflare Worker 는 메모리 한도가 128MB 다. formData() 가 본문을 통째로 메모리에 올리므로
//     이 값을 128MB 근처까지 올리면 업로드 한 건이 워커를 죽여서 그 순간 다른 요청까지 같이 실패한다.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 자료 1개 최대 50MB

function 크기표시(n) {
  const v = Number(n) || 0;
  return v > 1024 * 1024 ? (v / (1024 * 1024)).toFixed(1) + 'MB' : Math.round(v / 1024) + 'KB';
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });

  // 📓 2026-08-03 (§11-11) — 여태 이 API는 "일단 다 받아본 다음에" 비밀번호를 확인했다(formData()가 먼저였다).
  //   그래서 인증도 안 된 요청이 던진 몇 GB짜리 본문을 서버가 통째로 메모리에 올린 뒤에야 401을 돌려줬다.
  //   저장되는 건 없었지만(R2 put 은 인증 뒤라 데이터가 새지는 않는다) 요청·처리 비용이 나가고,
  //   워커 메모리가 터지면 그 순간 다른 사람 업로드까지 같이 실패한다.
  //   ⚠️ 인증을 formData() 앞으로 **완전히** 당길 수는 없다 — MathOS 로컬앱은 비밀번호를 폼 "필드"로 보내는데
  //     그 값은 본문을 파싱해야만 보이기 때문이다. 그래서 본문을 읽기 전에 볼 수 있는 유일한 정보인
  //     Content-Length 로 먼저 자르고, 파싱한 뒤 file.size 로 한 번 더 자른다(2중).
  //   ⚠️ Content-Length 는 청크 전송이면 아예 없을 수 있고 거짓말도 가능하다 → 뒤의 재확인이 반드시 필요하다.
  //   ⚠️ logAudit 은 헤더만 읽고 본문을 건드리지 않으므로(_auditlog.js) 여기서 불러도 안전하다.
  const 신고한크기 = Number(request.headers.get('content-length') || 0);
  if (신고한크기 > MAX_UPLOAD_BYTES) {
    await logAudit(env, request, {
      action: 'file.upload.denied',
      target: '(본문 읽기 전 차단)',
      summary: '자료 업로드 거부 — 요청이 너무 큼 ' + 크기표시(신고한크기) + ' (최대 ' + 크기표시(MAX_UPLOAD_BYTES) + ')',
      detail: {
        신고한크기바이트: 신고한크기,
        신고한크기표시: 크기표시(신고한크기),
        상한: 크기표시(MAX_UPLOAD_BYTES),
        판정근거: 'Content-Length 헤더 — 본문을 읽기 전에 잘랐다(파일 이름·폴더·인증 정보는 본문 안이라 아직 모른다)',
        비고: '인증 통과 여부와 무관하게 먼저 자른다. 인증을 앞으로 못 당기는 이유는 위 주석 참고.',
        효과: 'R2에 아무것도 저장되지 않음 — 본문을 아예 읽지 않았으므로 서버 메모리도 쓰지 않았다',
      },
    });
    return Response.json({
      error: '파일이 너무 큽니다(최대 ' + 크기표시(MAX_UPLOAD_BYTES) + '). 보낸 크기: ' + 크기표시(신고한크기),
    }, { status: 413 });
  }

  const formData = await request.formData();
  const file = formData.get('file');
  const folder = formData.get('folder') || 'materials';
  const password = formData.get('password');

  // 인증: Authorization 헤더(_middleware가 adm_ 세션토큰을 ADMIN_PASSWORD로 변환) 또는 password 폼필드
  const headerToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const 헤더인증 = headerToken === env.ADMIN_PASSWORD;
  const 폼인증  = password === env.ADMIN_PASSWORD;

  // 📓 2026-07-31 — 자료 업로드는 여태 아무 기록도 안 남겼다. 자료실에 뭐가 언제 올라왔는지,
  //   조교 중 누가 올렸는지 되짚을 방법이 전혀 없었다.
  //   ⚠️ 이 API는 인증 경로가 두 가지다. 헤더 Bearer(원장·조교 세션)로 들어오면 actorOf가
  //     누구인지 알아내지만, password 폼필드(MathOS 로컬앱·외부 도구)로 들어오면 헤더가 없어
  //     '누가'가 통째로 빈다 → 그 경우엔 행위자를 직접 지정한다(save-video-code.js와 같은 방식).
  //   ⚠️ 비밀번호 값 자체는 어느 로그에도 넣지 않는다 — 어느 경로로 들어왔는지만 남긴다.
  const 인증경로 = 헤더인증 ? '헤더 Bearer(원장·조교 세션 또는 관리자 비밀번호 직접 사용)'
    : (폼인증 ? 'password 폼필드(MathOS 로컬앱·외부 도구 — 사람 특정 불가)' : '인증 실패');
  const 행위자 = 헤더인증
    ? actorOf(request, env)
    : { actor: '__uploader__', actorRole: 'admin-key', actorName: '업로드 도구(비밀번호 폼 인증)' };
  const 파일정보 = (file && typeof file !== 'string')
    ? { 원본파일명: String(file.name || ''), 크기바이트: Number(file.size || 0), 타입: String(file.type || '') }
    : '(파일이 안 들어옴)';

  if (!헤더인증 && !폼인증) {
    await logAudit(env, request, {
      action: 'file.upload.denied',
      target: String(folder).slice(0, 200),
      targetName: (file && typeof file !== 'string') ? String(file.name || '') : '',
      summary: '자료 업로드 거부 — 인증 실패 (요청 폴더 "' + String(folder) + '")',
      detail: {
        요청폴더: String(folder),
        파일: 파일정보,
        헤더토큰이왔나: !!headerToken,
        password폼필드가왔나: password !== null && password !== undefined && password !== '',
        비고: '비밀번호·토큰 값 자체는 로그에 남기지 않는다(왔는지 여부만).',
        효과: 'R2에 아무것도 저장되지 않음 — 자료실에 변화 없음',
      },
    });
    return Response.json({ error: '인증 실패' }, { status: 401 });
  }

  // 경로 보호: auth/·video-codes/·push-subs/ 등 운영 경로 및 상위경로(..) 차단
  const folderRoot = String(folder).replace(/^\/+/, '').split('/')[0];
  if (!folderRoot || String(folder).includes('..') || ['auth', 'video-codes', 'push-subs', 'tokens'].includes(folderRoot)) {
    // 🔴 정상 사용에서는 절대 안 나오는 경로다. 남겨두면 "누가 운영 폴더에 무엇을 덮어쓰려 했는지"가 그대로 남는다.
    await logAudit(env, request, {
      ...행위자,
      action: 'file.upload.denied',
      target: String(folder).slice(0, 200),
      targetName: (file && typeof file !== 'string') ? String(file.name || '') : '',
      summary: '자료 업로드 거부 — 허용되지 않은 폴더 "' + String(folder) + '"',
      detail: {
        요청폴더: String(folder),
        최상위폴더: folderRoot,
        차단사유: !folderRoot ? '폴더 이름이 비어 있음'
          : (String(folder).includes('..') ? '상위경로(..)가 들어 있음 — 지정한 폴더 밖으로 빠져나가려는 시도'
            : '운영 전용 폴더(auth·video-codes·push-subs·tokens)에는 올릴 수 없음 — 계정·영상코드·푸시구독 파일이 덮어써질 수 있는 자리'),
        파일: 파일정보,
        인증경로: 인증경로,
        효과: 'R2에 아무것도 저장되지 않음 — 운영 파일은 그대로',
      },
    });
    return Response.json({ error: '허용되지 않은 폴더입니다.' }, { status: 400 });
  }

  if (!file || typeof file === 'string') {
    await logAudit(env, request, {
      ...행위자,
      action: 'file.upload.fail',
      target: String(folder).slice(0, 200),
      summary: '자료 업로드 실패 — 폼에 파일이 안 들어옴 (요청 폴더 "' + String(folder) + '")',
      detail: {
        요청폴더: String(folder),
        받은값: (file === null || file === undefined)
          ? 'file 항목 자체가 폼에 없음(업로드 화면에서 파일을 안 고르고 눌렀거나, 전송 중 끊김)'
          : '파일이 아니라 글자값이 들어옴: ' + String(file).slice(0, 200),
        인증경로: 인증경로,
        효과: 'R2에 아무것도 저장되지 않음 — 자료실에 변화 없음',
      },
    });
    return Response.json({ error: '파일이 없습니다' }, { status: 400 });
  }

  // 📓 2026-08-03 (§11-11) — 위 Content-Length 검사의 2중 확인.
  //   헤더가 없는 경우(청크 전송)·헤더를 거짓으로 보낸 경우·본문에 파일이 여러 개 실린 경우에는
  //   헤더만으로는 못 막는다. 실제로 파싱된 파일 크기로 여기서 한 번 더 자른다.
  //   여기까지 왔다는 건 인증은 통과했다는 뜻이다 → 관우T·조교의 실수(4GB 영상 끌어다 놓기)도 여기서 걸린다.
  if (Number(file.size || 0) > MAX_UPLOAD_BYTES) {
    await logAudit(env, request, {
      ...행위자,
      action: 'file.upload.denied',
      target: String(folder).slice(0, 200),
      targetName: String(file.name || '').slice(0, 60),
      summary: '자료 업로드 거부 — 파일이 너무 큼 ' + 크기표시(file.size) + ' (최대 ' + 크기표시(MAX_UPLOAD_BYTES) + ') [' + String(file.name || '이름없음') + ']',
      detail: {
        요청폴더: String(folder),
        파일: 파일정보,
        크기표시: 크기표시(file.size),
        상한: 크기표시(MAX_UPLOAD_BYTES),
        판정근거: '파싱된 파일 크기(file.size) — Content-Length 헤더는 ' + (신고한크기 ? 크기표시(신고한크기) + ' 로 왔다' : '아예 안 왔다(청크 전송)'),
        헤더가못막은이유: 신고한크기 > 0 && 신고한크기 <= MAX_UPLOAD_BYTES
          ? '헤더 값이 상한 이하로 왔는데 실제 파일이 더 컸다 — 헤더 위조이거나 본문에 다른 항목이 함께 실린 경우'
          : '헤더가 없어서 본문을 읽기 전에는 크기를 알 수 없었다',
        인증경로: 인증경로,
        효과: 'R2에 아무것도 저장되지 않음 — 자료실에 변화 없음',
      },
    });
    return Response.json({
      error: '파일이 너무 큽니다(최대 ' + 크기표시(MAX_UPLOAD_BYTES) + '). ' + (file.name || '') + ' : ' + 크기표시(file.size),
    }, { status: 413 });
  }

  const timestamp = Date.now();
  const safeFileName = file.name.replace(/[^a-zA-Z0-9가-힣.\-_]/g, '_');
  const key = `${folder}/${timestamp}_${safeFileName}`;

  try {
    await env.BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    });
  } catch (e) {
    // 저장이 깨졌는데 아무 기록이 없으면 "올렸는데 자료실에 없다"는 신고를 영영 설명 못 한다.
    //   응답 동작은 원래와 똑같이 둔다(예외를 그대로 다시 던짐) — 로그만 하나 남기고 지나간다.
    await logAudit(env, request, {
      ...행위자,
      action: 'file.upload.fail',
      target: key, targetName: String(file.name || '').slice(0, 60),
      summary: '자료 업로드 실패 — R2 저장 중 오류 [' + key + ']',
      detail: {
        R2키: key, 요청폴더: String(folder), 최상위폴더: folderRoot,
        파일: 파일정보,
        오류: String((e && e.message) || e).slice(0, 500),
        인증경로: 인증경로,
        효과: '자료실에 파일이 안 올라갔다(부분 저장 여부는 R2가 보장하지 않으므로 목록에서 직접 확인 필요)',
      },
    });
    throw e;
  }

  const fileSize = 크기표시(file.size);   // 2026-08-03 — 위 상한 검사와 같은 함수를 쓴다(표기가 갈리지 않게)

  // 📓 어느 폴더에 올렸느냐에 따라 "누가 볼 수 있는 자료가 되는지"가 완전히 달라진다(download-file.js 화이트리스트).
  //   원장이 로그만 보고도 그 결과를 알 수 있게 문장으로 적어 둔다.
  const 효과 = folderRoot === 'materials'
    ? '홈페이지·앱 자료실에서 로그인 없이 누구나 내려받을 수 있는 공개 자료가 된다'
    : folderRoot === 'class'
      ? '해당 학원·반 학생과 학부모가 앱에서 내려받을 수 있는 수업자료가 된다(결석한 날짜 파일은 인강 승인 전까지 잠김)'
      : (folderRoot === 'reports' || folderRoot === 'test-results')
        ? '폴더 이름과 이름이 같은 학생 본인·학부모만 내려받을 수 있다'
        : '다운로드 허용 목록에 없는 폴더 — 관리자(원장·조교)만 내려받을 수 있다';

  await logAudit(env, request, {
    ...행위자,
    action: 'file.upload',
    target: key, targetName: String(file.name || '').slice(0, 60),
    summary: '자료 업로드 [' + key + '] — ' + (file.name || '이름없음') + ' · ' + fileSize,
    detail: {
      R2키: key, 요청폴더: String(folder), 최상위폴더: folderRoot,
      파일: {
        원본파일명: String(file.name || ''),
        저장파일명: safeFileName,
        크기바이트: Number(file.size || 0),
        크기표시: fileSize,
        타입: String(file.type || '') || '(브라우저가 타입을 안 알려줌 — application/octet-stream 으로 저장)',
      },
      파일명변환: safeFileName !== String(file.name || '')
        ? '한글·영문·숫자·점·하이픈·밑줄 외의 글자는 전부 _ 로 바뀌어 저장됐다(원본 이름은 위 "원본파일명")'
        : '원본 이름 그대로 저장됨',
      키규칙: '폴더/타임스탬프_파일명 — 앞에 시각(' + timestamp + ')이 붙으므로 같은 이름을 다시 올려도 기존 파일을 덮지 않는다. 대신 같은 이름 파일이 두 개 쌓이므로 옛것은 따로 지워야 한다',
      인증경로: 인증경로,
      비고: '파일 본문과 비밀번호는 로그에 남기지 않는다(이름·크기·타입만).',
      효과: 효과,
    },
  });

  return Response.json({ ok: true, key, fileName: file.name, fileSize });
}
