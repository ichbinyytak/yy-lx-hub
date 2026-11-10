'use strict';
// 第二曲目纯 HTTP 验真引擎：脱离 VM 沙箱，纯 Node HTTP 回放验证模板泛化能力，
// 严守「音频魔数 + >1.2MB 完整音频门禁」，彻底过滤需要端侧动态算密或仅吐 30s 试听的假规则。

const netguard = require('./netguard');
const templatizer = require('./templatizer');

const MIN_VALID_BYTES = 1200000; // ~1.2MB 严格门禁：拦截 30 秒试听截断片段与假语音报错提示

function looksAudio(headAscii, b0, b1) {
  if (headAscii.slice(0, 3) === 'ID3') return true;
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true;
  const four = headAscii.slice(0, 4);
  if (four === 'fLaC' || four === 'OggS' || four === 'RIFF') return true;
  if (headAscii.slice(4, 8) === 'ftyp') return true;
  return false;
}

/**
 * 按点号/下标路径从 JSON 对象提取字段值，例如 "data[0].url" 或 "hot.data.urls[0].purl"
 */
function extractByPath(obj, expr) {
  if (!obj || !expr) return null;
  const tokens = [];
  const re = /([^.\[\]]+)|\[(\d+|"[^"]+"|'[^']+')\]/g;
  let m;
  while ((m = re.exec(expr))) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(m[2].replace(/^['"]|['"]$/g, ''));
  }
  let cur = obj;
  for (const t of tokens) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[t];
  }
  return typeof cur === 'string' ? cur : null;
}

/**
 * 音频直链真实性双门禁校验：Magic Number + 总体积 > 1.2MB
 * @param {string} url
 * @param {object} [opts] { minBytes, ua }
 */
async function verifyAudioStream(url, opts) {
  opts = opts || {};
  const minBytes = opts.minBytes != null ? opts.minBytes : MIN_VALID_BYTES;
  const ua = opts.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, reason: '无效 URL' }; }

  try {
    const res = await netguard.safeFetch(u.toString(), {
      method: 'GET',
      headers: { 'Range': 'bytes=0-16383', 'User-Agent': ua },
      timeout: 7000
    });
    if (!res) return { ok: false, reason: '无响应' };
    const ct = res.headers.get('content-type') || '';
    if (/json|text\/html|text\/plain/i.test(ct)) {
      return { ok: false, reason: '非音频响应 (' + ct + ')' };
    }
    if (!res.ok && res.status !== 206) {
      return { ok: false, reason: 'HTTP ' + res.status };
    }

    // 解析音频总大小（先看 Content-Range，再看非 206 时的 Content-Length）
    let totalBytes = 0;
    const cr = res.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) {
      totalBytes = parseInt(m[1], 10);
    } else if (res.status === 200) {
      const cl = res.headers.get('content-length');
      if (cl && /^\d+$/.test(cl)) totalBytes = parseInt(cl, 10);
    }

    if (totalBytes > 0 && totalBytes < minBytes) {
      return { ok: false, reason: '尺寸过小(' + Math.round(totalBytes / 1024) + 'KB < 1.2MB，疑似试听片段)' };
    }

    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (bytes.length < 12) return { ok: false, reason: '空响应体' };

    let ascii = '';
    for (let i = 0; i < Math.min(bytes.length, 16); i++) ascii += String.fromCharCode(bytes[i]);
    const audioOk = looksAudio(ascii, bytes[0], bytes[1]) || /audio|octet-stream/i.test(ct);
    if (!audioOk) {
      return { ok: false, reason: '未通过音频魔数校验 (' + (ct || '未知') + ')' };
    }

    return { ok: true, totalBytes: totalBytes || bytes.length, headBytes: bytes, finalUrl: res._finalUrl || url };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 80) };
  }
}

/**
 * 使用第二首基准测试曲目，脱离沙箱纯 HTTP 回放验证模板可用性。
 * @param {object} tpl 模板规则
 * @param {object} secondSong 第二首测试曲目
 * @returns {Promise<{ok: boolean, reason?: string, sampleLatencyMs?: number}>}
 */
async function verifyTemplateWithSecondSong(tpl, secondSong) {
  if (!tpl || !secondSong || !secondSong.info) {
    return { ok: false, reason: '缺少验真曲目' };
  }
  const req = templatizer.renderTemplate(tpl, secondSong.info);
  const t0 = Date.now();
  try {
    if (tpl.type === 'redirect') {
      const v = await verifyAudioStream(req.url, { ua: req.headers['User-Agent'] });
      if (!v.ok) return { ok: false, reason: '重定向回放失败: ' + v.reason };
      return { ok: true, sampleLatencyMs: Date.now() - t0 };
    }

    const res = await netguard.safeFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      timeout: 8000
    });
    if (!res || !res.ok) {
      return { ok: false, reason: 'HTTP ' + (res ? res.status : 0) };
    }

    const text = await res.text();
    let audioUrl = '';
    if (tpl.type === 'json') {
      const j = JSON.parse(text);
      const val = extractByPath(j, tpl.responseExtractor);
      if (!val) return { ok: false, reason: 'JSON 路径未取到有效值 (' + tpl.responseExtractor + ')' };
      audioUrl = (tpl.urlPrefix || '') + val;
    } else if (tpl.type === 'text') {
      audioUrl = text.trim();
    } else if (tpl.type === 'regex' && tpl.responseExtractor) {
      const re = new RegExp(tpl.responseExtractor, 'i');
      const m = text.match(re);
      audioUrl = m && m[1] ? m[1].trim() : '';
    }

    if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
      return { ok: false, reason: '未能解析出合法音频链接' };
    }
    const v = await verifyAudioStream(audioUrl, { ua: req.headers['User-Agent'] });
    if (!v.ok) return { ok: false, reason: '音频门禁拦截: ' + v.reason };
    return { ok: true, sampleLatencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 80) };
  }
}

module.exports = { MIN_VALID_BYTES, looksAudio, extractByPath, verifyAudioStream, verifyTemplateWithSecondSong };
