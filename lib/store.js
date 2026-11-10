'use strict';
// yy-lx-hub 数据存储：冷热分离（db.json 仅存轻量索引与状态，脚本正文按 SHA256 独立落盘），原子写入防损坏。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SCRIPTS_DIR = path.join(DATA_DIR, 'scripts');

function loadLocalBuiltinRepos() {
  try {
    const p = path.join(ROOT_DIR, 'builtin-repos.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && Array.isArray(j.repos)) {
      return j.repos.map(function (r) { return String(r && (r.repo || r) || '').trim(); })
        .filter(function (r) { return /^[\w.\-]+\/[\w.\-]+$/.test(r); });
    }
  } catch (e) { /* fallback below */ }
  return [
    'pdone/lx-music-source',
    'guoyue2010/lxmusic-',
    'LXJ-George666/LXMusic-Yinyuan',
    'Macrohard0001/lx-ikun-music-sources',
    'NeoDtime/lxmusic-source3',
    'haonanren118/jiexiang-Music-Source',
    'pronii/lx-music-qdy-mini',
    'wzh15802/lxmusic',
    'ShaneLee-9/lx-music-source-merge',
    'kayee0212/lx-music-yinyuan',
    'luanmuc/lx-music-source',
    'Lingeng27/lx-music-1010-source',
    'shiliu6924/lx-music-source',
    'fengs2021/lx-music-merged-source'
  ];
}

const BUILTIN_REPOS = loadLocalBuiltinRepos();

const DEFAULTS = {
  config: {
    proxy: '',
    ghMirror: '',
    forceProxy: false,
    useJsdelivr: false,
    ghToken: '',
    autoCheck: true,
    radarEnabled: true,     // 30天动态 GitHub 雷达开关
    radarDays: 30,          // 动态雷达回溯天数
    batchSize: 60,
    fastMode: false,
    debug: false,
    externalDeploy: false,
    schedEnabled: false,
    schedFreq: 'daily',
    schedInterval: 1,
    schedWeekday: 1,
    schedMonthDay: 1,
    schedHour: 3,
    schedMinute: 0,
    schedLogKeep: 10,
    repos: [],
    blockedRepos: [],
    seeds: [],
    pushTargets: []
  },
  radarRepos: [],     // 动态雷达最近发现的活跃仓库 [{ repo, pushedAt, stars }]
  lastRadarAt: 0,
  repoErrors: {},
  entries: [],
  logs: [],
  runs: [],
  sched: {},
  schedLogs: [],
  lastCrawlAt: null,
  lastCheckAt: null,
  secret: ''
};

let db = null;
let saveTimer = null;

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 内容寻址存储脚本正文，相同正文只存一份文件，避免 db.json 膨胀卡顿。
 * @param {string} body
 * @param {string} [knownSha]
 * @returns {string} sha256
 */
function saveBody(body, knownSha) {
  if (!body) return '';
  ensureDirs();
  const s = knownSha || sha256(body);
  const f = path.join(SCRIPTS_DIR, s + '.js');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, body, 'utf8');
  }
  return s;
}

/**
 * 读取条目的脚本正文（兼容老数据内联 body 与新架构外置文件）。
 * @param {object} entry
 * @returns {string}
 */
function getBody(entry) {
  if (!entry) return '';
  if (entry.body) return entry.body;
  if (!entry.bodySha) return '';
  const f = path.join(SCRIPTS_DIR, entry.bodySha + '.js');
  try {
    return fs.readFileSync(f, 'utf8');
  } catch (e) {
    return '';
  }
}

/**
 * 关联设置条目正文（外置落盘，内存中仅保留 bodySha/bodySize/hasBody）。
 */
function attachBody(entry, code) {
  if (!code) return;
  const s = sha256(code);
  saveBody(code, s);
  entry.bodySha = s;
  entry.bodySize = code.length;
  entry.hasBody = true;
  delete entry.body;
}

/**
 * 清理不再被任何存量条目引用的孤立脚本文件，防止长期运行硬盘膨胀。
 */
