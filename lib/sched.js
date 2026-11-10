'use strict';
// yy-lx-hub 定时任务调度器
const store = require('./store');
const core = require('./core');

let timer = null;
let ticking = false;
const TICK_MS = 30 * 1000;
const BUSY_RETRY_MS = 10 * 60 * 1000;
const DAY = 24 * 3600 * 1000;
const SCHEDLOG_PAGE = 5;
const KEEP_OPTS = [3, 7, 10, 30];

function cfg() { return store.getDb().config; }
function st() { const db = store.getDb(); if (!db.sched) db.sched = {}; return db.sched; }
function slogList() { const db = store.getDb(); if (!Array.isArray(db.schedLogs)) db.schedLogs = []; return db.schedLogs; }
function keepNum() { const k = Number(cfg().schedLogKeep); return KEEP_OPTS.indexOf(k) >= 0 ? k : 10; }

function pad2(n) { return ('0' + n).slice(-2); }
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function schedLogText(entry, captured) {
  const lines = [
    '# yy-lx-hub 定时任务运行日志',
    '# 触发方式: ' + (entry.trigger || ''),
    '# 开始时间: ' + fmtTs(entry.startedAt),
    '# 完成时间: ' + fmtTs(entry.at || Date.now()),
    '# 运行状态: ' + entry.status,
    '# ----------------------------------------'
  ];
  for (let i = 0; i < captured.length; i++) {
    const t = new Date(captured[i].t);
    lines.push(pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) + ' ' + captured[i].msg);
  }
  return lines.join('\r\n') + '\r\n';
}

function healInterrupted() {
  const list = slogList();
  if (list.length && list[0] && list[0].status === '运行中') {
    list[0].status = '中断（宿主重启/异常退出）';
    list[0].text = (list[0].text || '') + '# 注: 服务在链运行期间退出，本次运行未正常收尾\r\n';
    store.saveNow();
    store.log('[定时任务] 上次运行未正常收尾（服务退出），已标记为中断');
  }
}

async function runChain(trigger) {
  const entry = {
    id: Date.now() + '-' + Math.floor(Math.random() * 1e4),
    at: 0,
    startedAt: Date.now(),
    trigger: trigger,
    status: '运行中',
    text: ''
  };
  entry.text = schedLogText(entry, []);
  const list = slogList();
  list.unshift(entry);
  const keep = keepNum();
  while (list.length > keep) list.pop();
  store.saveNow();
  store.beginCapture();
  store.log('[' + trigger + '] 开始执行：动态雷达巡航 + 沙箱实测 + API 萃取');
  try {
    await core.crawlAll(core.DEFAULT_UA, trigger);
    if (!cfg().autoCheck) await core.checkAll(core.DEFAULT_UA, trigger);
    entry.status = '完成';
  } catch (e) {
    entry.status = '异常终止';
    store.log('[定时任务] 执行异常: ' + (e && e.message ? e.message : String(e)));
  }
  entry.at = Date.now();
  entry.text = schedLogText(entry, store.endCapture());
  st().lastResult = entry.status === '完成'
    ? (core.task.stats || '完成') + ' · ' + (trigger === '手动' ? '手动触发' : describe(cfg()))
    : entry.status;
  store.log('[' + trigger + '] 执行结束：' + entry.status);
  store.saveNow();
}

async function tick() {
  if (ticking) return;
  const c = cfg();
  if (!c.schedEnabled) return;
  const s = st();
  ticking = true;
  try {
    const now = Date.now();
    if (!s.nextRun) { s.nextRun = computeNext(c); store.saveSoon(); return; }
    if (now < s.nextRun) return;
    if (core.task.running) {
      s.nextRun = now + BUSY_RETRY_MS;
      store.log('[定时任务] 到点但有任务进行中，10 分钟后重试');
      store.saveSoon();
      return;
    }
    s.lastRun = now;
    s.lastKind = 'crawl+check+extract';
    await runChain('定时');
  } finally {
    const s2 = st();
    s2.running = false;
    s2.nextRun = computeNext(cfg());
    store.saveSoon();
    ticking = false;
  }
}

