'use strict';
// yy-lx-hub 高能效 VM 沙箱：
// 1. 严格单平台串行派发（消除并发竞态，确保嗅探流量 100% 归属当前平台）；
// 2. 修复原生 fetch Headers 兼容性与单请求超时控制；
// 3. 事件驱动回调替代 60ms 盲轮询，零无效 CPU 消耗；
// 4. 对齐 Amusic 的 1.2MB + 音频魔数双门禁，并内置 Sniffer 因果提取。

const vm = require('vm');
const os = require('os');
const nodeCrypto = require('crypto');
const nodeZlib = require('zlib');
const path = require('path');
const { spawn } = require('child_process');
const netguard = require('./netguard');
const sniffer = require('./sniffer');
const templatizer = require('./templatizer');
const verifier = require('./verifier');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 yy-lx-hub/2.0';
const PLATFORMS = ['wy', 'tx', 'kw', 'kg', 'mg'];

// 五大平台全量多曲目基准池（全字段补齐 + 实测存活验证）：
// 防止单一曲目下架/版权收紧或字段命名差异导致整批正常脚本被误杀；
// [0] 为首选测试曲目，失败时自动降级试探 [1]，[1]/[2] 也供脱离沙箱的第二曲目验真交叉使用。
const TEST_SONGS = {
  wy: [
    { name: '海阔天空', info: { name: '海阔天空', singer: 'Beyond', artist: 'Beyond', songmid: '347230', id: '347230', rid: '347230', albumName: '乐与怒', interval: '05:26' } },
    { name: '孤勇者', info: { name: '孤勇者', singer: '陈奕迅', artist: '陈奕迅', songmid: '1901371647', id: '1901371647', rid: '1901371647', albumName: '英雄联盟双城之战', interval: '04:16' } },
    { name: '有可能的夜晚', info: { name: '有可能的夜晚', singer: '曾轶可', artist: '曾轶可', songmid: '26217171', id: '26217171', rid: '26217171', albumName: '会飞的贼', interval: '04:40' } }
  ],
  tx: [
    { name: '晴天', info: { name: '晴天', singer: '周杰伦', artist: '周杰伦', songmid: '0039MnYb0qxYhV', id: '0039MnYb0qxYhV', strMediaMid: '0039MnYb0qxYhV', albumName: '叶惠美', interval: '04:29' } },
    { name: '告白气球', info: { name: '告白气球', singer: '周杰伦', artist: '周杰伦', songmid: '003OUlho2HcRHC', id: '003OUlho2HcRHC', strMediaMid: '003OUlho2HcRHC', albumName: '周杰伦的床边故事', interval: '03:35' } },
    { name: '七里香', info: { name: '七里香', singer: '周杰伦', artist: '周杰伦', songmid: '004Z8Ihr0JIu5s', id: '004Z8Ihr0JIu5s', strMediaMid: '004Z8Ihr0JIu5s', albumName: '七里香(专辑)', interval: '04:59' } }
  ],
  kw: [
    { name: '晴天', info: { name: '晴天', singer: '周杰伦', artist: '周杰伦', songmid: '228908', id: '228908', rid: '228908', albumName: '叶惠美', interval: '04:29' } },
    { name: '海阔天空', info: { name: '海阔天空', singer: 'Beyond', artist: 'Beyond', songmid: '5886682', id: '5886682', rid: '5886682', albumName: '乐与怒', interval: '05:26' } },
    { name: '七里香', info: { name: '七里香', singer: '周杰伦', artist: '周杰伦', songmid: '94237', id: '94237', rid: '94237', albumName: '七里香(专辑)', interval: '04:59' } }
  ],
  kg: [
    { name: '海阔天空', info: { name: '海阔天空', singer: 'Beyond', artist: 'Beyond', hash: '596E403326AFD24A38E95A5225E1A139', songmid: '596E403326AFD24A38E95A5225E1A139', id: '596E403326AFD24A38E95A5225E1A139', albumName: '乐与怒', interval: '05:26' } },
    { name: '后来', info: { name: '后来', singer: '刘若英', artist: '刘若英', hash: 'b02c037cbcf0f8e4ad066acd8b1defa2', songmid: 'b02c037cbcf0f8e4ad066acd8b1defa2', id: 'b02c037cbcf0f8e4ad066acd8b1defa2', albumName: '脱掉高跟鞋', interval: '04:55' } },
    { name: '孤勇者 (DJ版)', info: { name: '孤勇者', singer: '陈奕迅', artist: '陈奕迅', hash: '36d566371747907e7c99d2f119b99347', songmid: '36d566371747907e7c99d2f119b99347', id: '36d566371747907e7c99d2f119b99347', albumName: '英雄联盟双城之战', interval: '04:16' } }
  ],
  mg: [
    { name: '晴天', info: { name: '晴天', singer: '周杰伦', artist: '周杰伦', copyrightId: '69984639', songmid: '69984639', id: '69984639', albumName: '叶惠美', interval: '04:29' } },
    { name: '海阔天空', info: { name: '海阔天空', singer: 'Beyond', artist: 'Beyond', copyrightId: '6005752DXKE', songmid: '6005752DXKE', id: '6005752DXKE', albumName: '乐与怒', interval: '05:26' } },
    { name: '告白气球 (Live)', info: { name: '告白气球', singer: '周杰伦', artist: '周杰伦', copyrightId: '60054704113', songmid: '60054704113', id: '60054704113', albumName: '地表最强', interval: '03:35' } }
  ]
};