function cleanupUnusedScripts(curDb) {
  const target = curDb || db;
  if (!target || !Array.isArray(target.entries)) return 0;
  const activeShas = new Set();
  for (const e of target.entries) {
    if (e && e.bodySha) activeShas.add(e.bodySha + '.js');
  }
  let removed = 0;
  try {
    const files = fs.readdirSync(SCRIPTS_DIR);
    for (const f of files) {
      if (f.endsWith('.js') && !activeShas.has(f)) {
        try { fs.unlinkSync(path.join(SCRIPTS_DIR, f)); removed++; } catch (e) {}
      }
    }
  } catch (e) {}
  return removed;
}

function load() {
  if (db) return db;
  ensureDirs();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { raw = null; }
  db = Object.assign({}, DEFAULTS, raw || {});
  db.config = Object.assign({}, DEFAULTS.config, (raw && raw.config) || {});
  if (db.config.accelPrefix && !db.config.ghMirror) db.config.ghMirror = db.config.accelPrefix;
  if (!Array.isArray(db.entries)) db.entries = [];
  if (!Array.isArray(db.logs)) db.logs = [];
  if (!Array.isArray(db.radarRepos)) db.radarRepos = [];

  // 迁移：将老 db.json 里的内联 body 抽离成独立文件，立竿见影瘦身
  let migrated = false;
  for (const e of db.entries) {
    if (e.body) {
      attachBody(e, e.body);
      migrated = true;
    } else if (e.bodySha && e.hasBody == null) {
      e.hasBody = fs.existsSync(path.join(SCRIPTS_DIR, e.bodySha + '.js'));
    }
  }

  const missing = db.entries.filter(function (e) { return !e.seq; })
    .sort(function (a, b) { return (a.firstSeenAt || 0) - (b.firstSeenAt || 0); });
  if (missing.length || !db.nextSeq) {
    let top = 0;
    for (const e of db.entries) if (e.seq > top) top = e.seq;
    for (const e of missing) e.seq = ++top;
    db.nextSeq = top;
    migrated = true;
  }
  if (!db.secret) {
    db.secret = crypto.randomBytes(24).toString('hex');
    migrated = true;
  }
  if (migrated) saveNow();
  return db;
}

function getGhToken(cfg) {
  return (cfg && cfg.ghToken) || process.env.GITHUB_TOKEN || '';
}

function saveNow() {
  if (!db) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  ensureDirs();
  // 防御性确保没有任何大体积 body 意外落入 db.json
  for (const e of db.entries) {
    if (e.body) attachBody(e, e.body);
  }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try { saveNow(); } catch (e) { console.error('[store] save failed:', e.message); }
  }, 300);
}

function getDb() { return load(); }

let capBuf = null;
let logListener = null;
function beginCapture() { capBuf = []; }
function endCapture() { const r = capBuf || []; capBuf = null; return r; }
function setLogListener(fn) { logListener = typeof fn === 'function' ? fn : null; }

function log(msg) {
  load();
  const line = { t: new Date().toISOString(), msg: String(msg).slice(0, 500) };
  db.logs.push(line);
  if (db.logs.length > 400) db.logs = db.logs.slice(-300);
  if (capBuf) capBuf.push(line);
  if (logListener) {
    try { logListener(line); } catch (e) { /* noop */ }
  }
  if (db.config.debug) appendDebugLog(line);
  saveSoon();
  return line;
}

function appendDebugLog(line) {
  try {
    const dir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(line.t);
    const ymd = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    const hms = [('0' + d.getHours()).slice(-2), ('0' + d.getMinutes()).slice(-2), ('0' + d.getSeconds()).slice(-2)].join(':');
    const msg = String(line.msg);
    const body = msg.startsWith('[') ? msg : (' ' + msg);
    fs.appendFileSync(path.join(dir, ymd + '.log'), '[' + hms + ']' + body + '\n');
  } catch (e) { /* noop */ }
}

function maskSensitive(s) {
  return String(s == null ? '' : s)
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, 'ghp_***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***')
    .replace(/(token=|access_token=)[A-Za-z0-9._\-]{8,}/gi, '$1***');
}

module.exports = {
  ROOT_DIR, DATA_DIR, DB_FILE, SCRIPTS_DIR, BUILTIN_REPOS,
  getDb, getGhToken, saveSoon, saveNow, log, beginCapture, endCapture, setLogListener, maskSensitive,
  saveBody, getBody, attachBody, cleanupUnusedScripts
};