function atHm(base, h, m) {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function computeNext(c) {
  const base = Math.max(Date.now(), st().lastRun || 0);
  const h = Math.min(23, Math.max(0, Number(c.schedHour) || 0));
  const m = Math.min(59, Math.max(0, Number(c.schedMinute) || 0));
  const n = Math.max(1, Number(c.schedInterval) || 1);
  const freq = c.schedFreq || 'daily';

  if (freq === 'nhour') return base + n * 3600 * 1000;
  let cand = atHm(base, h, m);
  if (cand <= base) cand = atHm(base + DAY, h, m);
  if (freq === 'daily') return cand;
  if (freq === 'nday') {
    let t = atHm(st().lastRun ? (st().lastRun + n * DAY) : cand, h, m);
    while (t <= Date.now()) t += n * DAY;
    return t;
  }
  if (freq === 'weekly') {
    const wd = Math.min(6, Math.max(0, Number(c.schedWeekday) || 0));
    let t = cand;
    for (let i = 0; i < 8; i++) { if (new Date(t).getDay() === wd && t > base) break; t = atHm(t + DAY, h, m); }
    return t;
  }
  if (freq === 'monthly') {
    const md = Math.min(28, Math.max(1, Number(c.schedMonthDay) || 1));
    for (let i = 0; i < 13; i++) {
      const d = new Date(base);
      d.setMonth(d.getMonth() + i);
      d.setDate(md);
      const t = atHm(d.getTime(), h, m);
      if (t > base) return t;
    }
    return cand;
  }
  return cand;
}

function describe(c) {
  const n = Math.max(1, Number(c.schedInterval) || 1);
  const hm = (Math.min(23, Math.max(0, Number(c.schedHour) || 0)) + ':' + ('0' + Math.min(59, Math.max(0, Number(c.schedMinute) || 0))).slice(-2));
  const map = {
    daily: '每天 ' + hm,
    nday: '每 ' + n + ' 天 ' + hm,
    nhour: '每 ' + n + ' 小时',
    weekly: '每周' + '日一二三四五六'[Math.min(6, Math.max(0, Number(c.schedWeekday) || 0))] + ' ' + hm,
    monthly: '每月 ' + Math.min(28, Math.max(1, Number(c.schedMonthDay) || 1)) + ' 日 ' + hm
  };
  return map[c.schedFreq || 'daily'] || map.daily;
}

function arm() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, TICK_MS);
  tick();
}

function rearm() {
  const c = cfg();
  const s = st();
  if (c.schedEnabled) {
    s.nextRun = computeNext(c);
    store.log('[定时任务] 设置已保存，下次执行: ' + new Date(s.nextRun).toLocaleString());
  } else {
    s.nextRun = 0;
    store.log('[定时任务] 已停用');
  }
  store.saveSoon();
}

function runNow() {
  if (core.task.running) return { error: '已有任务进行中' };
  const s = st();
  s.lastRun = Date.now();
  s.lastKind = 'crawl+check+extract';
  store.saveSoon();
  runChain('手动').catch(function () {});
  return { ok: true, started: true };
}

function listSchedLogs(page) {
  const list = slogList();
  const pages = Math.max(1, Math.ceil(list.length / SCHEDLOG_PAGE));
  const p = Math.min(pages, Math.max(1, Number(page) || 1));
  const rows = [];
  for (let i = (p - 1) * SCHEDLOG_PAGE; i < list.length && i < p * SCHEDLOG_PAGE; i++) {
    const r = list[i];
    rows.push({ id: r.id, at: r.at, startedAt: r.startedAt, trigger: r.trigger, status: r.status });
  }
  return { total: list.length, page: p, pages: pages, pageSize: SCHEDLOG_PAGE, list: rows, keep: keepNum() };
}

function getSchedLogText(id) {
  const list = slogList();
  for (let i = 0; i < list.length; i++) {
    if (String(list[i].id) === String(id)) return list[i].text || '';
  }
  return null;
}

healInterrupted();

module.exports = { arm, rearm, runNow, describe, computeNext, listSchedLogs, getSchedLogText };
