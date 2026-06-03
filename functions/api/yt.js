import { safeError } from './_errors.js';

// /api/yt — 공개 YouTube 데이터 읽기 전용 엔드포인트
//
// 보안: API 키는 서버(Cloudflare env)에만 존재하며 클라이언트로 절대 노출되지 않는다.
//       (클라이언트에서 직접 YouTube API를 부르면 키가 브라우저에 노출되므로 일부러 서버 경유)
//
// 필요한 Cloudflare Pages 환경변수:
//   YOUTUBE_API_KEY        (필수)  — YouTube Data API v3 키 ('mathOS-youtube')
//   YT_BRIEFING_PLAYLIST   (선택)  — '설명회' 재생목록 ID (PL... 로 시작)
//   YT_OPENCLASS_PLAYLIST  (선택)  — '공개강의' 재생목록 ID (PL... 로 시작)
//
// 재생목록 ID는 비밀이 아니지만 env로 분리해 코드 수정/재배포 없이 교체 가능하게 둔다.
// 키만 있고 재생목록 ID가 없으면 빈 배열을 돌려준다(프론트는 기본 카드로 폴백).

const CACHE_SECONDS = 1800; // 30분 — 쿼터 절약 + 적당한 신선도

function mapItems(data) {
  return (data.items || [])
    .map((it) => {
      const sn = it.snippet || {};
      const th = sn.thumbnails || {};
      const best = th.maxres || th.standard || th.high || th.medium || th.default || {};
      return {
        videoId:
          (it.contentDetails && it.contentDetails.videoId) ||
          (sn.resourceId && sn.resourceId.videoId) ||
          '',
        title: sn.title || '',
        desc: sn.description || '',
        publishedAt:
          (it.contentDetails && it.contentDetails.videoPublishedAt) ||
          sn.publishedAt ||
          '',
        thumb: best.url || '',
      };
    })
    .filter(
      (v) => v.videoId && v.title !== 'Private video' && v.title !== 'Deleted video',
    );
}

async function fetchPlaylist(apiKey, playlistId) {
  if (!playlistId) return [];
  const url =
    'https://www.googleapis.com/youtube/v3/playlistItems' +
    '?part=snippet,contentDetails&maxResults=50' +
    '&playlistId=' + encodeURIComponent(playlistId) +
    '&key=' + encodeURIComponent(apiKey);
  const res = await fetch(url);
  if (!res.ok) throw new Error('youtube ' + res.status);
  const data = await res.json();
  const items = mapItems(data);
  items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)); // 최신순
  return items;
}

export async function onRequest({ env, request }) {
  try {
    const apiKey = env.YOUTUBE_API_KEY;
    if (!apiKey) {
      // 키 미설정: 프론트가 기본(하드코딩) 카드로 폴백하도록 신호
      return Response.json({ configured: false, briefing: [], openclass: [], latestBriefing: null });
    }

    // 엣지 캐시 (30분) — 쿼터 보호
    let cache = null;
    let cacheKey = null;
    try {
      cache = caches.default;
      cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (_) {
      cache = null;
    }

    const [briefing, openclass] = await Promise.all([
      fetchPlaylist(apiKey, env.YT_BRIEFING_PLAYLIST),
      fetchPlaylist(apiKey, env.YT_OPENCLASS_PLAYLIST),
    ]);

    const payload = {
      configured: true,
      briefing,
      openclass,
      latestBriefing: briefing[0] || null,
    };

    const resp = Response.json(payload);
    resp.headers.set('Cache-Control', 'public, max-age=' + CACHE_SECONDS);
    if (cache && cacheKey) {
      try {
        await cache.put(cacheKey, resp.clone());
      } catch (_) {}
    }
    return resp;
  } catch (e) {
    return safeError(e, env, { message: 'YouTube 정보를 불러오지 못했습니다.' });
  }
}
