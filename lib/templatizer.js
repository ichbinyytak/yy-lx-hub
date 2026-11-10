'use strict';
// 万能公式模板化引擎：
// 1. 将测试曲目特征值（ID/Hash/Songmid/歌名/歌手/专辑/时长）反向替换为标准占位符，防止专辑名等残留污染模板；
// 2. 自动识别精确 ID 取链 (matchMode: "id") 与关键词搜索取链 (matchMode: "search")；
// 3. 拦截被污染的拼接搜索词（如 {name}{album} 紧贴拼接）。

const STRIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'accept-encoding', 'date'
]);

function cleanHeaders(rawHeaders) {
  const out = {};
  if (!rawHeaders || typeof rawHeaders !== 'object') return out;
  for (const k of Object.keys(rawHeaders)) {
    const lk = k.toLowerCase();
    if (STRIP_HEADERS.has(lk)) continue;
    const v = rawHeaders[k];
    if (v != null && String(v).length > 0) {
      out[k] = String(v);
    }
  }
  if (!out['User-Agent'] && !out['user-agent']) {
    out['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  }
  return out;
}

function replaceAllTokens(str, replacements) {
  let out = String(str || '');
  let hit = false;
  for (const r of replacements) {
    if (!r.value) continue;
    const val = String(r.value);
    if (out.indexOf(val) >= 0) {
      out = out.split(val).join(r.token);
      hit = true;
    }
    const enc = encodeURIComponent(val);
    if (enc !== val && out.indexOf(enc) >= 0) {
      out = out.split(enc).join(r.token);
      hit = true;
    }
  }
  return { text: out, hit: hit };
}

function detectMatchMode(urlTpl, bodyTpl) {
  const combined = String(urlTpl || '') + ' ' + String(bodyTpl || '');
  if (/\{(?:id|songmid|hash|copyrightId)\}/.test(combined)) return 'id';
  return 'search';
}

/**
 * 将因果命中的请求规则转换为万能 API 模板。
 * @param {object} opts { platform, song, quality, causal, scriptName, metaFields }
 * @returns {object|null}
 */
function buildTemplate(opts) {
  const platform = opts.platform;
  const song = opts.song || {};
  const info = song.info || {};
  const causal = opts.causal;
  if (!causal || !causal.trace || !causal.trace.url) return null;

  const trace = causal.trace;
  // 按最具体且长度优先的顺序替换，完整覆盖 albumName 与 interval，杜绝测试词残留污染
  const replacements = [];
  if (info.hash) replacements.push({ value: info.hash, token: '{hash}' });
  if (info.copyrightId) replacements.push({ value: info.copyrightId, token: '{id}' });
  if (info.songmid) replacements.push({ value: info.songmid, token: '{id}' });
  if (info.id && info.id !== info.songmid) replacements.push({ value: info.id, token: '{id}' });
  if (info.strMediaMid && info.strMediaMid !== info.songmid) replacements.push({ value: info.strMediaMid, token: '{id}' });
  if (info.albumName && info.albumName !== info.name) replacements.push({ value: info.albumName, token: '{album}' });
  if (info.interval) replacements.push({ value: info.interval, token: '{interval}' });
  if (info.name) replacements.push({ value: info.name, token: '{name}' });
  if (info.singer) replacements.push({ value: info.singer, token: '{singer}' });

  const urlRes = replaceAllTokens(trace.url, replacements);
  let bodyRes = { text: '', hit: false };
  if (trace.body != null && String(trace.body).length > 0) {
    bodyRes = replaceAllTokens(String(trace.body), replacements);
  }

  // 必须至少在 URL 或 Body 中成功反向定位到测试曲目 ID/Hash/歌名
  if (!urlRes.hit && !bodyRes.hit) {
    return null;
  }

  // 防污染门禁：若在搜索参数中把 {name} 与 {album} 无分隔拼接在一起（如 msg={name}{album}），必导致串翻唱，直接丢弃
  if (/\{name\}(?:%20|\s|\+)?\{album\}|\{album\}(?:%20|\s|\+)?\{name\}/i.test(urlRes.text)) {
    return null;
  }

  const matchMode = detectMatchMode(urlRes.text, bodyRes.text);

  let host = 'unknown';
  let pathname = '/';
  try {
    const u = new URL(trace.url);
    host = u.hostname;
    pathname = u.pathname;
  } catch (e) { /* noop */ }

  const out = {
    fingerprint: [platform, (trace.method || 'GET').toUpperCase(), host + pathname, causal.type].join('|'),
    platform: platform,
    name: (opts.scriptName ? opts.scriptName + ' · ' : '') + host,
    matchMode: matchMode,
    supportQualities: [opts.quality || '320k'],
    type: causal.type,
    method: (trace.method || 'GET').toUpperCase(),
    urlTemplate: urlRes.text,
    headers: cleanHeaders(trace.headers),
    bodyTemplate: bodyRes.text || undefined,
    responseExtractor: causal.responseExtractor || undefined,
    urlPrefix: causal.urlPrefix || undefined,
    sampleLatencyMs: trace.latencyMs || 0
  };
  if (opts.metaFields && (opts.metaFields.title || opts.metaFields.artist)) {
    out.metaFields = opts.metaFields;
  }
  return out;
}

/**
 * 将模板实例化为针对特定歌曲的真实请求参数。
 */
function renderTemplate(tpl, songInfo) {
  const info = songInfo || {};
  const idVal = info.songmid || info.copyrightId || info.id || info.hash || '';
  const hashVal = info.hash || idVal;

  function subst(s, encodeValues) {
    if (!s) return s;
    const enc = function (v) { return encodeValues ? encodeURIComponent(String(v || '')) : String(v || ''); };
    return String(s)
      .split('{id}').join(String(idVal))
      .split('{songmid}').join(String(info.songmid || idVal))
      .split('{hash}').join(String(hashVal))
      .split('{copyrightId}').join(String(info.copyrightId || idVal))
      .split('{name}').join(enc(info.name || ''))
      .split('{singer}').join(enc(info.singer || info.artist || ''))
      .split('{album}').join(enc(info.albumName || ''))
      .split('{interval}').join(enc(info.interval || ''));
  }

  return {
    url: subst(tpl.urlTemplate, true),
    method: tpl.method || 'GET',
    headers: Object.assign({}, tpl.headers || {}),
    body: tpl.bodyTemplate ? subst(tpl.bodyTemplate, false) : undefined
  };
}

module.exports = { buildTemplate, renderTemplate, cleanHeaders, detectMatchMode };