const STEP_TIMEOUT = 6500;
const DISPATCH_TIMEOUT = 6500;

const BOOTSTRAP = [
  "'use strict';",
  'var _eventHandlers = new Map();',
  'var _registeredSources = {};',
  'globalThis.lx = {',
  "  version: '2.0.0', env: 'desktop', platform: 'web',",
  '  currentScriptInfo: { name: "", description: "", version: "", author: "", homepage: "", rawScript: "" },',
  '  EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },',
  '  utils: {',
  '    buffer: {',
  '      from: function(d, e) { return Buffer.from(d, e); },',
  '      bufToString: function(b, f) { return (b !== null && typeof b === "object" && typeof b.toString === "function") ? b.toString(f || "utf8") : Buffer.from(b, "binary").toString(f || "utf8"); }',
  '    },',
  '    crypto: {',
  "      md5: function(s) { return crypto.md5(s || ''); },",
  '      aesEncrypt: function(b, m, k, iv) { return crypto.aesEncrypt(b, m, k, iv); },',
  '      rsaEncrypt: function(b, k) { return crypto.rsaEncrypt(b, k); },',
  '      randomBytes: function(n) { return crypto.randomBytes(n); }',
  '    },',
  '    zlib: {',
  '      inflate: function(b) { return zlib.inflate(b); },',
  '      deflate: function(b) { return zlib.deflate(b); }',
  '    }',
  '  },',
  '  request: function(url, options, callback) {',
  '    if (typeof options === "function") { callback = options; options = {}; }',
  '    options = options || {};',
  '    var method = (options.method || "GET").toUpperCase();',
  '    var headers = Object.assign({}, options.headers || {});',
  '    var bodyContent = options.body || null;',
  '    if (options.form) {',
  '      bodyContent = options.form;',
  '      if (typeof bodyContent === "object") {',
  '        var parts = [];',
  '        for (var k in bodyContent) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(bodyContent[k]));',
  '        bodyContent = parts.join("&");',
  '        if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/x-www-form-urlencoded";',
  '      }',
  '    }',
  "    if (bodyContent !== null && typeof bodyContent === 'object' && !Buffer.isBuffer(bodyContent) && !(bodyContent instanceof Uint8Array)) {",
  '      bodyContent = JSON.stringify(bodyContent);',
  '      if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";',
  '    }',
  '    var aborted = false, called = false;',
  '    function safe(err, resp, body) {',
  '      if (aborted || called) return; called = true;',
  '      if (typeof callback === "function") { try { callback(err, resp, body); } catch (e) {} }',
  '    }',
  '    fetch(url, { method: method, headers: headers, body: bodyContent, timeout: options.timeout || 6500 }).then(function(resp) {',
  '      if (aborted) return;',
  '      return resp.text().then(function(text) {',
  '        if (aborted) return;',
  '        var body = text; try { body = JSON.parse(text); } catch (_) {}',
  '        safe(null, { statusCode: resp.status, statusMessage: resp.statusText || "", headers: resp.headers || {}, body: body }, body);',
  '      });',
  '    }).catch(function(err) {',
  '      if (aborted) return;',
  '      safe(new Error((err && err.message) ? err.message : String(err)), null, null);',
  '    });',
  '    return function() { aborted = true; };',
  '  },',
  '  send: function(eventName, data) {',
  '    if (eventName === "inited" && data && data.sources) _registeredSources = data.sources;',
  '    if (typeof __hostSend === "function") { try { __hostSend(eventName, JSON.stringify(data)); } catch (e) {} }',
  '  },',
  '  on: function(eventName, handler) { _eventHandlers.set(eventName, handler); },',
  '  _dispatch: function(requestId, eventName, data) {',
  '    var handler = _eventHandlers.get(eventName);',
  '    if (typeof handler !== "function") {',
  '      if (typeof __hostSend === "function") __hostSend("dispatchError", JSON.stringify({ id: requestId, error: "No handler registered for event: " + eventName }));',
  '      return;',
  '    }',
  '    var settled = false;',
  '    function sendResult(v) { if (settled) return; settled = true; if (typeof __hostSend === "function") __hostSend("dispatchResult", JSON.stringify({ id: requestId, result: v })); }',
  '    function sendError(e) { if (settled) return; settled = true; if (typeof __hostSend === "function") __hostSend("dispatchError", JSON.stringify({ id: requestId, error: (e && e.message) ? e.message : String(e) })); }',
  '    try {',
  '      var result = handler(data);',
  '      if (result && typeof result.then === "function") {',
  '        var t = setTimeout(function() { sendError(new Error("dispatch timeout")); }, ' + DISPATCH_TIMEOUT + ');',
  '        result.then(function(v) { clearTimeout(t); sendResult(v); }, function(e) { clearTimeout(t); sendError(e); });',
  '      } else sendResult(result);',
  '    } catch (err) { sendError(err); }',
  '  },',
  '  _getSources: function() { return _registeredSources; }',
  '};',
  'globalThis.window = globalThis;',
  'globalThis.global = globalThis;'
].join('\n');

