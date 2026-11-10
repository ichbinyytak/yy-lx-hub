'use strict';
// 底层物理请求嗅探器与因果判定引擎：
// 在严格串行沙箱窗口内记录脚本发起的每一次 HTTP 请求，
// 通过因果树回溯精准过滤广告/版本检测/打卡等杂质，仅锁定真正产出音频直链的物理请求。

/**
 * 在任意 JSON 对象中递归查找等于或包含 targetUrl（或其关键片段）的访问路径。
 * 返回标准取值路径（如 "data[0].url"）及可能的前缀（如 QQ音乐 urlPrefix + purl）。
 */
function findJsonPath(obj, targetUrl, prefix, depth) {
  prefix = prefix || '';
  depth = depth || 0;
  if (depth > 8 || obj == null) return null;

  if (typeof obj === 'string') {
    const val = obj.trim();
    if (!val) return null;
    // 1. 完全匹配
    if (val === targetUrl) {
      return { path: prefix, urlPrefix: '' };
    }
    // 2. 拼接前缀匹配（如 QQ 音乐 API 只返回 purl = "M800...mp3?guid=...", 最终链接 = sip + purl）
    if (val.length >= 16 && targetUrl.endsWith(val) && targetUrl.length > val.length) {
      const deducedPrefix = targetUrl.slice(0, targetUrl.length - val.length);
      if (/^https?:\/\//i.test(deducedPrefix)) {
        return { path: prefix, urlPrefix: deducedPrefix };
      }
    }
    return null;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 20); i++) {
      const hit = findJsonPath(obj[i], targetUrl, prefix + '[' + i + ']', depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const nextPath = prefix ? (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? prefix + '.' + k : prefix + '[' + JSON.stringify(k) + ']') : k;
      const hit = findJsonPath(obj[k], targetUrl, nextPath, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 过滤掉明确的遥测、日志、更新自检请求，防止误判。
 */
const NOISE_URL_RE = /update|version|telemetry|analytics|beacon|stat|tongji|fangqihang|github\.com|raw\.githubusercontent/i;

function isPrecheckRequest(req, audioUrl) {
  if (!req) return false;
  const m = (req.method || 'GET').toUpperCase();
  if (m === 'HEAD') return true;
  const h = req.headers || {};
  const hasRange = !!(h.range || h.Range);
  const ct = String((req.respHeaders && req.respHeaders['content-type']) || '');
  // 若携带 Range 探测，或直接请求的就是最终直链本身且没有发生跨域名 302 重定向且响应是纯音频流，属于脚本自检试听探针
  if (hasRange && req.url === audioUrl) return true;
  if (req.url === audioUrl && req.finalUrl === audioUrl && /audio|octet-stream/i.test(ct)) return true;
  return false;
}

/**
 * 从当前平台测试窗口拦截到的全部 HTTP 记录中，逆序定位真正产出 audioUrl 的因果 API 请求。
 * 优先匹配 JSON/Text 提取或 302 重定向来源，自动跳过脚本自身对直链的 Range/HEAD 可播性预检请求。
 * @param {Array} traces 请求记录列表
 * @param {string} audioUrl 脚本最终返回且通过 verifyUrl 验证的真实音频直链
 * @returns {object|null} 命中记录及提取方式
 */
function findCausalRequest(traces, audioUrl) {
  if (!Array.isArray(traces) || !traces.length || !audioUrl) return null;

  let directFallback = null;

  for (let i = traces.length - 1; i >= 0; i--) {
    const req = traces[i];
    if (!req || !req.url) continue;
    if (NOISE_URL_RE.test(req.url)) continue;
    if (isPrecheckRequest(req, audioUrl)) continue;

    // 判定条件 A：JSON 响应体内存在通向 audioUrl 的字段路径（最高置信度 API 来源）
    if (req.respBody && typeof req.respBody === 'object') {
      const hit = findJsonPath(req.respBody, audioUrl, '', 0);
      if (hit && hit.path) {
        return {
          trace: req,
          type: 'json',
          responseExtractor: hit.path,
          urlPrefix: hit.urlPrefix || ''
        };
      }
    }

    // 判定条件 B：301/302 跨链重定向直出（如海棠/念心，请求 API 跳转至 CDN 音频直链）
    const redirected = req.url !== req.finalUrl && req.finalUrl === audioUrl;
    const hopHit = Array.isArray(req.redirectChain) && req.redirectChain.some(function (h) {
      return h.location === audioUrl || (h.url !== req.url && h.url === audioUrl);
    });
    if (redirected || hopHit) {
      return {
        trace: req,
        type: 'redirect',
        responseExtractor: '',
        urlPrefix: ''
      };
    }

    // 判定条件 C：纯文本/酷我 mobi 格式响应
    if (typeof req.respText === 'string') {
      const txt = req.respText.trim();
      if (txt === audioUrl) {
        return {
          trace: req,
          type: 'text',
          responseExtractor: '',
          urlPrefix: ''
        };
      }
      const m = txt.match(/url=(https?:\/\/[^\r\n]+)/i);
      if (m && m[1].trim() === audioUrl) {
        return {
          trace: req,
          type: 'regex',
          responseExtractor: 'url=(https?://[^\\r\\n]+)',
          urlPrefix: ''
        };
      }
    }

    // 判定条件 D：未发生重定向的直接命中（记为兜底，仅当找不到上游 JSON/302 API 时才采用）
    if (!directFallback && (req.finalUrl === audioUrl || req.url === audioUrl)) {
      directFallback = {
        trace: req,
        type: 'redirect',
        responseExtractor: '',
        urlPrefix: ''
      };
    }
  }
  return directFallback;
}

/**
 * 在 JSON 响应体中自动探测歌名与歌手字段路径，供 search 模式消费端防串曲校验。
 */
function findMetaFields(obj, songInfo) {
  if (!obj || typeof obj !== 'object' || !songInfo) return null;
  const titleVal = String(songInfo.name || '').trim();
  const artistVal = String(songInfo.singer || songInfo.artist || '').trim();
  if (!titleVal) return null;

  function findExactOrContains(node, target, prefix, depth) {
    if (depth > 6 || node == null) return null;
    if (typeof node === 'string') {
      const s = node.trim();
      if (!s || /^https?:\/\//i.test(s)) return null;
      if (s === target || (target.length >= 2 && s.toLowerCase().indexOf(target.toLowerCase()) >= 0 && s.length <= target.length + 25)) {
        return prefix;
      }
      return null;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, 5); i++) {
        const h = findExactOrContains(node[i], target, prefix + '[' + i + ']', depth + 1);
        if (h) return h;
      }
      return null;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (/^(album|lrc|lyric|pic|cover|url)/i.test(k)) continue;
        const np = prefix ? (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? prefix + '.' + k : prefix + '[' + JSON.stringify(k) + ']') : k;
        const h = findExactOrContains(node[k], target, np, depth + 1);
        if (h) return h;
      }
    }
    return null;
  }

  const titlePath = findExactOrContains(obj, titleVal, '', 0);
  const artistPath = artistVal ? findExactOrContains(obj, artistVal, '', 0) : null;
  if (!titlePath && !artistPath) return null;
  const out = {};
  if (titlePath) out.title = titlePath;
  if (artistPath) out.artist = artistPath;
  return out;
}

module.exports = { findJsonPath, findCausalRequest, findMetaFields };
