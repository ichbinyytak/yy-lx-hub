'use strict';
// 动态 30 天 GitHub 源池雷达：自动搜寻全网近期高频维护的洛雪音源仓库，告别僵尸死仓。

const EXCLUDE_REPOS = new Set([
  'lyswhut/lx-music-desktop',
  'lyswhut/lx-music-mobile',
  'zlyon/lx-hub',
  'zlyon/lx-hunter',
  'zlyon/lx-hunter-market'
]);

// 排除非音源脚本仓（如播放器本体、安卓客户端、桌面插件、下载器）
const EXCLUDE_NAME_RE = /(?:^|[-_/])(android|desktop|mobile|harmony|player|plugin|downloader|astrbot|fnos|iwebplayer)(?:$|[-_/])/i;

function cutoffDateStr(days) {
  const d = new Date(Date.now() - Math.max(1, Number(days) || 30) * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * 调用 GitHub Search API 扫描近期活跃仓库。
 * @param {object} opts { cfg, ua, days, fetchFn, log }
 * @returns {Promise<{ok: boolean, repos: Array<{repo: string, pushedAt: number, stars: number}>, error?: string}>}
 */
async function scanActiveRepos(opts) {
  opts = opts || {};
  const cfg = opts.cfg || {};
  const days = Math.max(1, Number(opts.days || cfg.radarDays) || 30);
  const since = cutoffDateStr(days);
  const log = opts.log || function () {};

  const headers = {
    'accept': 'application/vnd.github+json',
    'user-agent': opts.ua || 'yy-lx-hub/2.0'
  };
  if (cfg.ghToken) headers.authorization = 'Bearer ' + cfg.ghToken;

  const queries = [
    'lx-music-source pushed:>' + since,
    'lx-music 音源 pushed:>' + since,
    'lxmusic pushed:>' + since
  ];

  const found = new Map();
  let lastErr = '';

  for (const q of queries) {
    const apiUrl = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&sort=updated&order=desc&per_page=20';
    let json = null;
    try {
      if (typeof opts.fetchFn === 'function') {
        const r = await opts.fetchFn(apiUrl, { headers: headers, timeout: 10000 });
        if (r && r.ok && r.text) json = JSON.parse(r.text);
        else lastErr = (r && (r.error || ('HTTP ' + r.status))) || 'search failed';
      } else {
        const res = await fetch(apiUrl, { headers: headers, signal: AbortSignal.timeout(10000) });
        if (res.ok) json = await res.json();
        else lastErr = 'HTTP ' + res.status;
      }
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }

    if (json && Array.isArray(json.items)) {
      for (const item of json.items) {
        const fullName = item && item.full_name;
        if (!fullName || !/^[\w.\-]+\/[\w.\-]+$/.test(fullName)) continue;
        if (EXCLUDE_REPOS.has(fullName.toLowerCase())) continue;
        if (EXCLUDE_NAME_RE.test(fullName)) continue;
        if (item.archived || item.disabled) continue;
        // 排除巨型客户端/工具项目（> 30MB）
        if (item.size && item.size > 30000) continue;
        const pushedAt = item.pushed_at ? new Date(item.pushed_at).getTime() : 0;
        const stars = Number(item.stargazers_count) || 0;
        if (!found.has(fullName)) {
          found.set(fullName, { repo: fullName, pushedAt: pushedAt, stars: stars });
        }
      }
    }
    // 温和间隔防止触发 GitHub Search 二级限流
    await new Promise(function (r) { setTimeout(r, 400); });
  }

  const list = Array.from(found.values())
    .sort(function (a, b) {
      // 唯新不破：严格按最后代码更新时间倒序排列，最新更新的仓库排在最前面
      if (b.pushedAt !== a.pushedAt) return b.pushedAt - a.pushedAt;
      return b.stars - a.stars;
    })
    .slice(0, 25);

  if (list.length) {
    log('[雷达] 动态发现 ' + list.length + ' 个近 ' + days + ' 天活跃音源仓');
    return { ok: true, repos: list };
  }
  return { ok: false, repos: [], error: lastErr || '未发现满足条件的活跃仓' };
}

module.exports = { scanActiveRepos, cutoffDateStr, EXCLUDE_REPOS };
