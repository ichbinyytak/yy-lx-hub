'use strict';
// 零依赖轻量 ZIP 打包与安全解压工具（基于 Node 内置 zlib）

const zlib = require('zlib');

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const needUtf8 = /[^\x00-\x7F]/.test(f.name);
    const flags = needUtf8 ? 0x0800 : 0;
    let method = 8, data = f.data, comp = zlib.deflateRawSync(f.data, { level: 9 });
    if (comp.length >= data.length) { method = 0; comp = data; }
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([].concat(chunks, [cdBuf, eocd]));
}

/**
 * 安全解析 ZIP Buffer 并提取其中的 .js 脚本文件（通过 Central Directory 定位，防 Zip Bomb）。
 * @param {Buffer} buf
 * @param {object} [opts] { maxFiles, maxEntryBytes }
 * @returns {Array<{name: string, text: string}>}
 */
function extractJsFromZip(buf, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 20;
  const maxEntryBytes = opts.maxEntryBytes || 500000;
  if (!Buffer.isBuffer(buf) || buf.length < 22) return [];

  // 从尾部搜索 End of Central Directory (0x06054b50)
  let eocdPos = -1;
  const minSearch = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= minSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) return [];

  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  if (cdOffset + cdSize > buf.length) return [];

  const out = [];
  let pos = cdOffset;
  for (let idx = 0; idx < totalEntries && pos + 46 <= buf.length; idx++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOff = buf.readUInt32LE(pos + 42);

    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (!/\.js$/i.test(name)) continue;
    if (/(__MACOSX|node_modules|\.min\.js$)/i.test(name)) continue;
    if (uncompSize === 0 || uncompSize > maxEntryBytes || compSize > maxEntryBytes * 2) continue;
    if (localHeaderOff + 30 > buf.length || buf.readUInt32LE(localHeaderOff) !== 0x04034b50) continue;

    const lNameLen = buf.readUInt16LE(localHeaderOff + 26);
    const lExtraLen = buf.readUInt16LE(localHeaderOff + 28);
    const dataStart = localHeaderOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) continue;

    const slice = buf.subarray(dataStart, dataStart + compSize);
    try {
      let raw = null;
      if (method === 0) raw = slice;
      else if (method === 8) raw = zlib.inflateRawSync(slice, { maxOutputLength: maxEntryBytes });
      if (raw && raw.length > 30) {
        out.push({ name: name, text: raw.toString('utf8') });
        if (out.length >= maxFiles) break;
      }
    } catch (e) { /* 忽略损坏条目 */ }
  }
  return out;
}

module.exports = { crc32, buildZip, extractJsFromZip };
