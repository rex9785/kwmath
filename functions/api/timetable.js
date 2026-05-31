import { safeError } from './_errors.js';
const DB = 'e06ead6fdd61424688f15bbb35003c97';

export async function onRequest({ env }) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { property: '공개', checkbox: { equals: true } } }),
    });
    const data = await res.json();
    const joinText = (rt) => (rt || []).map(t => t.plain_text).join('');
    const classes = (data.results || []).map(p => ({
      id: p.id,
      name: (p.properties['반 이름']?.title || []).map(t => t.plain_text).join(''),
      school: p.properties['학원']?.select?.name || '',
      days: (p.properties['요일']?.multi_select || []).map(d => d.name),
      time: joinText(p.properties['시간']?.rich_text),
      target: joinText(p.properties['대상']?.rich_text),
      memo: joinText(p.properties['메모']?.rich_text),
    }));
    return Response.json(classes);
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
