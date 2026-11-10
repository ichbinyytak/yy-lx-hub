'use strict';
// API 规则聚合与生命周期管理引擎（严格双曲差分门禁 + 去死留活 + 增量纳新）：
// 1. 强门禁：每个端点必须通过至少 2 首不同曲目（含核心 VIP 曲目）的双曲差分验证，拦截假接口与 30s 试听漏网；
// 2. 动态 Header 清理：自动探测并剥离含时间戳的 X-Token 等非标准头，防止模板未来过期；
// 3. 精准区分 matchMode ("id" vs "search") 并附带 metaFields 方便消费端做歌名防串曲校验；
// 4. 调度排序：ID 精确型永远优先于关键词搜索型。

const fs = require('fs');
const path = require('path');
const sandbox = require('./sandbox');
const verifier = require('./verifier');

const MAX_API_FAIL_STREAK = 3;

function makeEndpointId(tpl, index) {
  let host = 'api';
  try {
    host = new URL(tpl.urlTemplate).hostname.replace(/^www\./, '').replace(/[^a-z0-9]/gi, '_');
  } catch (e) { /* noop */ }
  return (tpl.platform + '_' + host + '_' + (index + 1)).toLowerCase();
}

function makeDedupKey(c) {
  return [
    c.fingerprint || (c.platform + '|' + (c.method || 'GET')),
    c.urlTemplate || '',
    c.bodyTemplate || ''
  ].join('|');
}

function isCleanTemplate(c) {
  if (!c || !c.urlTemplate || !c.platform) return false;
  // 拦截残留硬编码测试专辑名或拼接污染模板
  if (/叶惠美|乐与怒|周杰伦|陈奕迅|海阔天空|晴天|孤勇者|告白气球|05%3A26|04%3A29/.test(c.urlTemplate)) return false;
  if (/\{name\}(?:%20|\s|\+)?\{album\}|\{album\}(?:%20|\s|\+)?\{name\}/i.test(c.urlTemplate)) return false;
  return true;
}

/**
 * 聚合存量历史 API + 本轮新发现规则，全量执行双曲差分验真，实现「去死留活、增量纳新」。
 */
