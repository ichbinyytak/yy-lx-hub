'use strict';
// yy-lx-hub 核心调度引擎：唯新不破动态雷达 / 仓库安检门 / README+Releases+ZIP拆包 / 并发抓取 / 沙箱深检 / API萃取

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const store = require('./store');
const sandbox = require('./sandbox');
const radar = require('./radar');
const extractor = require('./extractor');
const pusher = require('./pusher');
const zipUtil = require('./zip');

const PLATFORM_MAP = [
  { key: 'wy', re: /['"]wy['"]|网易云|netease|163\.com/i, label: '网易云' },
  { key: 'tx', re: /['"]tx['"]|qq ?音乐|\bqq\b|u\.y\.qq\.com|qq\.com/i, label: 'QQ' },
  { key: 'kw', re: /['"]kw['"]|酷我|kuwo\.cn/i, label: '酷我' },
  { key: 'kg', re: /['"]kg['"]|酷狗|kugou\.com/i, label: '酷狗' },
  { key: 'mg', re: /['"]mg['"]|咪咕|migu/i, label: '咪咕' }
];

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 yy-lx-hub/2.0';
const NON_BACKEND_HOSTS = /raw\.githubusercontent\.com|github\.com|gist\.githubusercontent\.com|objects\.githubusercontent\.com|jsdelivr\.net|ghproxy|gh-proxy|ghps\.cc|ghfast\.top|cloudflare\.com|workers\.dev$/i;

const STALE_REPO_DAYS = 60;
const MAX_REPOS_PER_RUN = 25;

// 明显的非音源工程文件黑名单（下载前直接踢除）
const JUNK_FILE_RE = /(?:^|\/)(?:package(?:-lock)?|tsconfig|jsconfig|composer|manifest|settings|.*config)\.(?:json|js)$|(?:^|\/)(?:\.eslintrc|\.prettierrc|babel|webpack|vite|rollup|jest|tailwind|postcss)|(?:^|\/)(?:node_modules|dist|build|\.github|assets|public|static|docs|scripts|tools|test|tests|__tests__)\/|\.min\.js$/i;

// 仓库安检门：若目录包含典型大型软件工程清单且无根级音源特征，则判定为客户端软件而非音源仓
const APP_REPO_MARKER_RE = /(?:^|\/)(?:AndroidManifest\.xml|build\.gradle(?:\.kts)?|Cargo\.toml|go\.mod|pom\.xml|tauri\.conf\.json|pyproject\.toml|vite\.config\.\w+|next\.config\.\w+|vue\.config\.js)$/i;

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function encodeRepoPath(p) {
  return String(p || '').split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
}

async function runPool(items, concurrency, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      if (task.cancel) break;
      const idx = cursor++;
      await fn(items[idx], idx);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  const list = [];
  for (let i = 0; i < n; i++) list.push(worker());
  await Promise.all(list);
}

function fetchText(url, opts) {
  opts = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 8000);
  const headers = { 'user-agent': opts.ua || DEFAULT_UA, 'accept': '*/*' };
  if (opts.headers) Object.assign(headers, opts.headers);
  return fetch(url, { signal: ctl.signal, headers: headers, redirect: 'follow' })
    .then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        return { ok: res.ok, status: res.status, text: text };
      });
    })
    .catch(function (e) {
      clearTimeout(timer);
      return { ok: false, status: 0, error: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'fetch error' };
    });
}

function fetchBuffer(url, opts) {
  opts = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 12000);
  const headers = { 'user-agent': opts.ua || DEFAULT_UA, 'accept': '*/*' };
  if (opts.headers) Object.assign(headers, opts.headers);
  return fetch(url, { signal: ctl.signal, headers: headers, redirect: 'follow' })
    .then(function (res) {
      return res.arrayBuffer().then(function (ab) {
        clearTimeout(timer);
        return { ok: res.ok, status: res.status, buf: Buffer.from(ab) };
      });
    })
    .catch(function (e) {
      clearTimeout(timer);
      return { ok: false, status: 0, error: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'fetch error' };
    });
}

const MIRROR_PRESETS = ['https://proxy.vvvv.ee', 'https://ghproxy.net', 'https://gh-proxy.com', 'https://ghfast.top', 'https://gh1.lhl.one'];
const JSD_HOST = 'https://jsdelivr.b-cdn.net';

function normMirrorBase(s) {
  const b = String(s == null ? '' : s).trim().replace(/\/+$/, '');
  if (!b) return '';
  return /^https?:\/\//i.test(b) ? b : 'https://' + b;
}

function mirrorUrlFor(mbase, rawUrl) {
  const base = normMirrorBase(mbase);
  return base ? base + '/' + rawUrl : null;
}

function jsdelivrUrlFor(rawUrl) {
  const rest = String(rawUrl).slice('https://raw.githubusercontent.com/'.length);
  const m = rest.match(/^([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? JSD_HOST + '/gh/' + m[1] + '/' + m[2] + '@' + m[3] + '/' + m[4] : null;
}

function buildCandidates(url, cfg) {
  cfg = cfg || {};
  const proxy = cfg.proxy || '';
  const out = [];
  let mirror = null, jsd = null;
  if (url.indexOf('https://raw.githubusercontent.com/') === 0) {
    if (cfg.ghMirror) mirror = mirrorUrlFor(cfg.ghMirror, url);
    if (cfg.useJsdelivr) jsd = jsdelivrUrlFor(url);
  }
  const force = !!(cfg.forceProxy && proxy);
  function add(u, useProxy) { if (u) out.push({ url: u, useProxy: useProxy }); }
  if (force) { add(url, true); add(url, false); }
  else { add(url, false); if (proxy) add(url, true); }
  add(mirror, false);
  add(jsd, false);
  return out.length ? out : [{ url: url, useProxy: false }];
}

function proxyTunnelFetch(targetUrl, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    let proxy;
    try { proxy = new URL(opts.proxy); } catch (e) { return resolve({ ok: false, status: 0, error: '代理地址无效' }); }
    const target = new URL(targetUrl);
    const isHttps = target.protocol === 'https:';
    const port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
    const done = function (r) { clearTimeout(timer); resolve(r); };
    const timer = setTimeout(function () { done({ ok: false, status: 0, error: 'timeout' }); }, opts.timeout || 8000);
    const connectReq = http.request({
      host: proxy.hostname, port: Number(port),
      method: 'CONNECT', path: target.hostname + ':' + (target.port || (isHttps ? 443 : 80)),
      headers: { 'user-agent': opts.ua || DEFAULT_UA }
    });
    connectReq.on('connect', function (res, socket) {
      if (res.statusCode !== 200) {
        socket.destroy();
        return done({ ok: false, status: 0, error: '代理 CONNECT 失败 HTTP ' + res.statusCode });
      }
      const reqOpts = {
        host: target.hostname, port: target.port || (isHttps ? 443 : 80), path: target.pathname + target.search,
        method: 'GET', headers: Object.assign({ 'user-agent': opts.ua || DEFAULT_UA, accept: '*/*' }, opts.headers || {}),
        createConnection: function () { return isHttps ? require('tls').connect({ socket: socket, servername: target.hostname }) : socket; }
      };
      const lib = isHttps ? https : http;
      const req = lib.request(reqOpts, function (resp) {
        let body = '';
        resp.setEncoding('utf8');
        resp.on('data', function (c) { if (body.length < 2e6) body += c; });
        resp.on('end', function () { done({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode, text: body }); });
      });
      req.on('error', function (e) { done({ ok: false, status: 0, error: e.message }); });
      req.end();
    });
    connectReq.on('error', function (e) { done({ ok: false, status: 0, error: '代理连接失败: ' + e.message }); });
    connectReq.end();
  });
}

async function crawlFetch(url, opts) {
  opts = opts || {};
  const cfg = opts.cfg || {};
  const cands = buildCandidates(url, cfg);
  let lastErr = null;
  for (const c of cands) {
    if (opts.cancelled && opts.cancelled()) return { ok: false, status: 0, error: 'cancelled' };
    const r = c.useProxy
      ? await proxyTunnelFetch(c.url, { proxy: cfg.proxy, ua: opts.ua, timeout: opts.timeout, headers: opts.headers })
      : await fetchText(c.url, { ua: opts.ua, timeout: opts.timeout, headers: opts.headers });
    if (r.ok) return r;
    lastErr = r;
  }
  return lastErr || { ok: false, status: 0, error: 'no candidates' };
}

function accelRewrite(url, prefix) {
  if (!prefix || !url) return url;
  const p = String(prefix).trim().replace(/\/+$/, '');
  if (!p) return url;
  if (!/^https?:\/\//i.test(p)) return 'https://' + p + '/' + url;
  return p + '/' + url;
}

function detectPlatforms(text) {
  const out = [];
  for (const p of PLATFORM_MAP) if (p.re.test(text)) out.push(p.label);
  return out.slice(0, 5);
}

function isNonSourceCode(text) {
  // 真正的洛雪音源脚本运行在极简沙箱中，绝不可能使用 ES Module import/export 或 Node require()
  const head = String(text || '').slice(0, 8000);
  if (/^\s*(?:import\s+[\s\S]{1,120}?\s+from\s+['"]|export\s+(?:default|const|function|let|var|class)\b)/m.test(head)) return true;
  if (/\brequire\s*\(\s*['"][^'"]{1,60}['"]\s*\)/.test(head)) return true;
  return false;
}

function isSourceScript(text) {
  if (isNonSourceCode(text)) return false;
  return /MUSIC_SOURCE|EVENT_NAMES|globalThis\.lx|lx\s*:\s*\{|on\(\s*['"]request['"]|支持平台|音源/.test(text);
}

function isObfuscated(text) {
  const head = String(text || '').slice(0, 20000);
  const ids = head.match(/\b_0x[a-f0-9]{4,}\b/g);
  if (ids && ids.length >= 10) return true;
  const esc = head.match(/(?:\\x[0-9a-fA-F]{2}){6,}/g);
  return !!(esc && esc.length >= 3);
}

const GENERIC_FILENAMES = /^(index|main|app|utils|config|setup)$/i;
const NAME_SAMPLE_HINT = /测试|示例|样例|演示|试用|废弃|弃用|失效|过期|demo|test|sample|example|mock|fake|dummy|练手/i;

function extractMeta(text, fallbackName) {
  const cut = text.slice(0, 8000);
  function pick(re) {
    const m = cut.match(re);
    return m ? m[1].trim().slice(0, 60) : '';
  }
  const name = pick(/@name\s+([^\r\n]{1,60})/) ||
    pick(/['"]?name['"]?\s*[:=]\s*['"]([^'"]{1,50})['"]/) || fallbackName || '';
  const version = pick(/@version\s+([^\r\n]{1,30})/) ||
    pick(/['"]?version['"]?\s*[:=]\s*['"]([\w.\-]{1,20})['"]/) || '';
  const author = pick(/@author\s+([^\r\n]{1,50})/) ||
    pick(/['"]?author['"]?\s*[:=]\s*['"]([^'"]{1,40})['"]/) || '';
  const updateUrl = pick(/@update[_a-z]*\s+([^\r\n]{1,200})/i) || '';
  return { name: name, version: version, author: author, updateUrl: updateUrl };
}

function extractLinks(text) {
  const out = new Set();
  const re = /https?:\/\/[^\s"'<>()\\]+/g;
  let m;
  while ((m = re.exec(text))) {
    const u = m[0].replace(/[),.;'"]+$/, '');
    if (/\.(js|zip)(\?|$)/i.test(u) || /raw\.githubusercontent\.com|gist\.githubusercontent\.com|\/raw\/|\/releases\/download\//.test(u)) {
      out.add(u);
    }
    if (out.size >= 30) break;
  }
  return Array.from(out);
}

function extractBackends(text) {
  const hosts = new Set();
  const re = /['"](https?:\/\/[^'"\s]{4,120}?)['"]/g;
  let m;
  while ((m = re.exec(text.slice(0, 60000)))) {
    try {
      const h = new URL(m[1]).hostname;
      if (!NON_BACKEND_HOSTS.test(h)) hosts.add(h);
    } catch (e) { /* noop */ }
    if (hosts.size >= 6) break;
  }
  return Array.from(hosts);
}

function detectConfidence(text, meta) {
  let score = 0;
  if (/on\(\s*['"]request['"]|EVENT_NAMES\.request/.test(text)) score += 2;
  if (/MUSIC_SOURCE|MUSIC_QUALITIES|PLATFORMS\s*=/.test(text)) score += 1;
  if (meta && meta.name) score += 1;
  if (meta && meta.version) score += 1;
  return score >= 3 ? 'high' : 'low';
}

const task = {
  type: null, running: false, cancel: false, trigger: '手动',
  phase: '', msg: '', done: 0, total: 0,
  startedAt: 0, endedAt: 0,
  stats: '', logs: [], allLogs: [], result: null
};

function taskLog(msg) {
  task.logs.push(String(msg).slice(0, 300));
  task.allLogs.push({ t: new Date().toISOString(), msg: String(msg).slice(0, 500) });
  if (task.logs.length > 40) task.logs = task.logs.slice(-30);
  store.log(msg);
}

function taskReset(type, total, trigger) {
  task.type = type; task.running = true; task.cancel = false;
  task.trigger = trigger || '手动';
  task.phase = type === 'crawl' ? '搜索' : (type === 'push' ? '灌入' : '检测');
  task.msg = ''; task.done = 0; task.total = total || 0;
  task.startedAt = Date.now(); task.endedAt = 0; task.stats = ''; task.logs = []; task.result = null;
  task.allLogs = [];
}

function taskFinish(result) {
  task.running = false; task.endedAt = Date.now(); task.result = result || null;
  try {
    const db = store.getDb();
    if (!Array.isArray(db.runs)) db.runs = [];
    const r = result || {};
    db.runs.unshift({
      id: task.startedAt + '-' + Math.floor(Math.random() * 1e4),
      kind: task.type, trigger: task.trigger || '手动',
      startedAt: task.startedAt, endedAt: task.endedAt,
      status: r.cancelled ? '已取消' : (r.error ? '异常终止' : '完成'),
      stats: task.stats || '',
      text: (task.allLogs || []).map(function (l) {
        const t = new Date(l.t);
        const p = function (n) { return ('0' + n).slice(-2); };
        return p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) + ' ' + l.msg;
      }).join('\r\n') + '\r\n'
    });
    while (db.runs.length > 25) db.runs.pop();
  } catch (e) { /* noop */ }
}

function nextSeq(db) {
  db.nextSeq = (db.nextSeq || 0) + 1;
  return db.nextSeq;
}

function upsertEntry(item) {
  const db = store.getDb();
  const key = item.primaryUrl;
  const id = sha1(key);
  let e = db.entries.find(function (x) { return x.id === id; });
  const now = Date.now();
  const newSha = item.bodySha || sha256hex(item.body || '');
  if (!e) {
    e = {
      id: id, seq: nextSeq(db),
      name: item.name || '(未命名)', author: item.author || '', version: item.version || '',
      platforms: item.platforms || [], urls: item.urls || [key], primaryUrl: key,
      isSource: !!item.isSource, confidence: item.confidence || 'low',
      obfuscated: !!item.obfuscated, sample: !!item.sample,
      bodySize: (item.body || '').length, bodySha: newSha, hasBody: !!item.body,
      mirrors: item.mirrors || [], variants: item.variants || [],
      origin: item.origin || '', originRepo: item.originRepo || '',
      repoPushAt: item.repoPushAt || 0, backendDomains: [], backendAlive: -1, httpStatus: 0,
      status: 'unknown', failStreak: 0,
      firstSeenAt: now, updatedAt: now, contentUpdatedAt: now, lastCheckAt: 0, lastOkAt: 0
    };
    if (item.body) store.attachBody(e, item.body);
    db.entries.push(e);
    taskLog('发现新源: ' + (e.name || e.primaryUrl));
  } else {
    e.name = item.name || e.name;
    e.author = item.author || e.author;
    e.version = item.version || e.version;
    if (item.platforms && item.platforms.length) e.platforms = item.platforms;
    e.urls = Array.from(new Set([].concat(e.urls, item.urls || [key]))).slice(0, 20);
    e.isSource = e.isSource || !!item.isSource;
    e.confidence = item.confidence || e.confidence;
    e.obfuscated = !!item.obfuscated;
    e.sample = !!item.sample;
    if (item.body) {
      const changed = e.bodySha !== newSha;
      store.attachBody(e, item.body);
      if (changed) e.contentUpdatedAt = now;
    }
    if (item.mirrors && item.mirrors.length) {
      e.mirrors = Array.from(new Set([].concat(e.mirrors || [], item.mirrors))).slice(0, 10);
    }
    if (item.variants && item.variants.length) {
      const seen = new Set((e.variants || []).map(function (v) { return v.src + '|' + v.ver; }));
      for (const v of item.variants) {
        const k = v.src + '|' + v.ver;
        if (!seen.has(k)) { seen.add(k); (e.variants = e.variants || []).push(v); }
      }
      e.variants = e.variants.slice(0, 10);
    }
    if (item.origin && !e.origin) e.origin = item.origin;
    if (item.originRepo) e.originRepo = item.originRepo;
    if (item.repoPushAt) e.repoPushAt = item.repoPushAt;
    e.updatedAt = now;
  }
  store.saveSoon();
  return e;
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch (e) { return u.slice(0, 40); }
}

async function fetchRepoTree(repo, cfg, ua) {
  const headers = { 'accept': 'application/vnd.github+json', 'user-agent': ua || DEFAULT_UA };
  if (cfg.ghToken) headers.authorization = 'Bearer ' + cfg.ghToken;
  const url = 'https://api.github.com/repos/' + repo + '/git/trees/HEAD?recursive=1';
  const r = await crawlFetch(url, { cfg: cfg, ua: ua, timeout: 15000, headers: headers });
  if (!r.ok || !r.text) throw new Error(r.error || ('HTTP ' + r.status));
  const j = JSON.parse(r.text);
  return (j.tree || []).filter(function (t) { return t.type === 'blob'; });
}

async function fetchRepoPushAt(repo, cfg, ua) {
  try {
    const headers = { 'accept': 'application/vnd.github+json', 'user-agent': ua || DEFAULT_UA };
    if (cfg.ghToken) headers.authorization = 'Bearer ' + cfg.ghToken;
    const r = await crawlFetch('https://api.github.com/repos/' + repo, { cfg: cfg, ua: ua, timeout: 10000, headers: headers });
    if (!r.ok || !r.text) return 0;
    const j = JSON.parse(r.text);
    return j.pushed_at ? new Date(j.pushed_at).getTime() : 0;
  } catch (e) { return 0; }
}

async function fetchLatestReleaseAssets(repo, cfg, ua) {
  try {
    const headers = { 'accept': 'application/vnd.github+json', 'user-agent': ua || DEFAULT_UA };
    if (cfg.ghToken) headers.authorization = 'Bearer ' + cfg.ghToken;
    const r = await crawlFetch('https://api.github.com/repos/' + repo + '/releases/latest', { cfg: cfg, ua: ua, timeout: 10000, headers: headers });
    if (!r.ok || !r.text) return [];
    const j = JSON.parse(r.text);
    const pubAt = j.published_at ? new Date(j.published_at).getTime() : 0;
    if (pubAt && (Date.now() - pubAt > STALE_REPO_DAYS * 86400 * 1000)) return [];
    return (j.assets || [])
      .map(function (a) { return a && a.browser_download_url; })
      .filter(function (u) { return u && /\.(js|zip)(\?|$)/i.test(u); });
  } catch (e) { return []; }
}

/**
 * 仓库安检门：快速判断目录是否属于纯客户端/大型工程而非音源仓。
 */
function isNonSourceRepoTree(tree) {
  if (!Array.isArray(tree) || !tree.length) return false;
  let hasAppMarker = false;
  let hasPackageJson = false;
  let hasSrcDir = false;
  let rootJsCount = 0;
  let tsOrVueCount = 0;
  for (const t of tree) {
    const p = t.path || '';
    if (APP_REPO_MARKER_RE.test(p)) hasAppMarker = true;
    if (/^package\.json$/i.test(p)) hasPackageJson = true;
    if (/^(?:src|server|client|app|web|frontend|backend|extensions)\//i.test(p)) hasSrcDir = true;
    if (/\.(?:ts|tsx|vue|jsx|py|java|kt|rs|go)$/i.test(p)) tsOrVueCount++;
    if (/^[^/]+\.js$/i.test(p) && !JUNK_FILE_RE.test(p)) rootJsCount++;
  }
  const looksLikeSoftwareProject = (hasPackageJson && hasSrcDir) || tsOrVueCount >= 5;
  return (hasAppMarker || looksLikeSoftwareProject) && rootJsCount === 0;
}

function analyzeOne(url, text, ctx) {
  ctx = ctx || {};
  const fname = decodeURIComponent((url.split('?')[0].split('/').pop() || '')).replace(/\.(js|zip|txt|json|md)$/i, '');
  const meta = extractMeta(text, fname);
  const links = extractLinks(text);
  let isSource = isSourceScript(text);
  let obfuscated = false;
  if (!isSource && isObfuscated(text)) {
    obfuscated = true;
    if (meta.name && meta.name !== fname && (meta.version || meta.updateUrl)) isSource = true;
  }
  const noRealName = !meta.name || meta.name === fname;
  if (isSource && noRealName && GENERIC_FILENAMES.test(fname)) isSource = false;
  const sample = !!(meta.name && meta.name !== fname && NAME_SAMPLE_HINT.test(meta.name));
  return {
    primaryUrl: url,
    name: meta.name || fname || '(未命名)',
    author: meta.author || ctx.repoOwner || '',
    version: meta.version || '',
    platforms: detectPlatforms(text),
    isSource: isSource,
    obfuscated: obfuscated,
    sample: sample,
    confidence: detectConfidence(text, meta),
    urls: Array.from(new Set([url].concat(links))).slice(0, 20),
    origin: ctx.repo || ctx.origin || '',
    originRepo: ctx.repo || '',
    body: text.length > 300000 ? text.slice(0, 300000) : text
  };
}

/**
 * 通用二级链接跟进（4路并发，支持 .js 直链和 .zip 压缩包内存自动解压提脚本）
 */
async function followExtraUrls(urls, seen, ctx, crawlTimeout, fetchOpts) {
  const todo = [];
  for (const u of urls) {
    if (task.cancel || seen.has(u)) continue;
    if (!/\.(js|zip)(\?|$)/i.test(u)) continue;
    seen.set(u, null);
    todo.push(u);
  }
  if (!todo.length) return;
  await runPool(todo, 4, async function (u) {
    if (task.cancel) return;
    if (/\.zip(\?|$)/i.test(u)) {
      const rb = await fetchBuffer(u, { ua: fetchOpts.ua, timeout: 12000 });
      if (rb.ok && rb.buf) {
        const extracted = zipUtil.extractJsFromZip(rb.buf);
        for (const f of extracted) {
          if (!isSourceScript(f.text)) continue;
          const vUrl = u + '#' + f.name;
          seen.set(vUrl, analyzeOne(vUrl, f.text, ctx));
        }
      }
      return;
    }

    const r2 = await crawlFetch(u, Object.assign({ timeout: crawlTimeout }, fetchOpts));
    if (r2.ok && r2.text && isSourceScript(r2.text)) {
      seen.set(u, analyzeOne(u, r2.text, ctx));
    }
  });
}

/**
 * 全网巡航扫描（唯新不破：30天动态雷达 + 按更新时间排序 + 仓库安检门 + README/Releases/ZIP + 并发抓包）
 */
async function crawlAll(triggerUa, trigger) {
  if (task.running) return { error: '已有任务进行中' };
  taskReset('crawl', 0, trigger);
  const db = store.getDb();
  const cfg = db.config;
  const crawlTimeout = cfg.fastMode ? 5000 : 8000;
  const fetchOpts = { cfg: cfg, ua: triggerUa, debug: !!cfg.debug, cancelled: function () { return task.cancel; } };

  try {
    const seen = new Map();
    const repoPush = {};

    // 1) 动态 30 天雷达探测活跃新仓
    if (cfg.radarEnabled !== false && !task.cancel) {
      task.phase = '动态雷达扫描';
      taskLog('[雷达] 正在扫描全网近 ' + (cfg.radarDays || 30) + ' 天活跃更新仓…');
      const radarRes = await radar.scanActiveRepos({
        cfg: cfg,
        ua: triggerUa,
        days: cfg.radarDays || 30,
        fetchFn: function (u, o) { return crawlFetch(u, Object.assign({}, o, fetchOpts)); },
        log: taskLog
      });
      if (radarRes.ok) {
        db.radarRepos = radarRes.repos;
        db.lastRadarAt = Date.now();
        for (const r of radarRes.repos) {
          if (r.pushedAt) repoPush[r.repo] = r.pushedAt;
        }
      } else {
        taskLog('[雷达] 本轮跳过动态扩充: ' + (radarRes.error || '无结果'));
      }
    }

    const blocked = cfg.blockedRepos || [];
    const radarRepoNames = (db.radarRepos || []).map(function (r) { return r.repo; });
    const rawRepoList = Array.from(new Set([].concat(currentBuiltinRepos(db), cfg.repos || [], radarRepoNames)))
      .filter(function (r) { return blocked.indexOf(r) < 0; });

    // 为静态仓补充最后更新时间（若无 Token 仅对未知仓做轻量并发查询），实现全局“唯新不破”排序与 60 天淘汰
    const staleCutoff = Date.now() - STALE_REPO_DAYS * 86400 * 1000;
    const unknownPushRepos = rawRepoList.filter(function (r) { return !repoPush[r]; });
    if (unknownPushRepos.length && (cfg.ghToken || unknownPushRepos.length <= 15)) {
      await runPool(unknownPushRepos, 4, async function (r) {
        const pt = await fetchRepoPushAt(r, cfg, triggerUa);
        if (pt) repoPush[r] = pt;
      });
    }

    const activeRepos = rawRepoList
      .filter(function (r) {
        const pt = repoPush[r] || 0;
        if (pt > 0 && pt < staleCutoff) {
          taskLog('[淘汰] ' + r + ' · 超过 ' + STALE_REPO_DAYS + ' 天未更新，已跳过');
          return false;
        }
        return true;
      })
      .sort(function (a, b) {
        return (repoPush[b] || 0) - (repoPush[a] || 0);
      })
      .slice(0, MAX_REPOS_PER_RUN);

    taskLog('[调度] 最终锁定 ' + activeRepos.length + ' 个新鲜活跃仓库（按最后更新时间倒序）');
    if (!db.repoErrors) db.repoErrors = {};

    await runPool(activeRepos, 3, async function (repo) {
      if (task.cancel) return;
      task.phase = '扫描仓库 ' + repo;
      const updStr = repoPush[repo] ? new Date(repoPush[repo]).toISOString().slice(0, 10) : '未知';
      taskLog('开始扫描仓库: ' + repo + ' (更新于 ' + updStr + ')');

      let tree = [];
      try {
        tree = await fetchRepoTree(repo, cfg, triggerUa);
      } catch (e) {
        db.repoErrors[repo] = String((e && e.message) || e).slice(0, 200);
        taskLog('仓库扫描失败 ' + repo + ': ' + (e.message || e));
        return;
      }
      delete db.repoErrors[repo];

      // 仓库安检门：拒绝大型客户端软件源码仓
      if (isNonSourceRepoTree(tree)) {
        taskLog('[安检跳过] ' + repo + ' · 判定为软件客户端工程而非音源仓');
        return;
      }

      const owner = repo.split('/')[0];
      const ctx = { repoOwner: owner, repo: repo };

      // 候选脚本文件（排除工程配置文件、过大/过小文件）
      const cand = tree.filter(function (t) {
        const p = t.path || '';
        if (JUNK_FILE_RE.test(p)) return false;
        if (!/\.(js|txt|json)$/i.test(p)) return false;
        if (t.size != null && (t.size < 200 || t.size > 500000)) return false;
        return true;
      }).slice(0, 60);

      // 补漏 1：根级 README.md 说明书提取外链
      const readmeEntry = tree.find(function (t) { return /^readme\.md$/i.test(t.path || ''); });
      if (readmeEntry) {
        const readmeUrl = 'https://raw.githubusercontent.com/' + repo + '/HEAD/' + encodeRepoPath(readmeEntry.path);
        const rr = await crawlFetch(readmeUrl, Object.assign({ timeout: crawlTimeout }, fetchOpts));
        if (rr.ok && rr.text) {
          const rLinks = extractLinks(rr.text);
          if (rLinks.length) {
            taskLog('[README] ' + repo + ' 提取到 ' + rLinks.length + ' 条外链，正在并发跟进…');
            await followExtraUrls(rLinks.slice(0, 10), seen, ctx, crawlTimeout, fetchOpts);
          }
        }
      }

      // 补漏 2：GitHub Releases 附件提取（若脚本很少或配置了 GITHUB_TOKEN）
      if (cfg.ghToken || cand.length < 3) {
        const relAssets = await fetchLatestReleaseAssets(repo, cfg, triggerUa);
        if (relAssets.length) {
          taskLog('[Release] ' + repo + ' 发现 ' + relAssets.length + ' 个发布附件，正在提取…');
          await followExtraUrls(relAssets.slice(0, 6), seen, ctx, crawlTimeout, fetchOpts);
        }
      }

      if (!cand.length) return;

      task.total += cand.length;
      taskLog('仓库 ' + repo + ' 候选文件 ' + cand.length + ' 个（并发抓取）');
      let done = 0;

      await runPool(cand, 6, async function (t) {
        if (task.cancel) return;
        done++; task.done++;
        task.msg = '仓库 ' + repo + ': ' + done + '/' + cand.length;
        const raw = 'https://raw.githubusercontent.com/' + repo + '/HEAD/' + encodeRepoPath(t.path);
        const r = await crawlFetch(raw, Object.assign({ timeout: crawlTimeout }, fetchOpts));
        if (!r.ok || !r.text) return;
        try {
          const item = analyzeOne(raw, r.text, ctx);
          if (item.isSource || item.urls.length > 1) seen.set(raw, item);
          await followExtraUrls(item.urls.slice(1, 8), seen, ctx, crawlTimeout, fetchOpts);
        } catch (e) { /* noop */ }
      });
    });

    // 2) 手动种子
    if (!task.cancel) {
      const seeds = cfg.seeds || [];
      task.total += seeds.length;
      for (const u of seeds) {
        if (task.cancel) break;
        task.done++; task.msg = '种子 ' + u;
        const r = await crawlFetch(u, Object.assign({ timeout: crawlTimeout }, fetchOpts));
        if (!r.ok || !r.text) { taskLog('种子扫描失败: ' + u); continue; }
        const item = analyzeOne(u, r.text, { origin: '种子导入' });
        seen.set(u, item);
        await followExtraUrls(item.urls.slice(1, 8), seen, { origin: '种子导入' }, crawlTimeout, fetchOpts);
      }
    }

    if (task.cancel) {
      taskLog('搜索已取消');
      taskFinish({ cancelled: true });
      return { ok: true, cancelled: true };
    }

    // 3) 内容指纹去重与合并
    task.phase = '聚合去重';
    let validCount = 0;
    const shaGroups = new Map();
    for (const item of seen.values()) {
      if (!item || !item.body || !item.isSource) continue;
      validCount++;
      const sha = sha256hex(item.body);
      if (shaGroups.has(sha)) {
        shaGroups.get(sha).mirrors.push(item.primaryUrl);
      } else {
        item.bodySha = sha;
        shaGroups.set(sha, { primary: item, mirrors: [item.primaryUrl] });
      }
    }
    const groups = new Map();
    for (const g of shaGroups.values()) {
      const p = g.primary;
      const gk = (p.name + '|' + p.author).toLowerCase();
      if (!groups.has(gk)) {
        groups.set(gk, { primary: p, urls: [p.primaryUrl], mirrors: [], variants: [] });
      }
      const grp = groups.get(gk);
      const vLabel = p.originRepo || p.origin || hostOf(p.primaryUrl);
      if (grp.primary !== p) grp.variants.push({ src: vLabel, ver: p.version || '' });
      for (const u of p.urls.slice(1)) if (grp.urls.indexOf(u) < 0) grp.urls.push(u);
      for (const u of g.mirrors) if (u !== grp.primary.primaryUrl && grp.urls.indexOf(u) < 0 && grp.mirrors.indexOf(u) < 0) grp.mirrors.push(u);
    }

    let created = 0;
    for (const grp of groups.values()) {
      const p = grp.primary;
      const before = db.entries.length;
      upsertEntry({
        primaryUrl: p.primaryUrl, name: p.name, author: p.author,
        version: p.version, platforms: p.platforms, isSource: p.isSource,
        confidence: p.confidence, urls: grp.urls, body: p.body, bodySha: p.bodySha,
        mirrors: grp.mirrors.slice(0, 10),
        variants: grp.variants.slice(0, 10),
        origin: p.origin, originRepo: p.originRepo,
        repoPushAt: p.originRepo ? (repoPush[p.originRepo] || 0) : 0
      });
      if (db.entries.length > before) created++;
    }
    db.lastCrawlAt = Date.now();
    store.saveNow();
    task.stats = '候选 ' + shaGroups.size + ' 内容组，新增 ' + created + '，总条目 ' + db.entries.length;
    taskLog('扫描完成：有效音源 ' + validCount + '，' + task.stats);
    taskFinish({ ok: true, total: db.entries.length, created: created });

    if (!task.cancel && cfg.autoCheck) {
      taskLog('自动执行可用性检测与 API 萃取…');
      await checkAll(triggerUa, (trigger || '手动') + '·自动');
    }
    return { ok: true, total: db.entries.length, created: created };
  } catch (e) {
    taskLog('任务异常: ' + (e.message || e));
    taskFinish({ error: e.message });
    return { error: e.message };
  }
}

function deepCacheGet(db, sha) {
  // 在 CI / GitHub Actions 定期跑批中强制绕过缓存实时复测，保证「去死留活」准确率
  if (process.env.CI) return null;
  if (!db.deepCache) db.deepCache = {};
  const d = db.deepCache[sha];
  if (d && Date.now() - d.checkedAt < 12 * 3600 * 1000) return d;
  return null;
}

function deepCacheSet(db, sha, deep) {
  if (!db.deepCache) db.deepCache = {};
  db.deepCache[sha] = deep;
  const keys = Object.keys(db.deepCache);
  if (keys.length > 400) {
    keys.sort(function (a, b) { return db.deepCache[a].checkedAt - db.deepCache[b].checkedAt; });
    for (let i = 0; i < keys.length - 300; i++) delete db.deepCache[keys[i]];
  }
}

function applyDeep(e, deep) {
  e.deep = { checkedAt: deep.checkedAt, loadable: deep.loadable, loadError: deep.loadError, inited: deep.inited };
  e.platStatus = deep.platforms;
  const usable = [];
  for (const p of sandbox.PLATFORMS) {
    if (deep.platforms[p] && deep.platforms[p].status === 'usable') {
      const m = PLATFORM_MAP.find(function (x) { return x.key === p; });
      usable.push(m ? m.label : p);
    }
  }
  e.platforms = usable;
  e.scriptType = deep.inited ? 'source' : 'unknown';
}

async function checkAll(triggerUa, trigger) {
  if (task.running) return { error: '已有任务进行中' };
  const db = store.getDb();
  const cfg = db.config;
  // 按来源仓库更新时间倒序，优先检测最新的音源
  const list = db.entries.slice().sort(function (a, b) {
    return (b.repoPushAt || 0) - (a.repoPushAt || 0);
  });
  taskReset('check', list.length, trigger);
  const okTimeout = cfg.fastMode ? 4500 : 8000;
  const altTimeout = cfg.fastMode ? 3500 : 6000;
  const batch = Math.max(1, Number(cfg.batchSize) || 60);
  let okCount = 0, suspectCount = 0, deadCount = 0;
  const shaFirst = new Map();
  const shaInFlight = new Map();
  const CHECK_CONCURRENCY = 5;

  try {
    let i = 0;
    taskLog('启动 ' + CHECK_CONCURRENCY + ' 路并发沙箱工人池（单工人内部保持严格单平台串行）…');
    await runPool(list, CHECK_CONCURRENCY, async function (e) {
      if (task.cancel) return;
      const seqIdx = ++i;
      task.done++;
      if ((seqIdx - 1) % batch === 0) taskLog('检测批次推进：第 ' + seqIdx + ' / ' + list.length + ' 条');
      task.msg = e.name || e.primaryUrl;
      const t0 = Date.now();

      // 同内容互斥防重：若同 SHA 正由另一工人测验中，直接等待其完成并复用结果
      if (e.bodySha && shaInFlight.has(e.bodySha)) {
        try { await shaInFlight.get(e.bodySha); } catch (err) { /* noop */ }
      }

      if (e.bodySha && shaFirst.has(e.bodySha) && shaFirst.get(e.bodySha).status !== 'dead') {
        const f = shaFirst.get(e.bodySha);
        e.lastCheckAt = Date.now();
        e.status = f.status; e.lastOkAt = f.lastOkAt; e.failStreak = 0;
        e.platforms = f.platforms; e.scriptType = f.scriptType;
        e.platStatus = f.platStatus; e.deep = f.deep;
        if (f.status === 'ok') okCount++;
        else if (f.status === 'suspect') suspectCount++;
        taskLog('[跳过] ' + (e.name || e.primaryUrl) + ' · 同内容本轮已测');
        store.saveSoon();
        return;
      }

      let resolveSha = null;
      if (e.bodySha && !shaInFlight.has(e.bodySha)) {
        shaInFlight.set(e.bodySha, new Promise(function (res) { resolveSha = res; }));
      }

      try {
        const now = Date.now();
        let code = store.getBody(e);
        const isFresh = code && e.updatedAt && (now - e.updatedAt < 20 * 60 * 1000);
        let fetchOk = isFresh;

        if (!isFresh) {
          const r = await fetchText(e.primaryUrl, { ua: triggerUa, timeout: okTimeout });
          e.httpStatus = r.status || 0;
          if (r.ok && r.text && r.text.length > 30) {
            code = r.text.slice(0, 300000);
            store.attachBody(e, code);
            fetchOk = true;
          } else {
            for (const u of (e.urls || []).slice(1, 4)) {
              if (task.cancel) break;
              const r2 = await fetchText(u, { ua: triggerUa, timeout: altTimeout });
              if (r2.ok && r2.text && r2.text.length > 30) {
                e.primaryUrl = u;
                e.httpStatus = r2.status || 0;
                code = r2.text.slice(0, 300000);
                store.attachBody(e, code);
                fetchOk = true;
                break;
              }
            }
          }
        }

        e.lastCheckAt = now;
        if (fetchOk && code) {
          e.status = 'ok';
          e.backendDomains = extractBackends(code);
          okCount++;

          if (isSourceScript(code) && !e.sample) {
            const sha = e.bodySha || sha256hex(code);
            e.bodySha = sha;
            let deep = deepCacheGet(db, sha);
            if (!deep) {
              deep = await sandbox.deepCheckSafe(code, e.name);
              deepCacheSet(db, sha, deep);
              const stParts = Object.keys(deep.platforms || {})
                .map(function (p) { return p + ':' + ((deep.platforms[p] || {}).status || '?'); });
              taskLog('[实测] ' + (e.name || e.primaryUrl) +
                (deep.inited ? '' : ' · 加载失败(' + (deep.loadError || '未初始化') + ')') +
                (stParts.length ? ' ' + stParts.join(' ') : ' 无平台结果') +
                ((deep.extractedCandidates && deep.extractedCandidates.length) ? ' [捕获规则 ' + deep.extractedCandidates.length + ' 条]' : ''));
            } else {
              taskLog('[缓存] ' + (e.name || e.primaryUrl) + ' · 深检结果 12h 内沿用');
            }
            applyDeep(e, deep);
          }

          if (e.status === 'ok' && !(e.platforms || []).length) {
            e.status = 'suspect';
            e.failStreak = (e.failStreak || 0) + 1;
            okCount--;
            suspectCount++;
          } else {
            e.lastOkAt = now;
            e.failStreak = 0;
          }
        } else {
          e.status = 'dead';
          e.failStreak = (e.failStreak || 0) + 1;
          deadCount++;
        }

        if (e.bodySha && !shaFirst.has(e.bodySha) && e.status !== 'dead') shaFirst.set(e.bodySha, e);
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        const stTxt = e.status === 'ok'
          ? ('可用' + ((e.platforms || []).length ? '（' + e.platforms.join(',') + '）' : ''))
          : e.status === 'suspect' ? '存疑' : '失效';
        taskLog('[检测] ' + (e.name || e.primaryUrl) + ' · ' + stTxt + ' · ' + dur + 's');
        store.saveSoon();
      } finally {
        if (resolveSha) resolveSha();
      }
    });

    // 去死留活：清理连续失效 >= 3 次的历史脚本（或从未可用且连续失败 >= 2 次的废条目），并同步清理硬盘孤立缓存
    let purgedScripts = 0;
    db.entries = db.entries.filter(function (item) {
      if (item.status === 'ok') return true;
      const limit = item.lastOkAt ? 3 : 2;
      if ((item.failStreak || 0) >= limit) {
        purgedScripts++;
        return false;
      }
      return true;
    });
    const cleanedFiles = store.cleanupUnusedScripts(db);
    if (purgedScripts || cleanedFiles) {
      taskLog('[清理] 移出连续失效脚本 ' + purgedScripts + ' 个，释放缓存文件 ' + cleanedFiles + ' 个');
    }

    db.lastCheckAt = Date.now();
    store.saveNow();

    if (task.cancel) {
      taskLog('检测已取消（处理到 ' + i + '/' + list.length + '）');
      taskFinish({ cancelled: true });
      return { ok: true, cancelled: true };
    }

    task.phase = 'API 萃取与第二曲目验真';
    const extRes = await extractor.buildAndSave(db, { log: taskLog });

    task.stats = '可用 ' + okCount + '，存疑 ' + suspectCount + '，失效 ' + deadCount + '，黄金API ' + (extRes.totalEndpoints || 0);
    taskLog('全流程完成：' + task.stats);
    taskFinish({ ok: true, okCount: okCount, suspectCount: suspectCount, deadCount: deadCount, totalEndpoints: extRes.totalEndpoints });
    return { ok: true, okCount: okCount, suspectCount: suspectCount, deadCount: deadCount, totalEndpoints: extRes.totalEndpoints };
  } catch (e) {
    taskLog('任务异常: ' + (e.message || e));
    taskFinish({ error: e.message });
    return { error: e.message };
  }
}

const MIRROR_PROBE_RAW = 'https://raw.githubusercontent.com/pdone/lx-music-source/HEAD/README.md';
async function testMirror(mbase, ua) {
  const base = normMirrorBase(mbase);
  if (!base) return { ok: false, error: '缺少 mirror 参数' };
  const testUrl = mirrorUrlFor(base, MIRROR_PROBE_RAW);
  const t0 = Date.now();
  const r = await fetchText(testUrl, { ua: ua, timeout: 10000 });
  return { mirror: base, ok: !!r.ok, status: r.status || 0, ms: Date.now() - t0 };
}

const BUILTIN_MANIFEST_URL = process.env.LXHUB_MANIFEST_URL || '';
function currentBuiltinRepos(db) {
  const m = db.builtinRepos;
  if (m && Array.isArray(m.repos) && m.repos.length) {
    return m.repos.filter(function (r) { return /^[\w.\-]+\/[\w.\-]+$/.test(r); });
  }
  return store.BUILTIN_REPOS;
}

function manifestInfo(db) {
  const m = db.builtinRepos;
  if (m && m.version) {
    return { version: m.version, updatedAt: m.updatedAt || '', fetchedAt: m.fetchedAt || 0, count: (m.repos || []).length, source: '远端清单 v' + m.version };
  }
  return { version: 0, updatedAt: '', fetchedAt: 0, count: store.BUILTIN_REPOS.length, source: '内置核心底座' };
}

async function checkBuiltinManifest(cfg, ua) {
  if (!BUILTIN_MANIFEST_URL) return { ok: true, applied: false, upToDate: true, current: 0, latest: 0, count: store.BUILTIN_REPOS.length };
  const db = store.getDb();
  const r = await crawlFetch(BUILTIN_MANIFEST_URL + '?nocache=' + Date.now(), { cfg: cfg, ua: ua, timeout: 10000 });
  if (!r.ok || !r.text) return { ok: false, error: '拉取失败: ' + (r.error || r.status) };
  let j;
  try { j = JSON.parse(r.text); } catch (e) { return { ok: false, error: '清单不是合法 JSON' }; }
  if (!j || !Array.isArray(j.repos) || !Number.isFinite(j.version)) return { ok: false, error: '清单格式无效' };
  const repos = j.repos.map(function (s) { return String(s && (s.repo || s) || '').trim(); })
    .filter(function (s) { return /^[\w.\-]+\/[\w.\-]+$/.test(s); });
  if (!repos.length) return { ok: false, error: '清单里没有有效仓库' };
  const cur = (db.builtinRepos && db.builtinRepos.version) || 0;
  const info = { latest: j.version, current: cur, count: repos.length };
  if (j.version <= cur) return Object.assign({ ok: true, applied: false, upToDate: true }, info);
  db.builtinRepos = { version: j.version, updatedAt: j.updatedAt || '', repos: repos.slice(0, 200), fetchedAt: Date.now(), source: BUILTIN_MANIFEST_URL };
  store.saveSoon();
  return Object.assign({ ok: true, applied: true }, info);
}

const MARKET_URL = 'https://raw.githubusercontent.com/zlyon/lx-hunter-market/main/data/community.json';
const MARKET_CACHE_MS = 30 * 60 * 1000;
let marketCache = null;
async function fetchMarketList(cfg, ua, force) {
  if (marketCache && !force && Date.now() - marketCache.at < MARKET_CACHE_MS) {
    return { ok: true, updatedAt: marketCache.data.updatedAt, items: marketCache.data.sources };
  }
  const bustUrl = force ? MARKET_URL + '?nocache=' + Date.now() : MARKET_URL;
  const r = await crawlFetch(bustUrl, { cfg: cfg, ua: ua, timeout: 10000 });
  if (!r.ok || !r.text) return { ok: false, error: '拉取失败: ' + (r.error || r.status) };
  let j;
  try { j = JSON.parse(r.text); } catch (e) { return { ok: false, error: '数据不是合法 JSON' }; }
  if (!j || !Array.isArray(j.sources)) return { ok: false, error: '数据格式无效' };
  marketCache = { at: Date.now(), data: j };
  return { ok: true, updatedAt: j.updatedAt, items: j.sources };
}

async function pushAll(triggerUa, trigger, opts) {
  opts = opts || {};
  if (task.running) return { error: '已有任务进行中' };
  const db = store.getDb();
  const cfg = db.config;
  const allTargets = cfg.pushTargets || [];
  const wantIds = Array.isArray(opts.targets) ? opts.targets : null;
  const targets = allTargets.filter(function (t) {
    return t.enabled !== false && (!wantIds || wantIds.indexOf(t.id) >= 0) && pusher.adapterFor(t.type);
  });
  if (!targets.length) return { error: '没有可用的灌入目标' };
  const wantEntries = Array.isArray(opts.entryIds) ? opts.entryIds : null;
  const list = db.entries.filter(function (e) {
    const st = e.scriptType || (e.isSource ? 'source' : 'unknown');
    return (!wantEntries || wantEntries.indexOf(e.id) >= 0) &&
      e.status === 'ok' && store.getBody(e) && st !== 'unknown' && !e.sample;
  });
  if (!list.length) return { error: '没有可灌入的音源' };

  taskReset('push', list.length * targets.length, trigger);
  try {
    let okCount = 0, skipCount = 0, failCount = 0;
    for (const t of targets) {
      if (task.cancel) break;
      const ad = pusher.adapterFor(t.type);
      const tName = t.name || ad.label;
      const pushedMap = t.pushedMap = t.pushedMap || {};
      taskLog('→ 目标 [' + tName + '] 开始灌入');
      for (const e of list) {
        if (task.cancel) break;
        task.phase = '灌入 → ' + tName;
        task.msg = e.name || e.id;
        const body = store.getBody(e);
        const sha = e.bodySha || (e.bodySha = sha256hex(body));
        const prev = pushedMap[e.id];
        const prevHash = typeof prev === 'string' ? prev : ((prev && prev.hash) || '');
        if (prevHash === sha) { skipCount++; task.done++; continue; }
        const script = { name: String(e.name || e.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.js', content: body };
        let r;
        try { r = await ad.push(t, script); } catch (err) { r = { ok: false, error: pusher.errText(err) }; }
        if (r.ok) {
          pushedMap[e.id] = { hash: sha, importedAt: Date.now() };
          okCount++;
        } else {
          failCount++;
        }
        task.done++;
      }
    }
    task.stats = '成功 ' + okCount + ' · 跳过 ' + skipCount + ' · 失败 ' + failCount;
    taskFinish({ ok: true, cancelled: task.cancel });
    store.saveSoon();
    return { ok: true };
  } catch (e) {
    taskFinish({ error: String((e && e.message) || e) });
    return { error: String((e && e.message) || e) };
  }
}

module.exports = {
  DEFAULT_UA, task, sha1, sha256: sha256hex,
  MIRROR_PRESETS, normMirrorBase, mirrorUrlFor, jsdelivrUrlFor, buildCandidates, crawlFetch, testMirror,
  fetchText, accelRewrite, detectPlatforms, isSourceScript, isObfuscated, extractMeta, extractLinks, extractBackends, detectConfidence,
  crawlAll, checkAll, buildZip: zipUtil.buildZip, crc32: zipUtil.crc32,
  BUILTIN_MANIFEST_URL, currentBuiltinRepos, manifestInfo, checkBuiltinManifest,
  MARKET_URL, fetchMarketList,
  pusher, pushAll
};
