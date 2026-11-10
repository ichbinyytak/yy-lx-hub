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
  const seen = new Set();
  if (!rawHeaders || typeof rawHeaders !== 'object') return out;
  for (const k of Object.keys(rawHeaders)) {
    const lk = k.toLowerCase();
    if (STRIP_HEADERS.has(lk)) continue;
    const v = rawHeaders[k];
    if (v != null && String(v).length > 0) {
      if (seen.has(lk)) {
        for (const ek of Object.keys(out)) {
          if (ek.toLowerCase() === lk) delete out[ek];
        }
      }
      seen.add(lk);
      out[k] = String(v);
    }
  }
  if (!seen.has('user-agent')) {
    out['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  }
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOne(out, val, token) {
  if (!val) return { text: out, hit: false };
  if (val.length < 8 && /^[0-9A-Za-z._-]+$/.test(val)) {
    const re = new RegExp('(^|[^0-9A-Za-z_])' + escapeRegExp(val) + '(?=$|[^0-9A-Za-z_])', 'g');
    let hit = false;
    const next = out.replace(re, function (_, p1) { hit = true; return p1 + token; });
    return { text: next, hit: hit };
  }
  if (out.indexOf(val) >= 0) {
    return { text: out.split(val).join(token), hit: true };
  }
  return { text: out, hit: false };
}

function replaceAllTokens(str, replacements) {
  let out = String(str || '');
  let hit = false;
  for (const r of replacements) {
    if (!r.value) continue;
    const val = String(r.value);
    const variants = [val];
    const enc = encodeURIComponent(val);
    if (enc !== val) variants.push(enc);
    const plusEnc = enc.replace(/%20/g, '+');
    if (plusEnc !== enc && plusEnc !== val) variants.push(plusEnc);
    for (const v of variants) {
      const res = replaceOne(out, v, r.token);
      if (res.hit) {
        out = res.text;
        hit = true;
      }
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
  const hdrs = Object.assign({}, tpl.headers || {});
  let ct = '';
  for (const k of Object.keys(hdrs)) {
    if (k.toLowerCase() === 'content-type') { ct = String(hdrs[k]).toLowerCase(); break; }
  }

  function subst(s, mode) {
    if (!s) return s;
    const fmt = function (v) {
      const str = String(v || '');
      if (mode === 'url') return encodeURIComponent(str);
      if (mode === 'json') return JSON.stringify(str).slice(1, -1);
      return str;
    };
    return String(s)
      .split('{id}').join(mode === 'json' ? fmt(idVal) : (mode === 'url' ? encodeURIComponent(String(idVal)) : String(idVal)))
      .split('{songmid}').join(fmt(info.songmid || idVal))
      .split('{hash}').join(fmt(hashVal))
      .split('{copyrightId}').join(fmt(info.copyrightId || idVal))
      .split('{name}').join(fmt(info.name || ''))
      .split('{singer}').join(fmt(info.singer || info.artist || ''))
      .split('{album}').join(fmt(info.albumName || ''))
      .split('{interval}').join(fmt(info.interval || ''));
  }

  let bodyOut;
  if (tpl.bodyTemplate) {
    const trimmed = String(tpl.bodyTemplate).trim();
    const bodyMode = ct.indexOf('x-www-form-urlencoded') >= 0
      ? 'url'
      : ((ct.indexOf('json') >= 0 || trimmed.startsWith('{') || trimmed.startsWith('[')) ? 'json' : 'raw');
    bodyOut = subst(tpl.bodyTemplate, bodyMode);
  }

  return {
    url: subst(tpl.urlTemplate, 'url'),
    method: tpl.method || 'GET',
    headers: hdrs,
    body: bodyOut
  };
}

module.exports = { buildTemplate, renderTemplate, cleanHeaders, detectMatchMode };