async function buildAndSave(db, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const outPath = opts.outPath || path.join(__dirname, '..', 'public', 'extracted_apis.json');

  if (!Array.isArray(db.apiPool)) db.apiPool = [];

  if (!db.apiPool.length && fs.existsSync(outPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (prev && Array.isArray(prev.endpoints)) {
        for (const ep of prev.endpoints) {
          if (!isCleanTemplate(ep)) continue;
          let host = 'unknown', pathname = '/';
          try { const u = new URL(ep.urlTemplate); host = u.hostname; pathname = u.pathname; } catch (e) {}
          db.apiPool.push(Object.assign({}, ep, {
            fingerprint: ep.fingerprint || [ep.platform, (ep.method || 'GET').toUpperCase(), host + pathname, ep.type || 'json'].join('|'),
            matchMode: ep.matchMode || (/\{(?:id|songmid|hash|copyrightId)\}/.test(ep.urlTemplate + ' ' + (ep.bodyTemplate || '')) ? 'id' : 'search'),
            failStreak: 0
          }));
        }
      }
    } catch (e) { /* noop */ }
  }

  const groups = new Map();

  for (const prev of db.apiPool) {
    if (!isCleanTemplate(prev)) continue;
    const key = makeDedupKey(prev);
    groups.set(key, Object.assign({}, prev, {
      fromPrevPool: true,
      hitCount: prev.hitCount || 1,
      failStreak: prev.failStreak || 0
    }));
  }

  let newAdded = 0;
  for (const e of (db.entries || [])) {
    if (e.status !== 'ok' || e.sample) continue;
    const sha = e.bodySha;
    const deep = (sha && db.deepCache && db.deepCache[sha]) ? db.deepCache[sha] : e.deep;
    const cands = (deep && Array.isArray(deep.extractedCandidates)) ? deep.extractedCandidates : [];
    for (const c of cands) {
      if (!isCleanTemplate(c)) continue;
      const dedupKey = makeDedupKey(c);
      if (!groups.has(dedupKey)) {
        newAdded++;
        groups.set(dedupKey, Object.assign({}, c, {
          hitCount: 1,
          failStreak: 0,
          fromScripts: [e.name || e.id]
        }));
      } else {
        const g = groups.get(dedupKey);
        if (!g.fromPrevPool) g.hitCount += 1;
        g.fromPrevPool = false;
        if (!g.metaFields && c.metaFields) g.metaFields = c.metaFields;
        if (c.sampleLatencyMs && (!g.sampleLatencyMs || c.sampleLatencyMs < g.sampleLatencyMs)) {
          g.sampleLatencyMs = c.sampleLatencyMs;
        }
      }
    }
  }

  const uniqueList = Array.from(groups.values())
    .sort(function (a, b) {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return (a.sampleLatencyMs || 9999) - (b.sampleLatencyMs || 9999);
    });

  log('[萃取] 存量+增量合并共 ' + uniqueList.length + ' 条物理规则（本轮新增 ' + newAdded + '），开始双曲差分严格验真…');

  const verified = [];
  const nextPool = [];
  let purgedCount = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueList.length) {
      const idx = cursor++;
      let tpl = uniqueList[idx];
      const songs = sandbox.TEST_SONGS[tpl.platform] || [];
      if (songs.length < 2) continue;
      const songA = songs[0];
      const songB = songs[1];

      const vr = await verifier.verifyTemplateDualSong(tpl, songA, songB);
      if (vr.ok) {
        // 尝试剥离可能过期的动态非标准请求头（如含时间戳的 X-Token）
        tpl = await verifier.tryStripEphemeralHeaders(tpl, songA, songB);
        if (tpl.strippedExtraHeaders && tpl.strippedExtraHeaders.length) {
          log('[净化] [' + tpl.platform + '] 已剥离冗余动态头: ' + tpl.strippedExtraHeaders.join(','));
        }
        const alive = Object.assign({}, tpl, {
          verifiedStatus: 'ok',
          failStreak: 0,
          lastOkAt: Date.now(),
          sampleLatencyMs: vr.sampleLatencyMs || tpl.sampleLatencyMs || 0
        });
        verified.push(alive);
        nextPool.push(alive);
        log('[双曲✓] [' + tpl.platform + '][' + (tpl.matchMode || 'id') + '] ' + tpl.urlTemplate.slice(0, 70) + ' (' + alive.sampleLatencyMs + 'ms)');
      } else {
        const fails = (tpl.failStreak || 0) + 1;
        if (fails < MAX_API_FAIL_STREAK) {
          nextPool.push(Object.assign({}, tpl, { failStreak: fails, verifiedStatus: 'failed' }));
          log('[双曲✘] [' + tpl.platform + '] ' + tpl.urlTemplate.slice(0, 70) + ' · ' + vr.reason + ' (连续失败 ' + fails + '/' + MAX_API_FAIL_STREAK + ')');
        } else {
          purgedCount++;
          log('[清除✘] [' + tpl.platform + '] ' + tpl.urlTemplate.slice(0, 70) + ' · 连续失效满 ' + MAX_API_FAIL_STREAK + ' 次，已永久移出');
        }
      }
    }
  }

  const workers = [];
  const conc = Math.min(4, Math.max(1, uniqueList.length));
  for (let i = 0; i < conc; i++) workers.push(worker());
  await Promise.all(workers);

  db.apiPool = nextPool;

  // 按物理端点指纹去重，优先保留稳定（非数组末尾下标、ID精确型、命中权重高、延迟低）的端点
  function qualityRank(ep) {
    const modeScore = (ep.matchMode || 'id') === 'id' ? 0 : 1000;
    const arrayIdxPenalty = /\[\d+\]\./.test(ep.responseExtractor || '') ? 500 : 0;
    return modeScore + arrayIdxPenalty;
  }

  const dedupVerified = [];
  const seenFp = new Map();
  verified.sort(function (a, b) {
    const qa = qualityRank(a), qb = qualityRank(b);
    if (qa !== qb) return qa - qb;
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    return (a.sampleLatencyMs || 9999) - (b.sampleLatencyMs || 9999);
  });
  for (const ep of verified) {
    const fp = ep.fingerprint || ep.urlTemplate;
    if (!seenFp.has(fp)) {
      seenFp.set(fp, ep);
      dedupVerified.push(ep);
    } else {
      seenFp.get(fp).hitCount = (seenFp.get(fp).hitCount || 1) + (ep.hitCount || 1);
    }
  }

  const endpoints = dedupVerified
    .sort(function (a, b) {
      const qa = qualityRank(a), qb = qualityRank(b);
      if (qa !== qb) return qa - qb;
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return (a.sampleLatencyMs || 9999) - (b.sampleLatencyMs || 9999);
    })
    .map(function (ep, i) {
      const clean = {
        id: makeEndpointId(ep, i),
        name: ep.name,
        platform: ep.platform,
        matchMode: ep.matchMode || 'id',
        supportQualities: ep.supportQualities || ['320k'],
        type: ep.type,
        method: ep.method || 'GET',
        urlTemplate: ep.urlTemplate,
        headers: ep.headers || { 'User-Agent': 'Mozilla/5.0' },
        verifiedStatus: 'ok',
        hitCount: ep.hitCount || 1,
        sampleLatencyMs: ep.sampleLatencyMs || 0
      };
      if (ep.bodyTemplate) clean.bodyTemplate = ep.bodyTemplate;
      if (ep.responseExtractor) clean.responseExtractor = ep.responseExtractor;
      if (ep.urlPrefix) clean.urlPrefix = ep.urlPrefix;
      if (ep.metaFields) clean.metaFields = ep.metaFields;
      return clean;
    });

  const payload = {
    version: '2.0.0',
    updatedAt: new Date().toISOString(),
    totalEndpoints: endpoints.length,
    endpoints: endpoints
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, outPath);

  log('[萃取] 完成！通过双曲差分验真留存黄金 API ' + endpoints.length + ' 个' + (purgedCount ? '，永久清除过期 API ' + purgedCount + ' 个' : ''));
  return { ok: true, totalEndpoints: endpoints.length, purgedCount: purgedCount, outPath: outPath, data: payload };
}

module.exports = { buildAndSave };