const hostCrypto = {
  md5(s) {
    const data = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
    return nodeCrypto.createHash('md5').update(data).digest('hex');
  },
  aesEncrypt(data, mode, key, iv) {
    const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
    const i = (iv == null || /ecb/i.test(String(mode))) ? null : (Buffer.isBuffer(iv) ? iv : Buffer.from(String(iv), 'utf8'));
    const d = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const c = nodeCrypto.createCipheriv(String(mode).toLowerCase(), k, i);
    return Buffer.concat([c.update(d), c.final()]);
  },
  rsaEncrypt(data, key) {
    let pk = String(key).trim();
    if (pk.indexOf('-----BEGIN') < 0) pk = '-----BEGIN PUBLIC KEY-----\n' + pk.replace(/(.{64})/g, '$1\n').trim() + '\n-----END PUBLIC KEY-----';
    const d = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return nodeCrypto.publicEncrypt({ key: pk, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, d);
  },
  randomBytes(n) { return nodeCrypto.randomBytes(n); }
};

const hostZlib = {
  inflate(b) { return nodeZlib.inflateSync(Buffer.isBuffer(b) ? b : Buffer.from(b)); },
  deflate(b) { return nodeZlib.deflateSync(Buffer.isBuffer(b) ? b : Buffer.from(b)); }
};

function asciiHead(bytes, n) {
  let s = '';
  for (let i = 0; i < Math.min(bytes.length, n); i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function parseFlacSpec(b) {
  if (asciiHead(b, 4) !== 'fLaC') return null;
  const spec = { container: 'flac' };
  if (b.length < 26) return spec;
  const type = b[4] & 0x7f;
  const o = 8;
  if (type === 0) {
    spec.sampleRate = (b[o + 10] << 12) | (b[o + 11] << 4) | (b[o + 12] >>> 4);
    spec.channels = ((b[o + 12] >>> 1) & 0x07) + 1;
    spec.bitDepth = (((b[o + 12] & 0x01) << 4) | (b[o + 13] >>> 4)) + 1;
  }
  return spec;
}

function parseMp3Spec(b) {
  let at = 0;
  if (asciiHead(b, 3) === 'ID3' && b.length > 10) {
    const sz = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    at = 10 + sz + ((b[5] & 0x10) !== 0 ? 10 : 0);
  }
  const limit = Math.min(b.length, at + 4096);
  const RATES_V1 = [44100, 48000, 32000], RATES_V2 = [22050, 24000, 16000];
  const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  while (at < limit - 4) {
    if (b[at] === 0xff && (b[at + 1] & 0xe0) === 0xe0) {
      const verBits = (b[at + 1] >>> 3) & 0x03;
      const v1 = verBits === 3;
      return {
        container: 'mp3',
        bitrate: (v1 ? BR_V1 : BR_V2)[(b[at + 2] >>> 4) & 0x0f] || 0,
        sampleRate: (v1 ? RATES_V1 : RATES_V2)[(b[at + 2] >>> 2) & 0x03] || 0
      };
    }
    at++;
  }
  return { container: 'mp3' };
}

function parseAudioSpec(bytes) {
  const b = bytes.subarray ? bytes.subarray(0, Math.min(bytes.length, 4096)) : bytes;
  const h4 = asciiHead(b, 4);
  if (h4 === 'fLaC') return parseFlacSpec(bytes);
  if (h4 === 'OggS') return { container: 'ogg' };
  if (h4 === 'RIFF') return { container: 'wav' };
  if (asciiHead(b.slice(4, 8), 4) === 'ftyp') return { container: 'mp4' };
  if (asciiHead(b, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return parseMp3Spec(bytes);
  return null;
}

function losslessVerdict(spec) {
  if (!spec) return 'unknown';
  if (spec.container === 'flac') {
    if (spec.bitDepth === 24 || spec.bitDepth === 32) return 'matched';
    if (spec.bitDepth === 16) return 'degraded';
    return 'unknown';
  }
  if (spec.container === 'mp3' || spec.container === 'mp4') return 'mismatch';
  return 'unknown';
}

async function verifyUrl(url) {
  const v = await verifier.verifyAudioStream(url, { ua: UA });
  if (!v.ok) return { ok: false, reason: v.reason };
  let spec = null;
  try { spec = parseAudioSpec(v.headBytes); } catch (e) { /* noop */ }
  if (spec) spec.bytes = v.totalBytes || v.headBytes.length;
  return { ok: true, size: v.headBytes.length, totalBytes: v.totalBytes, spec: spec, finalUrl: v.finalUrl };
}

function headersToPlainObject(h) {
  const obj = {};
  if (!h) return obj;
  if (typeof h.forEach === 'function') {
    h.forEach(function (val, key) {
      obj[String(key).toLowerCase()] = val;
    });
    if (typeof h.getSetCookie === 'function') {
      const sc = h.getSetCookie();
      if (sc && sc.length) obj['set-cookie'] = sc;
    }
  } else if (typeof h === 'object') {
    for (const k of Object.keys(h)) obj[k.toLowerCase()] = h[k];
  }
  return obj;
}

/**
 * 深检主流程：加载脚本 -> 严格单平台串行取链与嗅探 -> 1.2MB+魔数门禁 -> L2无损核验
 */
async function deepCheck(code, scriptName) {
  const result = {
    checkedAt: Date.now(),
    loadable: false,
    loadError: null,
    inited: false,
    platforms: {},
    extractedCandidates: [],
    updateAlert: null
  };

  const events = [];
  const hostCache = new Map();
  let activeTraces = null;

  // 事件驱动异步通知表：彻底告别 60ms 轮询
  let initedWaiter = null;
  const dispatchWaiters = new Map();

  function onHostSend(name, dataJson) {
    events.push({ name: name, data: dataJson });
    if (name === 'inited' && initedWaiter) {
      const w = initedWaiter;
      initedWaiter = null;
      w();
      return;
    }
    if (name === 'dispatchResult' || name === 'dispatchError') {
      try {
        const parsed = JSON.parse(dataJson);
        const w = dispatchWaiters.get(parsed.id);
        if (w) {
          dispatchWaiters.delete(parsed.id);
          w({ name: name, data: parsed });
        }
      } catch (e) { /* noop */ }
    }
  }

  const ctx = vm.createContext({
    Buffer: Buffer,
    URL: URL,
    URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    atob: typeof atob === 'function' ? atob : function (s) { return Buffer.from(String(s), 'base64').toString('binary'); },
    btoa: typeof btoa === 'function' ? btoa : function (s) { return Buffer.from(String(s), 'binary').toString('base64'); },
    crypto: hostCrypto,
    zlib: hostZlib,
    fetch: async function (url, opts) {
      opts = opts || {};
      const reqHeaders = Object.assign({}, opts.headers || {});
      const hasUa = Object.keys(reqHeaders).some(function (k) { return k.toLowerCase() === 'user-agent'; });
      if (!hasUa) reqHeaders['User-Agent'] = UA;
      const t0 = Date.now();
      const res = await netguard.safeFetch(url, {
        method: opts.method || 'GET',
        headers: reqHeaders,
        body: opts.body,
        timeout: opts.timeout || 8000,
        hostCache: hostCache
      });
      const latencyMs = Date.now() - t0;
      const plainHeaders = headersToPlainObject(res.headers);
      Object.defineProperty(plainHeaders, 'get', {
        value: function (k) { const v = this[String(k || '').toLowerCase()]; return v == null ? null : v; },
        enumerable: false
      });
      const ct = String(plainHeaders['content-type'] || '');

      let cachedText = null;
      if (!/audio|video|octet-stream/i.test(ct)) {
        try {
          cachedText = await res.text();
        } catch (e) {
          cachedText = '';
        }
      } else {
        if (res.body && typeof res.body.cancel === 'function') {
          try { await res.body.cancel(); } catch (e) { /* noop */ }
        }
        cachedText = '';
      }

      // 若正在某单平台串行嗅探窗口内，完整记录此物理网络请求供因果判定
      if (activeTraces) {
        let parsedJson = null;
        if (cachedText && cachedText.length < 256000) {
          try { parsedJson = JSON.parse(cachedText); } catch (e) { /* noop */ }
        }
        activeTraces.push({
          method: (opts.method || 'GET').toUpperCase(),
          url: String(url),
          headers: reqHeaders,
          body: opts.body,
          status: res.status,
          finalUrl: res._finalUrl || String(url),
          redirectChain: res._redirectChain || [],
          respHeaders: plainHeaders,
          respText: cachedText && cachedText.length < 65536 ? cachedText : '',
          respBody: parsedJson,
          latencyMs: latencyMs
        });
      }

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText || '',
        headers: plainHeaders,
        text: async function () { return cachedText || ''; },
        json: async function () { return JSON.parse(cachedText || '{}'); }
      };
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: function (fn, ms) { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; },
    clearInterval: clearInterval,
    console: { log: function () {}, warn: function () {}, error: function () {}, info: function () {} },
    __events: events,
    __hostSend: onHostSend
  });

  function waitForInited(scriptCode, ms) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        initedWaiter = null;
        reject(new Error('inited 等待超时(' + ms + 'ms)'));
      }, ms);
      if (timer.unref) timer.unref();
      initedWaiter = function () { clearTimeout(timer); resolve(); };
      try {
        vm.runInContext(scriptCode, ctx, { timeout: 3000, displayErrors: true });
      } catch (e) {
        clearTimeout(timer);
        initedWaiter = null;
        reject(new Error(String(e && e.message || e).slice(0, 200)));
      }
    });
  }

  function dispatchAndWait(reqId, payload, ms) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        dispatchWaiters.delete(reqId);
        resolve({ timeout: true });
      }, ms);
      if (timer.unref) timer.unref();
      dispatchWaiters.set(reqId, function (ev) {
        clearTimeout(timer);
        resolve(ev);
      });
      const dispatchCode = 'lx._dispatch(' + JSON.stringify(reqId) + ', "request", ' + JSON.stringify(payload) + ');';
      try {
        vm.runInContext(dispatchCode, ctx, { timeout: 3000 });
      } catch (e) {
        clearTimeout(timer);
        dispatchWaiters.delete(reqId);
        resolve({ name: 'dispatchError', data: { error: String(e && e.message || e) } });
      }
    });
  }

  try {
    vm.runInContext(BOOTSTRAP, ctx, { timeout: 3000 });
    const infoCode = 'globalThis.lx.currentScriptInfo = ' + JSON.stringify({
      name: scriptName || '', description: '', version: '', author: '', homepage: '', rawScript: String(code).slice(0, 400000)
    }) + ';';
    vm.runInContext(infoCode, ctx, { timeout: 3000 });

    await waitForInited(String(code), STEP_TIMEOUT);
    result.loadable = true;
    result.inited = true;

    const deadline = Date.now() + 60000;

    // 严格串行派发各平台（支持多曲目自动容灾兜底，100% 保证流量归属无污染）
    for (const src of PLATFORMS) {
      if (Date.now() > deadline) {
        result.platforms[src] = { status: 'skipped', message: '深检总预算已满，提前保留已完成结果' };
        continue;
      }
      const songs = TEST_SONGS[src] || [];
      if (!songs.length) {
        result.platforms[src] = { status: 'skipped', message: '无测试歌曲' };
        continue;
      }
      let lastFail = null;
      let passedSong = null;
      const tryLimit = Math.min(2, songs.length);
      for (let sIdx = 0; sIdx < tryLimit; sIdx++) {
        const song = songs[sIdx];
        const reqId = 'hq_' + src + '_' + sIdx + '_' + Date.now();
        const payload = { source: src, action: 'musicUrl', info: { type: '320k', musicInfo: song.info } };

        activeTraces = [];
        const ev = await dispatchAndWait(reqId, payload, STEP_TIMEOUT);
        const traces = activeTraces;
        activeTraces = null;

        if (ev.timeout) {
          lastFail = { status: 'failed', message: '响应超时' };
          break; // 网络超时说明该平台整体慢/不通，不再重复试第2首浪费时间
        }
        if (ev.name === 'dispatchError') {
          const errMsg = String((ev.data && ev.data.error) || '脚本失败').slice(0, 80);
          lastFail = { status: 'failed', message: errMsg };
          if (/timeout|超时|不支持|停止服务|升级|disabled/i.test(errMsg)) break;
          continue;
        }

        const ret = ev.data && ev.data.result;
        if (typeof ret === 'string' && ret.indexOf('http') === 0) {
          const v = await verifyUrl(ret);
          if (v.ok) {
            passedSong = { song: song, idx: sIdx };
            result.platforms[src] = { status: 'usable', message: '测试歌曲「' + song.name + '」通过 1.2MB+魔数门禁', usedSongIdx: sIdx };
            const causal = sniffer.findCausalRequest(traces, ret);
            if (causal) {
              const metaFields = (causal.type === 'json' && causal.trace && causal.trace.respBody)
                ? sniffer.findMetaFields(causal.trace.respBody, song.info)
                : null;
              const tpl = templatizer.buildTemplate({
                platform: src,
                song: song,
                quality: '320k',
                causal: causal,
                scriptName: scriptName || '',
                metaFields: metaFields
              });
              if (tpl) {
                tpl.usedSongIdx = sIdx;
                result.extractedCandidates.push(tpl);
              }
            }
            break;
          } else {
            lastFail = { status: 'failed', message: '门禁拦截: ' + v.reason };
          }
        } else {
          lastFail = { status: 'failed', message: ret == null || ret === '' ? '返回空链接' : '返回异常: ' + String(ret).slice(0, 60) };
        }
      }
      if (!passedSong && lastFail) {
        result.platforms[src] = lastFail;
      }
    }

    // L2 无损核验（对已确认可用的平台检查一次 flac24bit）
    for (const src of PLATFORMS) {
      if (Date.now() > deadline) break;
      const pe = result.platforms[src];
      if (!pe || pe.status !== 'usable') continue;
      const songs = TEST_SONGS[src] || [];
      const song = songs[pe.usedSongIdx || 0] || songs[0];
      if (!song) continue;
      const reqId = 'l2_' + src + '_' + Date.now();
      const payload = { source: src, action: 'musicUrl', info: { type: 'flac24bit', musicInfo: song.info } };
      const ev = await dispatchAndWait(reqId, payload, STEP_TIMEOUT);
      if (ev.timeout) { pe.lossless = 'refused'; pe.losslessReason = '响应超时'; continue; }
      if (ev.name === 'dispatchError') { pe.lossless = 'refused'; pe.losslessReason = String((ev.data && ev.data.error) || '脚本失败').slice(0, 60); continue; }
      const ret = ev.data && ev.data.result;
      if (!(typeof ret === 'string' && ret.indexOf('http') === 0)) { pe.lossless = 'refused'; pe.losslessReason = '未返回有效链接'; continue; }
      const v = await verifyUrl(ret);
      if (!v.ok) { pe.lossless = 'refused'; pe.losslessReason = v.reason; continue; }
      pe.lossless = losslessVerdict(v.spec);
      if (v.spec) {
        pe.losslessSpec = {
          container: v.spec.container || '',
          bitDepth: v.spec.bitDepth || 0,
          sampleRate: v.spec.sampleRate || 0,
          bytes: v.spec.bytes || 0
        };
      }
    }

    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].name === 'updateAlert') {
        try { result.updateAlert = (JSON.parse(events[i].data) || '').toString().slice(0, 200); }
        catch (e) { result.updateAlert = String(events[i].data).slice(0, 200); }
        break;
      }
    }
  } catch (e) {
    result.loadError = String((e && e.message) || e).slice(0, 200);
  }
  return result;
}

