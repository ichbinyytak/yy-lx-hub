'use strict';
// 万能公式模板化引擎：将捕获到的物理请求中的测试曲目特征值（ID/Hash/Songmid）反向替换为标准占位符，
// 同时完整保留作者内置的鉴权 Token、APIKey、Cookie 等关键字段。

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

/**
 * 将因果命中的请求规则转换为万能 API 模板。
 * @param {object} opts { platform, song, quality, causal, scriptName }
 * @returns {object|null}
 */
function buildTemplate(opts) {
  const platform = opts.platform;
  const song = opts.song || {};
  const info = song.info || {};
  const causal = opts.causal;
  if (!causal || !causal.trace || !causal.trace.url) return null;

  const trace = causal.trace;
  // 按最具体的字段依次匹配替换（优先 ID/Hash/Songmid，再兜底歌名/歌手）
  const replacements = [];
  if (info.hash) replacements.push({ value: info.hash, token: '{hash}' });
  if (info.copyrightId) replacements.push({ value: info.copyrightId, token: '{id}' });
  if (info.songmid) replacements.push({ value: info.songmid, token: '{id}' });
  if (info.id && info.id !== info.songmid) replacements.push({ value: info.id, token: '{id}' });
  if (info.strMediaMid && info.strMediaMid !== info.songmid) replacements.push({ value: info.strMediaMid, token: '{id}' });
  if (info.name) replacements.push({ value: info.name, token: '{name}' });
  if (info.singer) replacements.push({ value: info.singer, token: '{singer}' });

  const urlRes = replaceAllTokens(trace.url, replacements);
  let bodyRes = { text: '', hit: false };
  if (trace.body != null && String(trace.body).length > 0) {
    bodyRes = replaceAllTokens(String(trace.body), replacements);
  }

  // 必须至少在 URL 或 Body 中成功反向定位到测试曲目 ID/Hash/歌名，才说明具备模板泛化基础
  if (!urlRes.hit && !bodyRes.hit) {
    return null;
  }

  let host = 'unknown';
  let pathname = '/';
  try {
    const u = new URL(trace.url);
    host = u.hostname;
    pathname = u.pathname;
  } catch (e) { /* noop */ }

  return {
    fingerprint: [platform, (trace.method || 'GET').toUpperCase(), host + pathname, causal.type].join('|'),
    platform: platform,
    name: (opts.scriptName ? opts.scriptName + ' · ' : '') + host,
    supportQualities: [opts.quality || '128k'],
    type: causal.type,
    method: (trace.method || 'GET').toUpperCase(),
    urlTemplate: urlRes.text,
    headers: cleanHeaders(trace.headers),
    bodyTemplate: bodyRes.text || undefined,
    responseExtractor: causal.responseExtractor || undefined,
    urlPrefix: causal.urlPrefix || undefined,
    sampleLatencyMs: trace.latencyMs || 0
  };
}

/**
 * 将模板实例化为针对特定歌曲的真实请求参数。
 */
function renderTemplate(tpl, songInfo) {
  const info = songInfo || {};
  const idVal = info.songmid || info.copyrightId || info.id || info.hash || '';
  const hashVal = info.hash || idVal;

  function subst(s) {
    if (!s) return s;
    return String(s)
      .split('{id}').join(String(idVal))
      .split('{songmid}').join(String(info.songmid || idVal))
      .split('{hash}').join(String(hashVal))
      .split('{copyrightId}').join(String(info.copyrightId || idVal))
      .split('{name}').join(encodeURIComponent(String(info.name || '')))
      .split('{singer}').join(encodeURIComponent(String(info.singer || '')));
  }

  return {
    url: subst(tpl.urlTemplate),
    method: tpl.method || 'GET',
    headers: Object.assign({}, tpl.headers || {}),
    body: tpl.bodyTemplate ? subst(tpl.bodyTemplate) : undefined
  };
}

module.exports = { buildTemplate, renderTemplate, cleanHeaders };
