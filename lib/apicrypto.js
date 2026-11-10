'use strict';
// 零依赖认证加密工具 (PBKDF2-HMAC-SHA256 + SHA256-CTR + Encrypt-then-MAC HMAC-SHA256)
// 与 Amusic Python 端 api_crypto.py 字节级严格互通，确保公网中转密文不可伪造、不可窥探。

const crypto = require('crypto');

const VERSION = 1;
const ALG = 'PBKDF2-SHA256-CTR-HMAC';
const DEFAULT_ITER = 100000;
const AAD_PREFIX = Buffer.from('yy-lx-hub:v1:', 'utf8');
const BUILTIN_SYNC_KEY = 'yy-lx-hub::amusic::auto-sync-v1';

function getSyncSecret() {
  return String(process.env.AMUSIC_SYNC_KEY || process.env.AMUSIC_SYNC_SECRET || BUILTIN_SYNC_KEY).trim();
}

function deriveKeys(secret, salt, iter) {
  const dk = crypto.pbkdf2Sync(Buffer.from(String(secret), 'utf8'), salt, iter, 64, 'sha256');
  return {
    encKey: dk.subarray(0, 32),
    macKey: dk.subarray(32, 64)
  };
}

function ctrXor(encKey, nonce, inputBuf) {
  const out = Buffer.allocUnsafe(inputBuf.length);
  const ctrBuf = Buffer.allocUnsafe(4);
  let offset = 0;
  let counter = 0;
  while (offset < inputBuf.length) {
    ctrBuf.writeUInt32BE(counter >>> 0, 0);
    const block = crypto.createHash('sha256').update(encKey).update(nonce).update(ctrBuf).digest();
    const take = Math.min(32, inputBuf.length - offset);
    for (let i = 0; i < take; i++) {
      out[offset + i] = inputBuf[offset + i] ^ block[i];
    }
    offset += take;
    counter++;
  }
  return out;
}

function computeMac(macKey, salt, nonce, ct) {
  return crypto.createHmac('sha256', macKey)
    .update(AAD_PREFIX)
    .update(salt)
    .update(nonce)
    .update(ct)
    .digest();
}

/**
 * 将 JSON 对象或字符串加密为自包含认证密文信封。
 * @param {object|string|Buffer} data
 * @param {string} secret
 * @param {object} [opts]
 * @returns {object}
 */
function encryptJson(data, secret, opts) {
  const keyStr = String(secret || '').trim();
  if (!keyStr) throw new Error('缺少加密密钥 AMUSIC_SYNC_KEY');
  const iter = (opts && Number(opts.iter)) || DEFAULT_ITER;
  const plain = Buffer.isBuffer(data)
    ? data
    : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');

  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(16);
  const keys = deriveKeys(keyStr, salt, iter);
  const ct = ctrXor(keys.encKey, nonce, plain);
  const mac = computeMac(keys.macKey, salt, nonce, ct);

  return {
    v: VERSION,
    alg: ALG,
    iter: iter,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
    mac: mac.toString('base64')
  };
}

/**
 * 验证 MAC 并解密密文信封为 JSON 对象。
 * @param {object|string} envelopeOrStr
 * @param {string} secret
 * @returns {any}
 */
function decryptJson(envelopeOrStr, secret) {
  const keyStr = String(secret || '').trim();
  if (!keyStr) throw new Error('缺少解密密钥 AMUSIC_SYNC_KEY');
  const env = typeof envelopeOrStr === 'string' ? JSON.parse(envelopeOrStr) : envelopeOrStr;
  if (!env || env.v !== VERSION || env.alg !== ALG) {
    throw new Error('不支持的密文格式或版本');
  }
  const iter = Number(env.iter);
  if (!Number.isInteger(iter) || iter < 10000 || iter > 1000000) {
    throw new Error('非法的 PBKDF2 迭代次数');
  }
  const salt = Buffer.from(String(env.salt || ''), 'base64');
  const nonce = Buffer.from(String(env.nonce || ''), 'base64');
  const ct = Buffer.from(String(env.ct || ''), 'base64');
  const mac = Buffer.from(String(env.mac || ''), 'base64');
  if (salt.length !== 16 || nonce.length !== 16 || mac.length !== 32) {
    throw new Error('密文字段长度无效');
  }

  const keys = deriveKeys(keyStr, salt, iter);
  const expectedMac = computeMac(keys.macKey, salt, nonce, ct);
  if (!crypto.timingSafeEqual(mac, expectedMac)) {
    throw new Error('密文完整性校验失败（密钥错误或数据已被篡改）');
  }

  const plain = ctrXor(keys.encKey, nonce, ct);
  return JSON.parse(plain.toString('utf8'));
}

module.exports = {
  VERSION,
  ALG,
  DEFAULT_ITER,
  BUILTIN_SYNC_KEY,
  getSyncSecret,
  encryptJson,
  decryptJson
};
