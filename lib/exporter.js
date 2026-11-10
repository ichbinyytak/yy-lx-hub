'use strict';
// 双生态产物导出器：
// 1. 构建带「适用平台前缀标签」的洛雪脚本 ZIP 包（含 00_平台适用清单.txt 与同名旧版分拣）；
// 2. 生成前端静态看板数据 public/data.json。

const fs = require('fs');
const path = require('path');
const zipUtil = require('./zip');

function formatPlatformTag(platforms) {
  const list = Array.isArray(platforms) ? platforms.filter(Boolean) : [];
  if (!list.length) return '';
  if (list.length >= 5) return '[5平台全通]';
  return '[' + list.join('+') + ']';
}

/**
 * 从条目集合生成带平台标签的纯 .js 音源 ZIP Buffer（不包含任何非音源说明文件）。
 * @param {Array} entries 已筛选的可用条目数组
 * @param {object} store
 * @returns {{zipBuffer: Buffer, usableCount: number, uniqueNames: number, manifestItems: Array}}
 */
function buildSourcesZip(entries, store) {
  const seenSha = new Set();
  const groups = new Map();
  let usableCount = 0;

  for (const e of entries) {
    if (!e || e.status !== 'ok' || e.sample) continue;
    const body = store.getBody(e);
    if (!body) continue;
    const sha = e.bodySha || store.saveBody(body);
    if (seenSha.has(sha)) continue;
    seenSha.add(sha);
    usableCount++;

    let baseName = (e.name || 'source').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'source';
    if (!/\.js$/i.test(baseName)) baseName += '.js';
    if (!groups.has(baseName)) groups.set(baseName, []);
    groups.get(baseName).push({ entry: e, body: body });
  }

  if (!usableCount) {
    return { zipBuffer: null, usableCount: 0, uniqueNames: 0, manifestItems: [] };
  }

  const zipFiles = [];
  const manifestItems = [];
  const usedNames = new Set();

  function uniqueZipName(candidate) {
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    const stem = candidate.replace(/\.js$/i, '');
    let n = 2;
    while (usedNames.has(stem + ' (' + n + ').js')) n++;
    const finalName = stem + ' (' + n + ').js';
    usedNames.add(finalName);
    return finalName;
  }

  for (const [baseName, list] of groups) {
    list.sort(function (a, b) {
      return (b.entry.contentUpdatedAt || b.entry.updatedAt || 0) - (a.entry.contentUpdatedAt || a.entry.updatedAt || 0);
    });

    const latest = list[0];
    const tag = formatPlatformTag(latest.entry.platforms);
    const taggedName = uniqueZipName(tag ? (tag + ' ' + baseName) : baseName);
    zipFiles.push({ name: taggedName, data: Buffer.from(latest.body, 'utf8') });
    manifestItems.push({
      fileName: taggedName,
      version: latest.entry.version || '',
      platforms: latest.entry.platforms || [],
      originRepo: latest.entry.originRepo || '',
      origin: latest.entry.origin || ''
    });

    list.slice(1).forEach(function (item, i) {
      const ver = String(item.entry.version || '').trim().replace(/^v/i, '');
      const stem = baseName.replace(/\.js$/i, '');
      const oldTag = formatPlatformTag(item.entry.platforms);
      const subBase = ver ? (stem + ' (v' + ver + ').js') : (stem + ' (' + (i + 2) + ').js');
      const sub = uniqueZipName('疑似早期版本/' + (oldTag ? (oldTag + ' ' + subBase) : subBase));
      zipFiles.push({ name: sub, data: Buffer.from(item.body, 'utf8') });
      manifestItems.push({
        fileName: sub,
        version: item.entry.version || '',
        platforms: item.entry.platforms || [],
        originRepo: item.entry.originRepo || '',
        origin: item.entry.origin || ''
      });
    });
  }

  return {
    zipBuffer: zipUtil.buildZip(zipFiles),
    usableCount: usableCount,
    uniqueNames: groups.size,
    manifestItems: manifestItems
  };
}

/**
 * 导出供静态网页 / GitHub Pages 消费的 public/data.json。
 */
function buildStaticDataJson(db, store, outPath) {
  const dest = outPath || path.join(__dirname, '..', 'public', 'data.json');
  const usable = (db.entries || []).filter(function (e) {
    return e.status === 'ok' && !e.sample && (e.platforms || []).length > 0;
  }).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });

  const platCount = { wy: 0, tx: 0, kw: 0, kg: 0, mg: 0 };
  const labelToKey = { '网易云': 'wy', 'QQ': 'tx', '酷我': 'kw', '酷狗': 'kg', '咪咕': 'mg' };
  for (const e of usable) {
    for (const p of (e.platforms || [])) {
      const k = labelToKey[p] || p;
      platCount[k] = (platCount[k] || 0) + 1;
    }
  }

  const items = usable.map(function (e) {
    const body = store.getBody(e);
    return {
      id: e.id, seq: e.seq || 0, name: e.name || '(未命名)', author: e.author || '',
      version: e.version || '', platforms: e.platforms || [], status: 'ok',
      scriptType: e.scriptType || 'source', platStatus: e.platStatus || null,
      isSource: true, confidence: e.confidence || 'high',
      repoPushAt: e.repoPushAt || 0, contentUpdatedAt: e.contentUpdatedAt || e.updatedAt,
      updatedAt: e.updatedAt, lastOkAt: e.lastOkAt,
      url: e.primaryUrl, origin: e.origin || '', originRepo: e.originRepo || '',
      size: e.bodySize || (body ? body.length : 0),
      sha256: e.bodySha || ''
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    totalEntries: (db.entries || []).length,
    usableCount: usable.length,
    platformStats: platCount,
    items: items
  };

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
  return payload;
}

module.exports = { formatPlatformTag, buildSourcesZip, buildStaticDataJson };
