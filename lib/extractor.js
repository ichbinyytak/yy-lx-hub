'use strict';
// API 规则聚合与生命周期管理引擎（去死留活 + 增量纳新）：
// 1. 从上一轮存量档案（db.apiPool / existing extracted_apis.json）与本轮沙箱新抓规则合并去重；
// 2. 全部执行第二曲目交叉验真：
//    - 今天验证通过 → 保留并清零 failStreak，写入最新 extracted_apis.json；
//    - 今天验证失败 → 当日产物立刻踢除（保证产出 100% 可用），failStreak +1；
//    - 连续失败 >= 3 次 → 彻底从存量档案永久清除！

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

/**
 * 聚合存量历史 API + 本轮新发现规则，全量执行第二曲目验真，实现「去死留活、增量纳新」。
 */
async function buildAndSave(db, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const outPath = opts.outPath || path.join(__dirname, '..', 'public', 'extracted_apis.json');

  if (!Array.isArray(db.apiPool)) db.apiPool = [];

  // 若 db.apiPool 为空但磁盘已有上次生成的 extracted_apis.json，先吸纳进来作为存量底座
  if (!db.apiPool.length && fs.existsSync(outPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (prev && Array.isArray(prev.endpoints)) {
        for (const ep of prev.endpoints) {
          if (!ep || !ep.urlTemplate || !ep.platform) continue;
          let host = 'unknown', pathname = '/';
          try { const u = new URL(ep.urlTemplate); host = u.hostname; pathname = u.pathname; } catch (e) {}
          db.apiPool.push(Object.assign({}, ep, {
            fingerprint: ep.fingerprint || [ep.platform, (ep.method || 'GET').toUpperCase(), host + pathname, ep.type || 'json'].join('|'),
            failStreak: 0
          }));
        }
      }
    } catch (e) { /* noop */ }
  }

  const groups = new Map();

  // 1a. 先加载存量存活档案（保留其历史 failStreak / hitCount）
  for (const prev of db.apiPool) {
    if (!prev || !prev.urlTemplate || !prev.platform) continue;
    const key = makeDedupKey(prev);
    groups.set(key, Object.assign({}, prev, {
      fromPrevPool: true,
      hitCount: prev.hitCount || 1,
      failStreak: prev.failStreak || 0
    }));
  }

  // 1b. 合并本轮全部可用脚本新捕获的候选规则
  let newAdded = 0;
  for (const e of (db.entries || [])) {
    if (e.status !== 'ok' || e.sample) continue;
    const sha = e.bodySha;
    const deep = (sha && db.deepCache && db.deepCache[sha]) ? db.deepCache[sha] : e.deep;
    const cands = (deep && Array.isArray(deep.extractedCandidates)) ? deep.extractedCandidates : [];
    for (const c of cands) {
      if (!c || !c.urlTemplate || !c.platform) continue;
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

  log('[萃取] 存量+增量合并共 ' + uniqueList.length + ' 条物理规则（本轮新增 ' + newAdded + '），开始交叉活体复测…');

  // 2. 并发池全量执行多曲目交叉验真
  const verified = [];
  const nextPool = [];
  let purgedCount = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueList.length) {
      const idx = cursor++;
      const tpl = uniqueList[idx];
      const songs = sandbox.TEST_SONGS[tpl.platform] || [];
      const usedIdx = tpl.usedSongIdx != null ? tpl.usedSongIdx : 0;
      const altSongs = songs.filter(function (_, i) { return i !== usedIdx; });
      const checkSongs = altSongs.length ? altSongs : songs;
      if (!checkSongs.length) continue;

      let passed = null;
      let lastReason = '';
      for (const altSong of checkSongs) {
        const vr = await verifier.verifyTemplateWithSecondSong(tpl, altSong);
        if (vr.ok) {
          passed = vr;
          break;
        }
        lastReason = vr.reason || '未知失败';
      }

      if (passed) {
        const alive = Object.assign({}, tpl, {
          verifiedStatus: 'ok',
          failStreak: 0,
          lastOkAt: Date.now(),
          sampleLatencyMs: passed.sampleLatencyMs || tpl.sampleLatencyMs || 0
        });
        verified.push(alive);
        nextPool.push(alive);
        log('[验真✓] [' + tpl.platform + '] ' + tpl.urlTemplate.slice(0, 70) + ' (' + (passed.sampleLatencyMs || 0) + 'ms)');
      } else {
        const fails = (tpl.failStreak || 0) + 1;
        if (fails < MAX_API_FAIL_STREAK) {
          nextPool.push(Object.assign({}, tpl, { failStreak: fails, verifiedStatus: 'failed' }));
          log('[验真✘] [' + tpl.platform + '] ' + tpl.urlTemplate.slice(0, 70) + ' · ' + lastReason + ' (暂踢出今日输出，连续失败 ' + fails + '/' + MAX_API_FAIL_STREAK + ')');
        } else {
          purgedCount++;
          log('[清除✘] [' + tpl.platform + '] ' + tpl.urlTemplate.slice(0, 70) + ' · 连续失效满 ' + MAX_API_FAIL_STREAK + ' 次，已永久移出档案');
        }
      }
    }
  }

  const workers = [];
  const conc = Math.min(4, Math.max(1, uniqueList.length));
  for (let i = 0; i < conc; i++) workers.push(worker());
  await Promise.all(workers);

  // 更新持久化档案
  db.apiPool = nextPool;

  // 按物理端点指纹（platform + method + host + pathname）强去重输出今日黄金菜单
  const dedupVerified = [];
  const seenFp = new Map();
  verified.sort(function (a, b) {
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
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return (a.sampleLatencyMs || 9999) - (b.sampleLatencyMs || 9999);
    })
    .map(function (ep, i) {
      const clean = {
        id: makeEndpointId(ep, i),
        name: ep.name,
        platform: ep.platform,
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

  log('[萃取] 完成！留存黄金 API ' + endpoints.length + ' 个' + (purgedCount ? '，永久清除过期 API ' + purgedCount + ' 个' : ''));
  return { ok: true, totalEndpoints: endpoints.length, purgedCount: purgedCount, outPath: outPath, data: payload };
}

module.exports = { buildAndSave };
