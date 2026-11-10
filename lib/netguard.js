'use strict';
// 出网防护与重定向追踪：防止沙箱脚本 SSRF 访问内网/云元数据，同时支持记录重定向链供嗅探器因果分析。
const dns = require('dns').promises;

function isPrivateIp(host) {
  const h = String(host || '').toLowerCase();
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (a.some(function (n) { return n > 255; })) return true;
  if (a[0] === 127 || a[0] === 10 || a[0] === 0 || a[0] === 100) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  if (a[0] === 169 && a[1] === 254) return true;
  return false;
}

const resolveCache = new Map();
async function assertPublicHost(hostname, cache) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) throw new Error('空主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('内网主机名，已拦截: ' + host);
  }
  if (isPrivateIp(host)) throw new Error('私网/保留地址，已拦截: ' + host);
  const c = cache || resolveCache;
  if (c.has(host)) {
    const v = c.get(host);
    if (v.private) throw new Error('域名解析到私网地址，已拦截: ' + host);
    return;
  }
  let addrs = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    c.set(host, { private: true });
    throw new Error('DNS 解析失败，已拦截: ' + host);
  }
  let privateHit = false;
  for (const a of addrs) {
    let ip = a.address;
    if (/^::ffff:/.test(ip)) ip = ip.slice(7);
    if (isPrivateIp(ip)) { privateHit = true; break; }
  }
  c.set(host, { private: privateHit });
  if (c.size > 2000) c.clear();
  if (privateHit) throw new Error('域名解析到私网地址，已拦截: ' + host);
}

/**
 * 沙箱安全 fetch：每跳私网校验 + 手动跟随重定向 + 强制单跳超时保护（防止挂死）。
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<Response>}
 */
async function safeFetch(url, opts) {
  opts = opts || {};
  const cache = opts.hostCache || resolveCache;
  const timeoutMs = Math.min(20000, Math.max(1000, Number(opts.timeout) || 8000));
  const redirectChain = [];
  let cur = String(url);
  let res = null;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(cur);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('非法协议: ' + u.protocol);
    }
    await assertPublicHost(u.hostname, cache);
    const fetchOpts = {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      redirect: 'manual',
      signal: opts.signal || AbortSignal.timeout(timeoutMs)
    };
    if (opts.body != null && fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD') {
      fetchOpts.body = opts.body;
    }
    res = await fetch(cur, fetchOpts);
    redirectChain.push({ status: res.status, url: cur, location: res.headers.get('location') || '' });
    if ([301, 302, 303, 307, 308].indexOf(res.status) >= 0) {
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, cur);
      try { await res.arrayBuffer(); } catch (e) { /* 释放连接 */ }
      cur = next.toString();
      continue;
    }
    break;
  }
  if (res) {
    res._finalUrl = cur;
    res._redirectChain = redirectChain;
  }
  return res;
}

module.exports = { isPrivateIp, assertPublicHost, safeFetch };
