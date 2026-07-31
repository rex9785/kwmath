// functions/api/admin-migrate-d1.js
// ───────────────────────────────────────────────────────────
// 일회용 데이터 이전: Notion + R2 → D1 (Phase 3 / 2026-05-31)
// POST { dryRun?: true(기본), wipeFirst?: false } + admin 토큰(Bearer ADMIN_PASSWORD)
//   dryRun=true : D1에 쓰지 않고 카운트/매칭 분석만 (안전한 미리보기)
//   dryRun=false: 실제 INSERT
//   wipeFirst=true : D1 테이블 비우고 시작 (재실행 안전 — 중복 방지)
// 원본(Notion/R2)은 읽기만. 안 건드림.
// 동명이인(같은 이름 학생 2명+)은 자동 매핑하지 않고 unmatched로 보고.
// ───────────────────────────────────────────────────────────
import { logAudit } from './_auditlog.js';

const ACCOUNTS_DB = '893a626479514059ae309a269b3661b5';
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const REPORTS_DB  = '82ef896dcf844c5b9c36f7e0ff0a97f2';

async function notionQueryAll(env, dbId) {
  const out = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const b = { page_size: 100 };
    if (cursor) b.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });
    const data = await res.json();
    if (data.object === 'error') throw new Error('Notion(' + dbId.slice(0,6) + '): ' + data.message);
    for (const p of (data.results || [])) if (!p.archived && !p.in_trash) out.push(p);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

const rt    = (p, k) => (p[k] && p[k].rich_text || [])[0] && (p[k].rich_text[0].plain_text) || '';
const ttl   = (p, k) => (p[k] && p[k].title || [])[0] && (p[k].title[0].plain_text) || '';
const sel   = (p, k) => (p[k] && p[k].select && p[k].select.name) || '';
const multi = (p, k) => ((p[k] && p[k].multi_select) || []).map(o => o.name);
const num   = (p, k) => (p[k] && typeof p[k].number === 'number') ? p[k].number : null;
const chk   = (p, k) => !!(p[k] && p[k].checkbox === true);
const dat   = (p, k) => (p[k] && p[k].date && p[k].date.start) || '';

