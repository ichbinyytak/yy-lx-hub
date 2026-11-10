'use strict';
// yy-lx-hub 服务入口：完整保留洛雪生态交互与导出，同时提供 Amusic 原生 API 清单直通接口。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const core = require('./lib/core');
const sched = require('./lib/sched');
const extractor = require('./lib/extractor');
const exporter = require('./lib/exporter');
const apicrypto = require('./lib/apicrypto');

const PORT = Number(process.env.PORT || process.env.LXHUB_PORT || 58059);
const HOST = process.env.HOST || process.env.LXHUB_HOST || undefined;
const ADMIN_USER = process.env.ADMIN_USER || process.env.LXH_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.LXH_ADMIN_PASS || 'admin888';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 与 Cookie Max-Age 一致：30 天

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip'
};

function sign(exp) {
  const db = store.getDb();
  return crypto.createHmac('sha256', db.secret).update('admin' + exp).digest('hex').slice(0, 32);
}

function makeSession() {
  const exp = Date.now() + SESSION_TTL_MS;
  return exp + '.' + sign(exp);
}

function checkSession(req) {
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)lxhub_admin=([0-9]+\.[a-f0-9]+)/);
  if (!m) return false;
  const exp = Number(m[1].split('.')[0]);
  if (exp < Date.now()) return false;
  return sign(exp) === m[1].split('.')[1];
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', function (c) {
      if (tooLarge) return;
      bytes += c.length;
      if (bytes > 1048576) {
        tooLarge = true;
        const err = new Error('Payload Too Large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (tooLarge) return;
      const data = Buffer.concat(chunks).toString('utf8');
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', function () {
      if (!tooLarge) resolve({});
    });
  });
}

function clientUa(req) {
  return req.headers['user-agent'] || core.DEFAULT_UA;
}

function relTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

function kindOf(e) { return e.scriptType || (e.isSource ? 'source' : 'unknown'); }

function entryPublic(e) {
  return {
    id: e.id, seq: e.seq || 0, name: e.name, author: e.author, version: e.version,
    platforms: e.platforms || [], status: e.status,
    scriptType: kindOf(e), platStatus: e.platStatus || null,
    isSource: !!e.isSource, confidence: e.confidence || 'low',
    mirrorCount: (e.mirrors || []).length, variantCount: (e.variants || []).length,
    repoPushAt: e.repoPushAt || 0, contentUpdatedAt: e.contentUpdatedAt || e.updatedAt,
    backendAlive: e.backendAlive != null ? e.backendAlive : -1,
    updatedAt: e.updatedAt, lastOkAt: e.lastOkAt,
    hasBody: !!(e.hasBody || e.bodySha || e.body),
    bodySha: e.bodySha || ''
  };
}