function anyUsable(platforms) {
  for (const p in platforms) if (platforms[p] && platforms[p].status === 'usable') return true;
  return false;
}

const WORKER_TIMEOUT = 90 * 1000;

function deepCheckSafe(code, scriptName) {
  return new Promise(function (resolve) {
    const fallback = { checkedAt: Date.now(), loadable: false, loadError: '深检进程异常', inited: false, platforms: {}, extractedCandidates: [] };
    let child;
    try {
      child = spawn(process.execPath, [path.join(__dirname, 'sandbox-worker.js')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH || '', NODE_ENV: 'production' }
      });
    } catch (e) { resolve(fallback); return; }
    let out = '', done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
      resolve({ checkedAt: Date.now(), loadable: false, loadError: '深检超时(' + (WORKER_TIMEOUT / 1000) + 's)', inited: false, platforms: {}, extractedCandidates: [] });
    }, WORKER_TIMEOUT);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (d) { out += d; });
    child.on('error', function () { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } });
    child.on('close', function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const r = JSON.parse(out);
        resolve(r && r.checkedAt ? r : fallback);
      } catch (e) { resolve(fallback); }
    });
    child.stdin.write(JSON.stringify({ code: String(code), name: scriptName || '' }));
    child.stdin.end();
  });
}

module.exports = { deepCheck, deepCheckSafe, anyUsable, PLATFORMS, TEST_SONGS, verifyUrl, parseAudioSpec, losslessVerdict };
