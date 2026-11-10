'use strict';
// 严格多曲目差分验真引擎：
// 1. 强门禁：要求两首不同基准曲目（含核心 VIP 曲目）均通过 >1.2MB + 音频魔数校验，绝不放过 30s 试听漏网；
// 2. 差分校验：对比两首歌返回的 CDN URL path 与字节大小，拦截“无论传什么 ID 都固定放同一首歌”的假接口；
// 3. 歌名防串曲校验：若 JSON 响应自带歌名字段，检查是否与请求歌名相符，拦截翻唱/串歌；
// 4. 动态 Header 剥离探测：尝试剥离含时间戳的 X-Token 等非标准请求头，若剥离后依然双曲通过则永不过期。

const netguard = require('./netguard');
const templatizer = require('./templatizer');

const MIN_VALID_BYTES = 1200000; // ~1.2MB 严格门禁
const STANDARD_HEADERS = new Set(['user-agent', 'content-type', 'referer', 'accept', 'origin']);

function looksAudio(headAscii, b0, b1) {
  if (headAscii.slice(0, 3) === 'ID3') return true;
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true;
  const four = headAscii.slice(0, 4);
  if (four === 'fLaC' || four === 'OggS' || four === 'RIFF') return true;
  if (headAscii.slice(4, 8) === 'ftyp') return true;
  return false;
}

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

function normalizeTitle(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\(\)（）【】\[\]\-·:：'’"“”,，.。!！?？]/g, '')
    .replace(/(live|dj|伴奏|纯音乐|翻唱|cover|现场|remix).*$/i, '');
}

function isTitleCompatible(returnedTitle, expectedTitle) {
  if (!returnedTitle || !expectedTitle) return true;
  const a = normalizeTitle(returnedTitle);
  const b = normalizeTitle(expectedTitle);
  if (!a || !b) return true;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
  return false;
}

/**
 * 在未显式指定 metaFields 时，从常见 JSON 结构中读取歌名字段进行防串曲兜底校验。
 */
function pickReturnedTitle(jsonObj, tpl) {
  if (!jsonObj || typeof jsonObj !== 'object') return '';
  if (tpl && tpl.metaFields && tpl.metaFields.title) {
    const t = extractByPath(jsonObj, tpl.metaFields.title);
    if (t) return t;
  }
  const d = (jsonObj.data && typeof jsonObj.data === 'object' && !Array.isArray(jsonObj.data)) ? jsonObj.data : jsonObj;
  const arr0 = (Array.isArray(jsonObj.data) && jsonObj.data[0] && typeof jsonObj.data[0] === 'object') ? jsonObj.data[0] : null;
  for (const box of [d, arr0, jsonObj]) {
    if (!box) continue;
    for (const k of ['song', 'song_name', 'songName', 'title', 'name']) {
      if (typeof box[k] === 'string' && box[k].trim()) return box[k].trim();
    }
  }
  return '';
}

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

    const finalUrl = res._finalUrl || url;
    let cdnPath = finalUrl;
    try { cdnPath = new URL(finalUrl).pathname; } catch (e) {}
    return { ok: true, totalBytes: totalBytes || bytes.length, headBytes: bytes, finalUrl: finalUrl, cdnPath: cdnPath };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 80) };
  }
}

async function verifyTemplateSingleSong(tpl, song) {
  if (!tpl || !song || !song.info) {
    return { ok: false, reason: '缺少验真曲目' };
  }
  const req = templatizer.renderTemplate(tpl, song.info);
  const t0 = Date.now();
  try {
    if (tpl.type === 'redirect') {
      const v = await verifyAudioStream(req.url, { ua: req.headers['User-Agent'] });
      if (!v.ok) return { ok: false, reason: '重定向回放失败: ' + v.reason };
      return { ok: true, sampleLatencyMs: Date.now() - t0, totalBytes: v.totalBytes, cdnPath: v.cdnPath, finalUrl: v.finalUrl };
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
      const retTitle = pickReturnedTitle(j, tpl);
      if (retTitle && !isTitleCompatible(retTitle, song.info.name || song.name)) {
        return { ok: false, reason: '歌名串曲拦截 (期望「' + (song.info.name || song.name) + '」，实际返回「' + retTitle + '」)' };
      }
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
    return { ok: true, sampleLatencyMs: Date.now() - t0, totalBytes: v.totalBytes, cdnPath: v.cdnPath, finalUrl: v.finalUrl };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 80) };
  }
}

/**
 * 双曲严格门禁 + 差分校验：
 * 要求两首不同基准曲目均通过 >1.2MB+魔数+歌名校验，且两次返回绝不能指向同一个静态文件！
 */
async function verifyTemplateDualSong(tpl, songA, songB) {
  const rA = await verifyTemplateSingleSong(tpl, songA);
  if (!rA.ok) return { ok: false, reason: '曲目1[' + songA.name + ']失败: ' + rA.reason };

  const rB = await verifyTemplateSingleSong(tpl, songB);
  if (!rB.ok) return { ok: false, reason: '曲目2[' + songB.name + ']失败: ' + rB.reason };

  // 双曲差分检测：两首完全不同的歌若返回完全相同的体积与 CDN 路径，判定为固定硬编码假接口
  if (rA.totalBytes > 0 && rA.totalBytes === rB.totalBytes && rA.cdnPath === rB.cdnPath) {
    return { ok: false, reason: '双曲差分拦截：不同歌曲 ID 返回完全相同的静态音频 (' + rA.totalBytes + 'B)' };
  }

  return {
    ok: true,
    sampleLatencyMs: Math.round((rA.sampleLatencyMs + rB.sampleLatencyMs) / 2)
  };
}

/**
 * 动态 Header 可省略性探测：剥离可能含时间戳的 X-Token / X-Client 等非标准头后，若双曲依然全通，则剔除隐患头。
 */
async function tryStripEphemeralHeaders(tpl, songA, songB) {
  const hdrs = tpl.headers || {};
  const extraKeys = Object.keys(hdrs).filter(function (k) { return !STANDARD_HEADERS.has(k.toLowerCase()); });
  if (!extraKeys.length) return tpl;

  const minimalHeaders = {};
  for (const k of Object.keys(hdrs)) {
    if (STANDARD_HEADERS.has(k.toLowerCase())) minimalHeaders[k] = hdrs[k];
  }
  const strippedTpl = Object.assign({}, tpl, { headers: minimalHeaders });
  const test = await verifyTemplateDualSong(strippedTpl, songA, songB);
  if (test.ok) {
    return Object.assign({}, strippedTpl, { strippedExtraHeaders: extraKeys });
  }
  return tpl;
}

module.exports = {
  MIN_VALID_BYTES,
  looksAudio,
  extractByPath,
  isTitleCompatible,
  verifyAudioStream,
  verifyTemplateWithSecondSong: verifyTemplateSingleSong,
  verifyTemplateDualSong,
  tryStripEphemeralHeaders
};