function filterEntries(q) {
  const db = store.getDb();
  const search = (q.search || '').toLowerCase();
  const status = q.status || 'all';
  const type = q.type || 'src';
  const stMap = { alive: 'ok', ok: 'ok', suspect: 'suspect', down: 'down', dead: 'dead' };
  let list = db.entries.slice();
  if (stMap[status]) list = list.filter(function (e) { return e.status === stMap[status]; });
  if (type === 'source') list = list.filter(function (e) { return kindOf(e) !== 'unknown'; });
  else if (type === 'unk') list = list.filter(function (e) { return kindOf(e) === 'unknown'; });
  if (search) {
    list = list.filter(function (e) {
      return (e.name || '').toLowerCase().indexOf(search) >= 0 ||
        (e.author || '').toLowerCase().indexOf(search) >= 0 ||
        (e.primaryUrl || '').toLowerCase().indexOf(search) >= 0;
    });
  }
  list.sort(function (a, b) {
    const ord = { ok: 0, suspect: 1, down: 2, unknown: 3, dead: 4 };
    const sa = ord[a.status] != null ? ord[a.status] : 2;
    const sb = ord[b.status] != null ? ord[b.status] : 2;
    if (sa !== sb) return sa - sb;
    const pa = a.repoPushAt || 0, pb = b.repoPushAt || 0;
    if (pa !== pb) return pb - pa;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return list;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const db = store.getDb();
  const ua = clientUa(req);

  if (req.method === 'GET' && p === '/api/task/current') {
    const t = core.task;
    return json(res, 200, {
      running: t.running, type: t.type, phase: t.phase, msg: t.msg,
      done: t.done, total: t.total,
      elapsed: t.running ? (Date.now() - t.startedAt) : (t.endedAt ? t.endedAt - t.startedAt : 0),
      stats: t.stats, logs: t.logs.slice(-8),
      result: t.running ? null : t.result
    });
  }

  if (req.method === 'POST' && p === '/api/task/cancel') {
    if (!checkSession(req)) return json(res, 401, { error: 'unauthorized' });
    if (!core.task.running) return json(res, 409, { error: '当前没有进行中的任务' });
    core.task.cancel = true;
    store.log('用户请求取消任务: ' + core.task.type);
    return json(res, 200, { ok: true });
  }

  // ---- 供 Amusic 消费的 API 规则清单接口 ----
  if (req.method === 'GET' && p === '/api/extracted-apis.enc') {
    const encFile = path.join(PUBLIC_DIR, 'extracted_apis.enc');
    try {
      const txt = fs.readFileSync(encFile, 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(txt);
    } catch (e) {
      const secret = apicrypto.getSyncSecret();
      const plainFile = path.join(PUBLIC_DIR, 'extracted_apis.json');
      if (secret && fs.existsSync(plainFile)) {
        try {
          const payload = JSON.parse(fs.readFileSync(plainFile, 'utf8'));
          const env = apicrypto.encryptJson(payload, secret);
          const txt = JSON.stringify(env);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
          return res.end(txt);
        } catch (err) { /* noop */ }
      }
      return json(res, 404, { error: 'encrypted api bundle not ready' });
    }
  }

  if (req.method === 'GET' && p === '/api/extracted-apis') {
    if (db.config.externalDeploy && !checkSession(req)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const f = path.join(PUBLIC_DIR, 'extracted_apis.json');
    try {
      const txt = fs.readFileSync(f, 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(txt);
    } catch (e) {
      return json(res, 200, { version: '2.0.0', updatedAt: null, totalEndpoints: 0, endpoints: [] });
    }
  }

  if (req.method === 'GET' && p === '/api/overview') {
    const entries = db.entries;
    const accelPrefix = db.config.ghMirror || db.config.accelPrefix || '';
    let accelHost = '';
    if (accelPrefix) {
      try { accelHost = new URL(accelPrefix).hostname; } catch (e) { accelHost = accelPrefix.slice(0, 40); }
    }
    return json(res, 200, {
      total: entries.length,
      ok: entries.filter(function (e) { return e.status === 'ok'; }).length,
      suspect: entries.filter(function (e) { return e.status === 'suspect'; }).length,
      down: entries.filter(function (e) { return e.status === 'down'; }).length,
      dead: entries.filter(function (e) { return e.status === 'dead'; }).length,
      sources: entries.filter(function (e) { return e.isSource; }).length,
      radarCount: (db.radarRepos || []).length,
      lastRadarAt: db.lastRadarAt || 0,
      lastCrawlAt: db.lastCrawlAt, lastCrawlRel: relTime(db.lastCrawlAt),
      lastCheckAt: db.lastCheckAt, lastCheckRel: relTime(db.lastCheckAt),
      accelReady: !!accelPrefix, accelHost: accelHost, accelPrefix: accelPrefix,
      running: core.task.running, phase: core.task.phase,
      authed: checkSession(req)
    });
  }

  if (req.method === 'GET' && p === '/api/entries') {
    const list = filterEntries(q);
    return json(res, 200, { items: list.map(entryPublic), total: list.length });
  }

  if (req.method === 'GET' && p === '/api/source/link') {
    const e = db.entries.find(function (x) { return x.id === q.id; });
    if (!e) return json(res, 404, { error: 'not found' });
    let target = e.primaryUrl;
    if (q.accel === '1' && db.config.ghMirror) target = core.accelRewrite(target, db.config.ghMirror);
    return json(res, 200, { url: target });
  }

  if (req.method === 'GET' && p === '/api/source/detail') {
    const e = db.entries.find(function (x) { return x.id === q.id; });
    if (!e) return json(res, 404, { error: 'not found' });
    let urlStr = e.primaryUrl;
    if (q.accel === '1' && db.config.ghMirror) urlStr = core.accelRewrite(urlStr, db.config.ghMirror);
    const body = store.getBody(e);
    return json(res, 200, {
      id: e.id, seq: e.seq || 0, name: e.name, author: e.author, version: e.version,
      platforms: e.platforms || [], status: e.status, isSource: !!e.isSource,
      scriptType: kindOf(e), platStatus: e.platStatus || null, deepError: (e.deep && e.deep.loadError) || '',
      confidence: e.confidence || 'low',
      mirrorCount: (e.mirrors || []).length, variantCount: (e.variants || []).length,
      mirrors: e.mirrors || [], variants: e.variants || [],
      urls: e.urls || [e.primaryUrl], url: urlStr,
      origin: e.origin || '', originRepo: e.originRepo || '',
      backendDomains: e.backendDomains || [], backendAlive: e.backendAlive != null ? e.backendAlive : -1,
      httpStatus: e.httpStatus || 0,
      size: e.bodySize || body.length || 0, sha256: body ? core.sha256(body) : (e.bodySha || ''),
      firstSeenAt: e.firstSeenAt, lastCheckAt: e.lastCheckAt, lastOkAt: e.lastOkAt,
      contentUpdatedAt: e.contentUpdatedAt || e.updatedAt,
      bodyHead: body ? body.slice(0, 4000) : ''
    });
  }

  if (req.method === 'GET' && p === '/api/source/download') {
    const e = db.entries.find(function (x) { return x.id === q.id; });
    if (!e) return json(res, 404, { error: 'not found' });
    const cached = store.getBody(e);
    let text = cached;
    if (!text) {
      let target = e.primaryUrl;
      if (q.accel === '1' && db.config.ghMirror) target = core.accelRewrite(target, db.config.ghMirror);
      const r = await core.crawlFetch(target, { cfg: db.config, ua: ua, timeout: 15000 });
      if (!r.ok || !r.text) return json(res, 502, { error: '拉取失败: ' + (r.error || r.status) });
      text = r.text;
    }
    const safe = (e.name || 'source').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-disposition': 'attachment; filename="' + encodeURIComponent(safe + '-' + e.id + '.js') + '"'
    });
    return res.end(text);
  }

  if (req.method === 'GET' && p === '/api/export') {
    const matched = filterEntries({ status: 'alive', type: q.type || 'all', search: (q.search || '') });
    const built = exporter.buildSourcesZip(matched, store);
    if (!built.zipBuffer) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('当前没有可用的音源脚本可导出');
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="lx-sources-' + new Date().toISOString().slice(0, 10) + '.zip"'
    });
    return res.end(built.zipBuffer);
  }

  // ---- 登录 ----
  if (req.method === 'POST' && p === '/api/admin/login') {
    const body = await readBody(req);
    if (body.user === ADMIN_USER && body.pass === ADMIN_PASS) {
      res.setHeader('set-cookie', 'lxhub_admin=' + makeSession() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000));
      store.log('后台登录成功');
      return json(res, 200, { ok: true });
    }
    await new Promise(function (r) { setTimeout(r, 600); });
    return json(res, 401, { error: '账户名或密码错误' });
  }
  if (req.method === 'POST' && p === '/api/admin/logout') {
    res.setHeader('set-cookie', 'lxhub_admin=; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/admin/session') {
    return json(res, 200, { authed: checkSession(req) });
  }

  if (p.startsWith('/api/admin/')) {
    if (!checkSession(req)) return json(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && p === '/api/admin/config') {
      const c = db.config;
      return json(res, 200, {
        config: {
          proxy: c.proxy || '', ghMirror: c.ghMirror || '', forceProxy: !!c.forceProxy,
          useJsdelivr: !!c.useJsdelivr, ghTokenSet: !!store.getGhToken(c),
          autoCheck: c.autoCheck !== false, radarEnabled: c.radarEnabled !== false,
          radarDays: Number(c.radarDays) || 30,
          batchSize: Number(c.batchSize) || 60,
          fastMode: !!c.fastMode, debug: !!c.debug,
          externalDeploy: !!c.externalDeploy,
          repos: c.repos || [], blockedRepos: c.blockedRepos || [], seeds: c.seeds || []
        },
        builtinRepos: core.currentBuiltinRepos(db),
        radarRepos: db.radarRepos || [],
        manifest: core.manifestInfo(db),
        repoErrors: db.repoErrors || {},
        mirrorPresets: core.MIRROR_PRESETS
      });
    }

    if (req.method === 'POST' && p === '/api/admin/extract') {
      const extRes = await extractor.buildAndSave(db, { log: store.log });
      store.saveSoon();
      return json(res, 200, extRes);
    }

    if (req.method === 'GET' && p === '/api/admin/repo-stats') {
      const stats = {};
      for (const e of db.entries) {
        const repo = e.originRepo || '';
        if (!repo) continue;
        const s = stats[repo] || (stats[repo] = { usable: 0, total: 0, untested: 0 });
        if (kindOf(e) === 'unknown') continue;
        s.total++;
        if (e.status === 'ok') s.usable++;
        if (!e.deep || !e.deep.checkedAt) s.untested++;
      }
      const errs = db.repoErrors || {};
      for (const k in errs) if (!stats[k]) stats[k] = { usable: 0, total: 0, untested: 0, error: errs[k] };
      return json(res, 200, { ok: true, stats: stats });
    }

    if (req.method === 'POST' && p === '/api/admin/repos/block') {
      const body = await readBody(req);
      const repo = String(body.repo || '').trim();
      const blocked = !!body.blocked;
      if (core.currentBuiltinRepos(db).indexOf(repo) < 0) return json(res, 400, { error: '只能屏蔽内置仓库' });
      const c = db.config;
      const list = c.blockedRepos = c.blockedRepos || [];
      const idx = list.indexOf(repo);
      if (blocked && idx < 0) list.push(repo);
      if (!blocked && idx >= 0) list.splice(idx, 1);
      store.saveSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/admin/manifest/check') {
      const r = await core.checkBuiltinManifest(db.config, ua);
      return json(res, r.ok ? 200 : 502, r);
    }

    if (req.method === 'GET' && p === '/api/admin/market') {
      const r = await core.fetchMarketList(db.config, ua, q.force === '1');
      if (!r.ok) return json(res, 502, r);
      const c = db.config;
      const items = (r.items || []).map(function (s) {
        const adopted = s.type === 'repo'
          ? (c.repos || []).indexOf(s.repo) >= 0
          : (c.seeds || []).indexOf(s.url) >= 0;
        return {
          name: s.name, url: s.url || '', repo: s.repo || '', type: s.type,
          notes: String(s.notes || '').slice(0, 120), submitter: s.submitter || '',
          usable: s.stats && typeof s.stats.usable === 'number' ? s.stats.usable : null,
          total: s.stats && typeof s.stats.source === 'number' ? s.stats.source : null,
          adopted: adopted
        };
      });
      return json(res, 200, { ok: true, updatedAt: r.updatedAt, items: items });
    }

    if (req.method === 'POST' && p === '/api/admin/market/adopt') {
      const body = await readBody(req);
      const item = String(body.item || '');
      if (body.adopt) {
        if (body.type === 'repo' && /^[\w.\-]+\/[\w.\-]+$/.test(item)) {
          if ((db.config.repos || []).indexOf(item) < 0) (db.config.repos = db.config.repos || []).push(item);
        } else if (/^https?:\/\//.test(item)) {
          if ((db.config.seeds || []).indexOf(item) < 0) (db.config.seeds = db.config.seeds || []).push(item);
        } else return json(res, 400, { error: '条目无效' });
      } else {
        const ri = (db.config.repos || []).indexOf(item);
        if (ri >= 0) db.config.repos.splice(ri, 1);
        const si = (db.config.seeds || []).indexOf(item);
        if (si >= 0) db.config.seeds.splice(si, 1);
      }
      store.saveSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/admin/runs') {
      const runs = (db.runs || []).map(function (r) {
        return { id: r.id, kind: r.kind, trigger: r.trigger, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, stats: r.stats };
      });
      return json(res, 200, { runs: runs });
    }

    if (req.method === 'GET' && p === '/api/admin/runs/download') {
      const r = (db.runs || []).find(function (x) { return String(x.id) === String(q.id); });
      if (!r) return json(res, 404, { error: '日志不存在' });
      const kind = r.kind === 'crawl' ? '搜索' : '检测';
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('# yy-lx-hub ' + kind + '运行日志\r\n# 触发方式: ' + r.trigger + '\r\n# 状态: ' + r.status + (r.stats ? '（' + r.stats + '）' : '') + '\r\n# ----------------------------------------\r\n' + (r.text || ''));
    }

    if (req.method === 'POST' && p === '/api/admin/config') {
      const body = await readBody(req);
      const c = db.config;
      if (typeof body.proxy === 'string') c.proxy = body.proxy.trim();
      if (typeof body.ghMirror === 'string') c.ghMirror = core.normMirrorBase(body.ghMirror);
      if (typeof body.forceProxy === 'boolean') c.forceProxy = body.forceProxy;
      if (typeof body.useJsdelivr === 'boolean') c.useJsdelivr = body.useJsdelivr;
      if (typeof body.ghToken === 'string' && body.ghToken.trim()) c.ghToken = body.ghToken.trim();
      if (typeof body.autoCheck === 'boolean') c.autoCheck = body.autoCheck;
      if (typeof body.radarEnabled === 'boolean') c.radarEnabled = body.radarEnabled;
      if (body.radarDays != null) c.radarDays = Math.min(90, Math.max(1, Number(body.radarDays) || 30));
      if (body.batchSize != null) c.batchSize = Math.min(500, Math.max(1, Number(body.batchSize) || 60));
      if (typeof body.fastMode === 'boolean') c.fastMode = body.fastMode;
      if (typeof body.debug === 'boolean') c.debug = body.debug;
      if (typeof body.externalDeploy === 'boolean') c.externalDeploy = body.externalDeploy;
      if (Array.isArray(body.repos)) c.repos = body.repos.map(function (s) { return String(s).trim(); }).filter(function (s) { return /^[\w.\-]+\/[\w.\-]+$/.test(s); }).slice(0, 50);
      if (Array.isArray(body.seeds)) c.seeds = body.seeds.map(function (s) { return String(s).trim(); }).filter(function (s) { return /^https?:\/\//.test(s); }).slice(0, 100);
      store.saveSoon();
      store.log('配置已更新');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/admin/mirror-test') {
      const body = await readBody(req);
      const r = await core.testMirror(body.mirror, ua);
      return json(res, r.ok ? 200 : 502, r);
    }

    if (req.method === 'POST' && p === '/api/admin/repos') {
      const body = await readBody(req);
      let repo = String(body.repo || '').trim();
      const m = repo.match(/github\.com[/:]([\w.\-]+\/[\w.\-]+)/i);
      if (m) repo = m[1];
      repo = repo.replace(/\.git$/i, '').replace(/\/+$/, '');
      if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) {
        if (/^https?:\/\//i.test(repo)) {
          const c0 = db.config;
          if ((c0.seeds || []).indexOf(repo) >= 0) return json(res, 400, { error: '该链接已存在' });
          (c0.seeds = c0.seeds || []).push(repo);
          store.saveSoon();
          return json(res, 200, { ok: true, url: true });
        }
        return json(res, 400, { error: '仓库格式无效，应为 owner/repo 或 http(s) 链接' });
      }
      if (store.BUILTIN_REPOS.indexOf(repo) >= 0) return json(res, 400, { error: '该仓库已在内置仓库中' });
      const c = db.config;
      if ((c.repos || []).indexOf(repo) >= 0) return json(res, 400, { error: '该仓库已存在' });
      (c.repos = c.repos || []).push(repo);
      store.saveSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/admin/urls/remove') {
      const body = await readBody(req);
      const urlStr = String(body.url || '').trim();
      const c = db.config;
      const idx = (c.seeds || []).indexOf(urlStr);
      if (idx < 0) return json(res, 404, { error: 'not found' });
      c.seeds.splice(idx, 1);
      store.saveSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/admin/push/targets') {
      const entryById = new Map();
      db.entries.forEach(function (e) { entryById.set(e.id, e); });
      return json(res, 200, {
        ok: true,
        types: core.pusher.PUSH_TYPES.map(function (k) {
          return { type: k, label: core.pusher.ADAPTERS[k].label, hint: core.pusher.ADAPTERS[k].hint };
        }),
        targets: (db.config.pushTargets || []).map(function (t) {
          const pm = t.pushedMap || {};
          const pushedList = Object.keys(pm).map(function (id) {
            const e = entryById.get(id);
            const rec = pm[id];
            return {
              id: id,
              name: (e && e.name) || id,
              platforms: (e && e.platforms) || [],
              platStatus: (e && e.platStatus) || null,
              importedAt: (rec && typeof rec === 'object' ? rec.importedAt : 0) || 0
            };
          });
          return {
            id: t.id, name: t.name, type: t.type, baseUrl: t.baseUrl,
            tokenSet: !!t.token, username: t.username || '',
            enabled: t.enabled !== false,
            pushed: Object.keys(pm).length,
            pushedMap: pm,
            pushedList: pushedList
          };
        })
      });
    }

    if (req.method === 'POST' && p === '/api/admin/push/targets') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 40);
      const type = String(body.type || '').trim();
      const baseUrl = String(body.baseUrl || '').trim();
      const c = db.config;
      c.pushTargets = c.pushTargets || [];
      let t;
      if (body.id) {
        t = c.pushTargets.find(function (x) { return x.id === body.id; });
        if (!t) return json(res, 404, { error: '目标不存在' });
      } else {
        if (!core.pusher.adapterFor(type)) return json(res, 400, { error: '未知的目标类型: ' + type });
        if (!/^https?:\/\//i.test(baseUrl)) return json(res, 400, { error: '地址必须是 http(s):// 开头' });
        t = { id: 'pt-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36) };
        c.pushTargets.push(t);
      }
      if (core.pusher.adapterFor(type)) t.type = type;
      if (/^https?:\/\//i.test(baseUrl)) t.baseUrl = baseUrl.replace(/\/+$/, '');
      if (name) t.name = name;
      if (body.token) t.token = String(body.token);
      if (body.username !== undefined) t.username = String(body.username || '').trim();
      if (typeof body.enabled === 'boolean') t.enabled = body.enabled;
      store.saveSoon();
      return json(res, 200, { ok: true, id: t.id });
    }

    if (req.method === 'POST' && p === '/api/admin/push/targets/delete') {
      const body = await readBody(req);
      const c = db.config;
      const idx = (c.pushTargets || []).findIndex(function (x) { return x.id === body.id; });
      if (idx < 0) return json(res, 404, { error: 'not found' });
      c.pushTargets.splice(idx, 1);
      store.saveSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/admin/push/test') {
      const body = await readBody(req);
      let t;
      if (body.target && body.target.type) {
        t = body.target;
        if (!core.pusher.adapterFor(t.type)) return json(res, 400, { error: '未知的目标类型' });
      } else {
        t = (db.config.pushTargets || []).find(function (x) { return x.id === body.id; });
        if (!t) return json(res, 404, { error: 'not found' });
      }
      let r;
      try { r = await core.pusher.adapterFor(t.type).test(t); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e).slice(0, 160) }; }
      return json(res, r.ok ? 200 : 502, r);
    }

    if (req.method === 'POST' && p === '/api/admin/push/revoke') {
      const body = await readBody(req);
      const t = (db.config.pushTargets || []).find(function (x) { return x.id === body.id; });
      if (!t) return json(res, 404, { error: 'not found' });
      const adapter = core.pusher.adapterFor(t.type);
      if (!adapter.revokeAll) return json(res, 400, { error: '该类型暂不支持撤回' });
      const byId = {};
      db.entries.forEach(function (e) { byId[e.id] = e.name; });
      const pm = t.pushedMap || {};
      const targetIds = Array.isArray(body.entryIds) && body.entryIds.length
        ? body.entryIds.filter(function (id) { return pm[id] != null; })
        : Object.keys(pm);
      const names = targetIds.map(function (id) { return byId[id] || id; }).filter(Boolean);
      if (!names.length) return json(res, 200, { ok: true, removed: [] });
      let r;
      try { r = await adapter.revokeAll(t, names); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e).slice(0, 160) }; }
      if (r.ok && r.removed && r.removed.length) {
        const removedSet = new Set(r.removed.map(function (n) { return String(n).toLowerCase().replace(/\.js$/i, ''); }));
        targetIds.forEach(function (id) {
          const nm = String(byId[id] || id).toLowerCase().replace(/\.js$/i, '');
          if (removedSet.has(nm)) delete t.pushedMap[id];
        });
        store.saveSoon();
      }
      return json(res, r.ok ? 200 : 502, r);
    }

    if (req.method === 'POST' && p === '/api/admin/push/start') {
      if (core.task.running) return json(res, 409, { error: '已有任务进行中' });
      const body = await readBody(req);
      const wantEntries = Array.isArray(body.entryIds) ? body.entryIds : null;
      const entryCount = db.entries.filter(function (e) {
        const st = e.scriptType || (e.isSource ? 'source' : 'unknown');
        return (!wantEntries || wantEntries.indexOf(e.id) >= 0) &&
          e.status === 'ok' && store.getBody(e) && st !== 'unknown' && !e.sample;
      }).length;
      core.pushAll(ua, '手动', { targets: body.targets, entryIds: body.entryIds })
        .catch(function (e) { console.error('[push]', e); });
      return json(res, 200, { ok: true, started: true, entries: entryCount });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/admin/repos/')) {
      const repo = decodeURIComponent(p.slice('/api/admin/repos/'.length));
      const c = db.config;
      const idx = (c.repos || []).indexOf(repo);
      if (idx < 0) return json(res, 404, { error: 'not found' });
      c.repos.splice(idx, 1);
      store.saveSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/admin/crawl') {
      if (core.task.running) return json(res, 409, { error: '已有任务进行中' });
      core.crawlAll(ua).catch(function (e) { console.error('[crawl]', e); });
      return json(res, 200, { ok: true, started: true });
    }

    if (req.method === 'POST' && p === '/api/admin/check') {
      if (core.task.running) return json(res, 409, { error: '已有任务进行中' });
      core.checkAll(ua).catch(function (e) { console.error('[check]', e); });
      return json(res, 200, { ok: true, started: true });
    }

    if (req.method === 'GET' && p === '/api/admin/schedule') {
      const c = db.config;
      const s = db.sched || {};
      return json(res, 200, {
        cfg: {
          schedEnabled: !!c.schedEnabled,
          schedFreq: c.schedFreq || 'daily', schedInterval: Number(c.schedInterval) || 1,
          schedWeekday: Number(c.schedWeekday) || 1, schedMonthDay: Number(c.schedMonthDay) || 1,
          schedHour: Number(c.schedHour) || 0, schedMinute: Number(c.schedMinute) || 0,
          schedLogKeep: [3, 7, 10, 30].indexOf(Number(c.schedLogKeep)) >= 0 ? Number(c.schedLogKeep) : 10
        },
        state: {
          nextRun: s.nextRun || 0, lastRun: s.lastRun || 0,
          lastResult: s.lastResult || '', lastKind: s.lastKind || '',
          desc: sched.describe(c)
        }
      });
    }

    if (req.method === 'POST' && p === '/api/admin/schedule') {
      const body = await readBody(req);
      const c = db.config;
      if (typeof body.schedEnabled === 'boolean') c.schedEnabled = body.schedEnabled;
      if (typeof body.schedFreq === 'string' && ['daily', 'nday', 'nhour', 'weekly', 'monthly'].indexOf(body.schedFreq) >= 0) c.schedFreq = body.schedFreq;
      if (body.schedInterval != null) c.schedInterval = Math.min(30, Math.max(1, Number(body.schedInterval) || 1));
      if (body.schedWeekday != null) c.schedWeekday = Math.min(6, Math.max(0, Number(body.schedWeekday) || 0));
      if (body.schedMonthDay != null) c.schedMonthDay = Math.min(28, Math.max(1, Number(body.schedMonthDay) || 1));
      if (body.schedHour != null) c.schedHour = Math.min(23, Math.max(0, Number(body.schedHour) || 0));
      if (body.schedMinute != null) c.schedMinute = Math.min(59, Math.max(0, Number(body.schedMinute) || 0));
      if (body.schedLogKeep != null && [3, 7, 10, 30].indexOf(Number(body.schedLogKeep)) >= 0) c.schedLogKeep = Number(body.schedLogKeep);
      store.saveSoon();
      sched.rearm();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/admin/schedule/run') {
      const r = sched.runNow();
      if (r.error) return json(res, 409, r);
      return json(res, 200, r);
    }

    if (req.method === 'GET' && p === '/api/admin/schedlogs') {
      return json(res, 200, sched.listSchedLogs(Number(q.page) || 1));
    }

    if (req.method === 'GET' && p === '/api/admin/schedlogs/download') {
      const text = sched.getSchedLogText(q.id);
      if (text == null) return json(res, 404, { error: '日志不存在' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }

    if (req.method === 'GET' && p === '/api/admin/export-json') {
      const items = db.entries.map(function (e) { return entryPublic(e); });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="lx-sources-' + new Date().toISOString().slice(0, 10) + '.json"'
      });
      return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), total: items.length, items: items }, null, 2));
    }

    if (req.method === 'GET' && p === '/api/admin/logs') {
      return json(res, 200, { logs: db.logs.slice(-80).reverse() });
    }

    if (req.method === 'GET' && p === '/api/admin/entries') {
      const list = filterEntries(q);
      return json(res, 200, {
        items: list.map(function (e) {
          return Object.assign(entryPublic(e), { primaryUrl: e.primaryUrl, urls: e.urls, bodySize: e.bodySize, originRepo: e.originRepo || '' });
        })
      });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/admin/entries/')) {
      const id = p.split('/').pop();
      const idx = db.entries.findIndex(function (e) { return e.id === id; });
      if (idx < 0) return json(res, 404, { error: 'not found' });
      db.entries.splice(idx, 1);
      store.saveSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/admin/import') {
      const body = await readBody(req);
      const urlStr = String(body.url || '').trim();
      if (!/^https?:\/\//.test(urlStr)) return json(res, 400, { error: '无效 URL' });
      const r = await core.crawlFetch(urlStr, { cfg: db.config, ua: ua, timeout: 10000 });
      if (!r.ok || !r.text) return json(res, 502, { error: '拉取失败: ' + (r.error || r.status) });
      const fname = decodeURIComponent(urlStr.split('/').pop().split('?')[0]).replace(/\.(js|zip|txt)$/i, '');
      const meta = core.extractMeta(r.text, fname);
      const e = core.upsertEntry ? null : (function () {
        const id = core.sha1(urlStr);
        let ex = db.entries.find(function (x) { return x.id === id; });
        const now = Date.now();
        const code = r.text.slice(0, 300000);
        if (!ex) {
          ex = {
            id: id, seq: (db.nextSeq = (db.nextSeq || 0) + 1),
            name: body.name || meta.name || fname || '(未命名)',
            author: body.author || meta.author || '', version: body.version || meta.version || '',
            platforms: (body.platforms && body.platforms.length) ? body.platforms : core.detectPlatforms(code),
            urls: Array.from(new Set([urlStr].concat(core.extractLinks(code)))).slice(0, 20),
            primaryUrl: urlStr, isSource: body.isSource !== false && core.isSourceScript(code),
            status: 'unknown', failStreak: 0, origin: '后台导入',
            firstSeenAt: now, updatedAt: now, lastCheckAt: 0, lastOkAt: 0
          };
          store.attachBody(ex, code);
          db.entries.push(ex);
        } else {
          store.attachBody(ex, code);
          ex.updatedAt = now;
        }
        store.saveSoon();
        return ex;
      })();
      return json(res, 200, { ok: true, id: e.id });
    }
    return json(res, 404, { error: 'not found' });
  }

  return json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    if (p === '/index.html' && store.getDb().config.externalDeploy) {
      const html = buf.toString('utf8').replace(/<!--scan-->[\s\S]*?<!--\/scan-->/g, '');
      buf = Buffer.from(html, 'utf8');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }
  if (url.pathname.startsWith('/api/')) {
    Promise.resolve(handleApi(req, res, url)).catch(function (e) {
      if (!e || e.status !== 413) console.error('[api]', e);
      try { json(res, (e && e.status) || 500, { error: e.message }); } catch (_) { /* noop */ }
    });
  } else {
    serveStatic(req, res, url);
  }
});

store.getDb();
sched.arm();

server.listen(PORT, HOST, function () {
  console.log('[yy-lx-hub] listening on http://localhost:' + PORT);
  console.log('[yy-lx-hub] data dir: ' + store.DATA_DIR);
});