export async function onRequest({ request, env }) {
  // ⚠️ D1 컷오버 완료(2026-05-31) — 이 endpoint는 비활성화되었습니다.
  // 재실행하면 D1을 비우고 노션(이제 stale)으로 덮어써 컷오버 이후 데이터가 소실됩니다.
  // 정말 다시 써야 하면 바로 아래 return 한 줄만 제거하세요.
  //
  // 📓 시도 자체를 남긴다 — 이 문이 열려 있었다면 D1이 통째로 날아갔을 요청이다.
  //    인증 검사보다 앞이라 관리자 비번 없이 두드린 외부 스캐너도 함께 잡힌다(그게 오히려 알고 싶은 정보다).
  await logAudit(env, request, {
    action: 'admin.migrate.d1.blocked',
    target: 'D1 전체(accounts·students·reports·attendance·study_sessions)',
    summary: '비활성화된 D1 마이그레이션 호출 시도 — 403으로 거부(D1은 아무것도 바뀌지 않음)',
    detail: {
      결과: '거부(403). D1에 어떤 변경도 일어나지 않았다.',
      막은이유: 'D1 컷오버(2026-05-31) 이후 이 코드를 다시 돌리면 노션(이제 낡은 데이터)으로 덮어써, 컷오버 이후 쌓인 데이터가 사라진다.',
      해제조건: '이 파일 onRequest 맨 앞의 return 한 줄을 지워야만 동작한다(원장 판단 필요).',
      호출메서드: (request && request.method) || '',
      효과: '없음 — 시도만 기록한다.',
      비고: '인증 검사 이전 단계라 비밀번호를 모르는 요청도 여기 남는다. 비밀번호·토큰 원문은 기록하지 않는다.',
    },
  });
  return Response.json({ error: '마이그레이션은 D1 컷오버 후 비활성화되었습니다. (실수 방지용)', disabled: true }, { status: 403 });

  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    // 위 return 을 지워 되살렸을 때를 대비한 배선 — 인증 실패도 반드시 남긴다.
    await logAudit(env, request, {
      action: 'admin.migrate.d1.denied',
      target: 'D1 전체',
      summary: 'D1 마이그레이션 인증 실패 — 거부(401)',
      detail: {
        결과: '거부(401). D1에 어떤 변경도 일어나지 않았다.',
        사유: env.ADMIN_PASSWORD ? '관리자 비밀번호 불일치' : '서버에 ADMIN_PASSWORD 미설정',
        효과: '없음.',
        비고: '입력된 토큰 원문은 기록하지 않는다.',
      },
    });
    return Response.json({ error: '인증 필요' }, { status: 401 });
  }
  if (!env.DB) return Response.json({ error: 'D1 바인딩(DB) 없음 — wrangler.toml + 배포 확인' }, { status: 500 });

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const dryRun = body.dryRun !== false;
  const wipeFirst = body.wipeFirst === true;

  const report = {
    ok: true, dryRun, wipeFirst,
    d1Before: {}, accounts: 0, students: 0,
    reports: { migrated: 0, unmatched: [] },
    attendance: { files: 0, records: 0, unmatched: [] },
    study: { files: 0, sessions: 0, unmatched: [] },
    ambiguousNames: [], errors: [],
  };

  // 📓 감사로그용 수집기 — 이 실행 1회를 로그 1건으로 남기기 위한 것.
  //    수백 행을 건별로 남기면 로그가 터지므로 "표별 건수 + 앞 30건 표본"만 모은다.
  const 시작 = Date.now();
  const 지운표 = [];        // wipeFirst 로 비운 표와 그때 사라진 행 수
  const 표본학생 = [];      // 새로 만든 학생 앞 30명 (이름·학교·학년만 — 전화번호는 표본에 안 담는다)
  const 표본리포트 = [];    // 새로 만든 리포트 앞 30건

  const cnt = async (t) => {
    try { const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM ' + t).first(); return (r && r.c) || 0; }
    catch (e) { return 'ERR:' + e.message; }
  };

  try {
    // env.DB 연결 확인 + 현재 D1 상태
    report.d1Before = {
      accounts: await cnt('accounts'), students: await cnt('students'), reports: await cnt('reports'),
      attendance: await cnt('attendance'), study: await cnt('study_sessions'),
    };

    // ── 읽기 (Notion) ──
    const accs  = await notionQueryAll(env, ACCOUNTS_DB);
    const studs = await notionQueryAll(env, STUDENTS_DB);
    const reps  = await notionQueryAll(env, REPORTS_DB);

    // 이름 빈도 (동명이인 감지)
    const nameCount = {};
    for (const s of studs) { const n = ttl(s.properties, '이름'); if (n) nameCount[n] = (nameCount[n] || 0) + 1; }
    report.ambiguousNames = Object.keys(nameCount).filter(n => nameCount[n] > 1);

    // ── wipe (real + wipeFirst) ──
    if (!dryRun && wipeFirst) {
      for (const t of ['study_sessions', 'attendance', 'reports', 'students', 'accounts']) {
        // 지운 행 수는 run()이 그냥 돌려준다 — 조회를 더 하지 않고 공짜로 before 를 확보한다.
        const r = await env.DB.prepare('DELETE FROM ' + t).run();
        지운표.push({ 표: t, 지운행수: (r.meta && r.meta.changes) || 0 });
      }
    }

    // ── accounts ──
    for (const a of accs) {
      const p = a.properties;
      const phone = ttl(p, '휴대폰');
      if (!phone) continue;
      report.accounts++;
      if (!dryRun) {
        await env.DB.prepare(
          'INSERT INTO accounts (phone, password_hash, salt, must_change_pw, note, last_login) VALUES (?,?,?,?,?,?) ' +
          'ON CONFLICT(phone) DO UPDATE SET password_hash=excluded.password_hash, salt=excluded.salt, must_change_pw=excluded.must_change_pw'
        ).bind(phone, rt(p, '비밀번호 해시'), rt(p, 'salt'), chk(p, '변경 필요') ? 1 : 0, rt(p, '비고'), dat(p, '마지막 로그인') || null).run();
      }
    }

    // ── students (INSERT → id, nameToId[유일이름]=id) ──
    const nameToId = {};
    for (const s of studs) {
      const p = s.properties;
      const name = ttl(p, '이름');
      report.students++;
      if (!dryRun) {
        const cols = {
          name, school: rt(p, '학교'), grade: sel(p, '학년'),
          parent_last4: rt(p, '학부모 연락처 끝4자리'), student_phone: rt(p, '학생 연락처'),
          parent_phone: rt(p, '학부모 휴대폰'), parent_relation: sel(p, '학부모 관계'),
          academy: sel(p, '학원'), class_name: sel(p, '반'), approval_status: sel(p, '승인 상태') || '승인',
          personal_key: rt(p, '개인키'), mathflat_name: rt(p, '매쓰플랫 이름'),
          cur_math_grade: sel(p, '현재 수학 등급'), school_math_grade: sel(p, '내신 수학 등급'),
          mock_math_grade: sel(p, '모의고사 수학 등급'), mock_math_raw: num(p, '모의고사 수학 원점수'),
          mock_kor_grade: sel(p, '모의고사 국어 등급'), mock_eng_grade: sel(p, '모의고사 영어 등급'),
          prior_progress: sel(p, '선행 진도'), purposes: JSON.stringify(multi(p, '수강 목적')),
          avail_days: JSON.stringify(multi(p, '등원 가능 요일')), weak_units: rt(p, '취약 단원'),
          notes: rt(p, '특이사항'), target_univ: rt(p, '희망 대학/계열'), notion_page_id: s.id,
        };
        const keys = Object.keys(cols);
        const res = await env.DB.prepare('INSERT INTO students (' + keys.join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')')
          .bind(...keys.map(k => cols[k])).run();
        if (name && nameCount[name] === 1) nameToId[name] = res.meta && res.meta.last_row_id;
        if (표본학생.length < 30) 표본학생.push({ id: res.meta && res.meta.last_row_id, 이름: name, 학교: cols.school, 학년: cols.grade });
      } else {
        if (name && nameCount[name] === 1) nameToId[name] = -1; // dryRun 매칭 표시
      }
    }

    // ── reports (이름→id, 유일이름만) ──
    for (const r of reps) {
      const p = r.properties;
      const sname = rt(p, '학생 이름');
      if (!sname || nameCount[sname] !== 1) { report.reports.unmatched.push(sname || '(빈 이름)'); continue; }
      report.reports.migrated++;
      if (!dryRun) {
        await env.DB.prepare(
          'INSERT INTO reports (student_id, student_name, phone_last4, title, class_date, content, homework, notes, is_public, academy) VALUES (?,?,?,?,?,?,?,?,?,?)'
        ).bind(nameToId[sname], sname, rt(p, '전화번호 끝 4자리'), ttl(p, '리포트 제목'), dat(p, '수업 날짜'),
               rt(p, '수업 내용'), rt(p, '숙제'), rt(p, '특이사항'), chk(p, '공개') ? 1 : 0, sel(p, '학원')).run();
        if (표본리포트.length < 30) 표본리포트.push({ 학생: sname, 수업날짜: dat(p, '수업 날짜'), 제목: ttl(p, '리포트 제목') });
      }
    }

    // ── attendance (R2 attendance/{이름}.json) ──
    const attList = await env.BUCKET.list({ prefix: 'attendance/', limit: 1000 });
    for (const obj of (attList.objects || [])) {
      report.attendance.files++;
      let name; try { name = decodeURIComponent(obj.key.replace('attendance/', '').replace('.json', '')); } catch { name = ''; }
      if (nameCount[name] !== 1) { report.attendance.unmatched.push(name || obj.key); continue; }
      const o = await env.BUCKET.get(obj.key);
      if (!o) continue;
      let rec; try { rec = JSON.parse(await o.text()); } catch { continue; }
      for (const [date, v] of Object.entries(rec.records || {})) {
        const val = (typeof v === 'string') ? { status: v } : (v || {});
        report.attendance.records++;
        if (!dryRun) {
          await env.DB.prepare('INSERT OR REPLACE INTO attendance (student_id, date, status, homework, homework_note, note, method) VALUES (?,?,?,?,?,?,?)')
            .bind(nameToId[name], date, val.status || null, (val.homework === undefined ? null : val.homework), val.homework_note || null, val.note || null, val.method || null).run();
        }
      }
    }

    // ── study (R2 study/{이름}.json) ──
    const stList = await env.BUCKET.list({ prefix: 'study/', limit: 1000 });
    for (const obj of (stList.objects || [])) {
      report.study.files++;
      let name; try { name = decodeURIComponent(obj.key.replace('study/', '').replace('.json', '')); } catch { name = ''; }
      if (nameCount[name] !== 1) { report.study.unmatched.push(name || obj.key); continue; }
      const o = await env.BUCKET.get(obj.key);
      if (!o) continue;
      let rec; try { rec = JSON.parse(await o.text()); } catch { continue; }
      for (const s of (rec.sessions || [])) {
        report.study.sessions++;
        if (!dryRun) {
          await env.DB.prepare('INSERT OR REPLACE INTO study_sessions (id, student_id, started_at, ended_at, minutes, date) VALUES (?,?,?,?,?,?)')
            .bind(s.id, nameToId[name], s.startedAt, s.endedAt, s.minutes, s.date).run();
        }
      }
    }

    // 🔴 한 번의 실행 = 한 건의 로그. (수백 행을 건별로 남기면 로그도 detail 20000자도 터진다)
    //    표별 건수 · 비운 표 · 앞 30건 표본 · 걸린 시간만 담는다.
    await logAudit(env, request, {
      action: dryRun ? 'admin.migrate.d1.dryrun' : 'admin.migrate.d1',
      target: 'D1 전체(accounts·students·reports·attendance·study_sessions)',
      summary: (dryRun ? '[미리보기] ' : '') + '노션→D1 마이그레이션 실행 — 계정 ' + report.accounts
        + ' · 학생 ' + report.students + ' · 리포트 ' + report.reports.migrated
        + ' · 출결 ' + report.attendance.records + ' · 학습 ' + report.study.sessions + '건'
        + (wipeFirst && !dryRun ? ' (기존 5개 표를 먼저 비움)' : ''),
      detail: {
        모드: dryRun ? '미리보기(dryRun) — D1에 쓰지 않음' : '실제 반영(dryRun=false)',
        실행전_D1건수: report.d1Before,
        비우기: (wipeFirst && !dryRun)
          ? { 실행함: true, 지운표: 지운표 }
          : { 실행함: false, 설명: wipeFirst ? 'wipeFirst 요청은 있었으나 미리보기라 지우지 않음' : 'wipeFirst 없음 — 기존 행 유지' },
        넣은건수: {
          계정: report.accounts, 학생: report.students, 리포트: report.reports.migrated,
          출결파일: report.attendance.files, 출결: report.attendance.records,
          학습파일: report.study.files, 학습: report.study.sessions,
        },
        매칭실패: {
          리포트: report.reports.unmatched.slice(0, 50),
          출결: report.attendance.unmatched.slice(0, 50),
          학습: report.study.unmatched.slice(0, 50),
          설명: '이름이 겹치거나(동명이인) 비어 있어 학생과 이어붙이지 못한 것 — D1에 들어가지 않았다.',
        },
        동명이인: report.ambiguousNames,
        표본_학생: 표본학생,
        표본_리포트: 표본리포트,
        걸린시간초: Math.round((Date.now() - 시작) / 100) / 10,
        오류: report.errors,
        효과: dryRun
          ? '아무것도 바뀌지 않았다. 숫자만 세어 본 결과다.'
          : ((wipeFirst ? '기존 5개 표의 모든 행이 지워지고 ' : '') + '노션 데이터가 D1에 들어갔다. 홈페이지·앱이 즉시 이 데이터를 보여준다.'),
        비고: '노션 원본은 읽기만 했다. 비밀번호 해시·salt 값은 D1로 옮기되 로그에는 담지 않는다.',
      },
    });
    return Response.json(report);
  } catch (e) {
    report.ok = false;
    report.errors.push(e.message);
    // 중간에 터졌다 = 일부만 들어간 상태일 수 있다. 어디까지 갔는지가 복구의 유일한 단서다.
    await logAudit(env, request, {
      action: 'admin.migrate.d1.fail',
      target: 'D1 전체',
      summary: '노션→D1 마이그레이션 중단(오류) — ' + String((e && e.message) || e).slice(0, 120),
      detail: {
        모드: dryRun ? '미리보기(dryRun)' : '실제 반영',
        오류: String((e && e.message) || e),
        실행전_D1건수: report.d1Before,
        중단시점까지_넣은건수: {
          계정: report.accounts, 학생: report.students, 리포트: report.reports.migrated,
          출결: report.attendance.records, 학습: report.study.sessions,
        },
        비우기: 지운표,
        걸린시간초: Math.round((Date.now() - 시작) / 100) / 10,
        효과: dryRun
          ? '아무것도 바뀌지 않았다.'
          : '⚠️ 중간까지만 반영된 상태일 수 있다. 위 건수까지는 D1에 들어갔다고 보고 확인해야 한다.',
      },
    });
    return Response.json(report, { status: 500 });
  }
}
