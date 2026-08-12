// /api/reports-write — admin 전용 리포트 생성/수정/삭제 (Cloudflare D1 reports, 이전엔 Notion 82ef)
//   POST   { studentName, phone4?, date, school?, content?, homework?, notes? } — 생성 + 학부모 푸쉬
//     (phone4는 옛 '이름+끝4자리' 열람 인증의 잔재 — 지금은 포털 토큰 인증이라 선택값. 2026-07-09)
//   PATCH  { pageId, date?, school?, content?, homework?, notes? }             — 수정 (pageId = D1 id)
//   DELETE { pageId }                                                          — 삭제
// pageId는 문자열로 와도 숫자로 변환해서 D1 조회.

import { listStudentsByName, createReport, updateReport, deleteReport, getReportByStudentAndDate } from './_db.js';
import { isCompleted } from './_auth.js';   // 🎓 2026-08-12 — 수료·졸업 가드 (아래 POST 참조). `=== '수료'` 직접 비교 금지
import { safeError } from './_errors.js';
import { sendPushToUsers } from './_push.js';   // 🔔 2026-07-30 — 웹푸시+FCM 병행 (push-send 경유 시 FCM 미발송 버그 수정)
import { logAudit, diffFields } from './_auditlog.js';

// 학생 이름 → 학부모 휴대폰 (푸쉬 발송용, D1)
//   👥 2026-07-31 — 예전엔 getStudentByName(ORDER BY id LIMIT 1) 이라 같은 이름이 2명이면
//     **먼저 등록된 학생의 학부모 폰**으로 "새 리포트가 올라왔어요" 푸시가 조용히 갔다.
//     리포트 자체는 이름으로 저장되니(reports 테이블에 student_id 칸이 없음) 어느 쪽 리포트인지
//     서버가 알 도리가 없다. 그래서 2명 이상이면 **아무에게도 푸시하지 않는다**.
//     (리포트 저장은 그대로 성공한다 — 관우T가 MathOS에서 올린 글을 잃게 만들면 안 되므로.
//      대신 아래에서 "푸시 안 감 + 이유"를 감사로그에 남겨 수동으로 알릴 수 있게 한다.)
//   반환: { phone, 사유 } — phone 이 null 이면 사유가 왜인지 말해 준다.
async function findParentPhone(env, studentName) {
  try {
    const 후보 = await listStudentsByName(env, studentName);
    if (!후보.length) return { phone: null, 사유: '학생 명단에 없는 이름 — 학부모 번호를 찾지 못함' };
    if (후보.length > 1) {
      return {
        phone: null,
        사유: '같은 이름 학생이 ' + 후보.length + '명이라 어느 집에 보낼지 확정할 수 없어 푸시를 보내지 않음',
        동명이인수: 후보.length,
        후보목록: 후보.map((s) => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '' })),
      };
    }
    const st = 후보[0];
    return st.parentPhone ? { phone: st.parentPhone } : { phone: null, 사유: '학부모 번호가 비어 있음' };
  } catch (e) {
    return { phone: null, 사유: '학생 조회 중 오류 — 푸시 생략' };
  }
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  // ── 생성 ──
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}
    const { studentName, phone4, date, school, content, homework, notes } = body;
    if (!studentName || !date)
      return Response.json({ error: '학생 이름과 수업 날짜는 필수입니다.' }, { status: 400 });

    // 👥 2026-07-31 — 같은 이름 학생이 2명 이상인지 먼저 센다.
    //   reports 테이블에는 student_id 칸이 없어서 리포트는 **이름으로만** 학생과 이어진다.
    //   그래서 동명이인이 있으면 아래 "같은 이름+같은 날짜" 중복 가드가
    //   **다른 학생의 리포트를 내 리포트로 덮어써 버릴 수 있다**(되돌릴 수 없음).
    //   원칙: 이름 뒤 숫자 별칭(김민준1·김민준2)으로 갈라 두는 게 정답이고, 별칭이 아직 없는 상태에서는
    //   덮어쓰기(복구 불가)보다 두 건 쌓기(수동 삭제로 복구 가능)를 택한다.
    const 동명이인 = await listStudentsByName(env, studentName);
    const 이름모호 = 동명이인.length > 1;

    // 🎓 2026-08-12 — 수료·졸업 학생에게는 새 리포트를 만들지 않는다 (서버 2차 방어선).
    //   [실제 사고] 조에스더 8/10 13:41 수료 처리 → **8/12 16:43 리포트가 그대로 생성되고
    //     학부모께 "📋 새 수업 리포트가 올라왔어요" 푸시까지 나갔다.** 발송은 되돌릴 수 없다.
    //   [원인] 이 API는 학생 상태를 한 번도 안 봤다. 대상 명단을 만드는 쪽(MathOS)이
    //     학원+반으로만 걸렀고, 2026-08-10 수료 스윕은 kwmath 서버 안만 훑어서 그 프로그램이 범위 밖이었다.
    //   [왜 서버에서도 막나] 명단을 만드는 클라이언트는 언제든 또 생긴다(MathOS·관리자 화면·나중의 무엇).
    //     화면에서 막은 것과 서버에서 막은 것은 다른 일이다 — notify-class-materials 와 같은 교훈.
    //   [겸반은 통과시킨다] 「시동반=수료 · 공통수학2=재원」인 학생은 지금도 다니는 사람이다.
    //     그래서 **같은 이름 행이 전부 수료·졸업일 때만** 막는다. 한 행이라도 재원이면 정상 작성.
    //   [명단에 없는 이름은 통과] reports 는 이름으로만 학생과 이어지고, 명단 밖 이름으로 쓰는 경로가
    //     원래 열려 있었다. 여기서 같이 막으면 이번 사고와 무관한 기능이 조용히 죽는다.
    //   [기각] `allowCompleted` 강제 플래그 — 부르는 화면이 하나도 없는 죽은 우회로가 된다.
    //     정말 써야 하면 「↩ 재원 복귀」 → 작성 → 다시 수료가 흔적이 남는 정직한 경로다. 안내문에 그렇게 적었다.
    if (동명이인.length && 동명이인.every((s) => isCompleted(s.approvalStatus))) {
      const 상태 = String(동명이인[0].approvalStatus || '').trim() || '수료';
      await logAudit(env, request, {
        action: 'report.create.blocked',
        target: String(동명이인[0].id || ''), targetName: studentName,
        summary: '리포트 작성 차단(' + 상태 + ') — [' + studentName + ' · ' + date + '] 수업이 끝난 학생',
        detail: {
          학생: studentName, 수업일: date, 상태,
          해당행: 동명이인.map((s) => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '', 상태: s.approvalStatus || '' })),
          효과: '리포트가 만들어지지 않았고 학부모 푸시도 나가지 않았다',
          보낸내용: { 수업내용: content || '', 숙제: homework || '', 특이사항: notes || '' },
        },
      });
      return Response.json({
        error: '「' + studentName + '」 학생은 ' + 상태 + ' 처리돼 있어 새 리포트를 만들지 않았습니다. '
          + '아직 다니는 학생이면 kwmath 관리자 → 학생 관리에서 「↩ 재원 복귀」 후 다시 올려주세요.',
        blocked: 'completed', status: 상태,
      }, { status: 409 });
    }

    // ── 재업로드 중복 가드: 같은 학생+같은 날짜 리포트가 이미 있으면 새로 쌓지 않고 그 행을 갱신 ──
    //    (7/01 실사고: MathOS에서 두 번 올려 학생당 2건 누적 → 수동 삭제. 이제 두 번 눌러도 최신 내용 1건.)
    //    푸시도 재발송 안 함 — 학부모는 첫 업로드 때 이미 받았음.
    //    단, 이름이 모호하면(동명이인) 이 가드를 끈다 — 남의 리포트를 덮을 위험이 더 크다.
    const dup = 이름모호 ? null : await getReportByStudentAndDate(env, studentName, date);
    if (dup && dup.id != null) {
      const u = await updateReport(env, dup.id, { date, school, content, homework, notes });
      if (!u.ok) return safeError(u.error || 'updateReport(dedup) failed', env, { message: '리포트 저장에 실패했습니다.' });

      // 📓 2026-07-31 — 이 경로는 겉보기엔 "생성"인데 실제로는 **기존 리포트 덮어쓰기**다.
      //   MathOS에서 두 번 올리면 학부모가 이미 읽은 내용이 조용히 바뀐다 → 전/후를 반드시 남긴다.
      const d = diffFields(u.before, u.after, ['date', 'school', 'content', 'homework', 'notes']);
      await logAudit(env, request, {
        action: 'report.overwrite',
        target: String(dup.id), targetName: studentName,
        summary: '리포트 덮어쓰기 [' + studentName + ' · ' + date + '] (같은 날짜 재업로드) — ' + (d.요약 || '내용 동일'),
        detail: {
          리포트id: dup.id, 학생: studentName, 수업일: date,
          바뀐칸: d.바뀐칸, 변경: d.변경,
          이전내용: u.before || null,
          경로: '같은 학생+같은 날짜 중복 가드 — 새로 쌓지 않고 기존 행 갱신',
          푸시: '재발송 안 함(학부모는 첫 업로드 때 이미 받음)',
        },
      });
      return Response.json({ ok: true, id: String(dup.id), deduped: true });
    }

    const r = await createReport(env, { studentName, phone4, date, school, content, homework, notes });
    if (!r.ok) return safeError(r.error || 'createReport failed', env, { message: '리포트 저장에 실패했습니다.' });

    await logAudit(env, request, {
      action: 이름모호 ? 'report.create.ambiguous' : 'report.create',
      target: String(r.id || ''), targetName: studentName,
      summary: '리포트 작성 [' + studentName + ' · ' + date + ']' + (body.noPush ? ' (푸시 없음 — 복사 등록)' : '')
        + (이름모호 ? ' ⚠️ 같은 이름 학생 ' + 동명이인.length + '명 — 누구 리포트인지 이름만으로는 구분 안 됨' : ''),
      detail: {
        리포트id: r.id, 학생: studentName, 수업일: date, 학원: school || '대치동 정규반',
        수업내용: content || '', 숙제: homework || '', 특이사항: notes || '',
        푸시보냄: !body.noPush,
        ...(이름모호 ? {
          동명이인수: 동명이인.length,
          후보목록: 동명이인.map((s) => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '' })),
          주의: 'reports 테이블은 이름으로만 학생과 이어진다 — 이 리포트는 같은 이름 학부모 모두에게 보일 수 있다. '
            + '학생 관리에서 이름 뒤 숫자 별칭(예: ' + studentName + '1 · ' + studentName + '2)으로 갈라 줄 것',
          덮어쓰기가드: '이번엔 껐다(남의 리포트를 덮지 않기 위해). 같은 날짜에 두 건이 쌓였다면 한 건은 지워야 한다',
        } : {}),
      },
    });

    // 푸쉬 알림 (비치명적 — 실패해도 생성은 성공)
    //   noPush=true면 조용히 생략 — "이미 올린 레포트를 다른 학생에게 복사"할 때 그 학부모엔 알림 안 보냄(관우T 확정 2026-07-23).
    if (!body.noPush) try {
      const 부모 = await findParentPhone(env, studentName);
      const parentPhone = 부모.phone;
      // 👥 푸시를 못 보냈으면 왜 못 보냈는지 반드시 남긴다. 동명이인이라 건너뛴 경우
      //   관우T가 직접 연락해야 하는데, 아무 흔적이 없으면 "보냈겠지" 하고 넘어가게 된다.
      if (!parentPhone) {
        await logAudit(env, request, {
          action: 부모.동명이인수 ? 'report.push.ambiguous' : 'report.push.skipped',
          target: String(r.id || ''), targetName: studentName,
          summary: '리포트 푸시 안 감 [' + studentName + ' · ' + date + '] — ' + (부모.사유 || '사유 미상'),
          detail: {
            리포트id: r.id, 학생: studentName, 수업일: date,
            사유: 부모.사유 || '', 동명이인수: 부모.동명이인수 || 0, 후보목록: 부모.후보목록 || [],
            효과: '리포트는 정상 저장됐지만 학부모 폰 알림은 나가지 않았다. 필요하면 직접 연락할 것',
          },
        });
      }
      if (parentPhone) {
        // 🔔 2026-07-30 — push-send(웹푸시 전용) 경유 → sendPushToUsers(웹+FCM 병행)로 교체.
        //   앱(WebView) 학부모는 FCM만 등록돼 있어 기존 경로로는 낮 리포트 푸시를 못 받았다
        //   (밤 리포트만 야간 큐→sendPushToUsers를 타서 받는 비대칭 버그). 야간 정책은 동일 유지.
        await sendPushToUsers(env, [parentPhone], {
          title: '📋 새 수업 리포트가 올라왔어요',
          body: studentName + ' 학생 — ' + date + ' 수업 내용을 확인해보세요',
          url: '/portal?tab=report',
          tag: 'report-' + studentName + '-' + date,
        }, {
          nightSilent: true,     // 학부모 대상 → 밤(KST 23~7)엔 즉시 발송 안 함
          queueIfNight: true,    // 드롭 대신 야간 큐 → 아침 07시~ 모아서 발송
          queueTag: 'report',
        });
      }
    } catch (e) { /* 무시 */ }

    // 👥 동명이인이면 저장은 됐지만 사람이 손볼 게 남았다 — 화면에 띄울 수 있게 경고를 같이 돌려준다.
    return Response.json({
      ok: true, id: String(r.id),
      ...(이름모호 ? {
        경고: '「' + studentName + '」 이름의 학생이 ' + 동명이인.length + '명이라 이 리포트가 누구 것인지 이름만으로는 구분되지 않아요. '
          + '학부모 알림도 보내지 않았습니다. 학생 관리에서 이름 뒤에 숫자(예: ' + studentName + '1)를 붙여 갈라 주세요.',
        동명이인수: 동명이인.length,
        후보목록: 동명이인.map((s) => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '' })),
      } : {}),
    });
  }

  // ── 수정 ──
  if (request.method === 'PATCH') {
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.pageId);
    if (!body.pageId || !Number.isFinite(id)) return Response.json({ error: 'pageId 필요' }, { status: 400 });

    const patch = {};
    if (typeof body.date     === 'string' && body.date)   patch.date = body.date;
    if (typeof body.school   === 'string' && body.school) patch.school = body.school;
    if (typeof body.content  === 'string')                patch.content = body.content;
    if (typeof body.homework === 'string')                patch.homework = body.homework;
    if (typeof body.notes    === 'string')                patch.notes = body.notes;

    const r = await updateReport(env, id, patch);
    if (!r.ok) return safeError(r.error || 'updateReport failed', env, { message: '리포트 수정에 실패했습니다.' });

    // 📓 리포트 본문은 학부모가 읽는 글이다. 어느 칸을 무엇에서 무엇으로 고쳤는지 통째로 남긴다.
    const d = diffFields(r.before, r.after, ['date', 'school', 'content', 'homework', 'notes']);
    await logAudit(env, request, {
      action: 'report.update',
      target: String(id),
      targetName: (r.before && r.before.studentName) || (r.after && r.after.studentName) || '',
      summary: '리포트 수정 [' + (((r.before && r.before.studentName) || '') + ' · ' + ((r.before && r.before.date) || '')).trim()
        + '] — ' + (d.요약 || '변경 없음'),
      detail: {
        리포트id: id,
        학생: (r.before && r.before.studentName) || '',
        바뀐칸: d.바뀐칸, 변경: d.변경,
        보낸값: patch,
        수정전전문: r.before || null,     // 본문 전체 — 잘못 고쳤을 때 되돌릴 근거
      },
    });
    return Response.json({ ok: true });
  }

  // ── 삭제 ──
  if (request.method === 'DELETE') {
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.pageId);
    if (!body.pageId || !Number.isFinite(id)) return Response.json({ error: 'pageId 필요' }, { status: 400 });

    const r = await deleteReport(env, id);
    if (!r.ok) return safeError(r.error || 'deleteReport failed', env, { message: '리포트 삭제에 실패했습니다.' });

    // 🔴 되돌릴 수 없음 — 지워진 리포트 전문을 로그에 통째로 박는다. 이게 유일한 복원 근거.
    await logAudit(env, request, {
      action: 'report.delete',
      target: String(id), targetName: (r.before && r.before.studentName) || '',
      summary: '리포트 삭제 [' + (((r.before && r.before.studentName) || '') + ' · ' + ((r.before && r.before.date) || '')).trim()
        + '] 영구 삭제 (복구 불가)',
      detail: {
        리포트id: id,
        지워진리포트: r.before || '(행을 못 읽음 — 이미 없었을 수 있음)',
        삭제건수: r.removed,
        비고: r.removed === 0 ? '지울 행이 없었음' : '학부모 앱에서 즉시 사라짐',
      },
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
