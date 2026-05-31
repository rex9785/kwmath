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
  return Response.json({ error: '마이그레이션은 D1 컷오버 후 비활성화되었습니다. (실수 방지용)', disabled: true }, { status: 403 });

  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증 필요' }, { status: 401 });
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
        await env.DB.prepare('DELETE FROM ' + t).run();
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

    return Response.json(report);
  } catch (e) {
    report.ok = false;
    report.errors.push(e.message);
    return Response.json(report, { status: 500 });
  }
}
