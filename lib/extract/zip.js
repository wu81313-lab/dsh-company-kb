// 最小可用的 ZIP 读取器：docx / xlsx / pptx 都是 ZIP + XML，
// 自己解析中央目录 + zlib.inflateRawSync 就够用，避免引入第三方依赖。

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('不是有效的 ZIP 文件：找不到中央目录结尾记录');
}

function readZip64End(buffer, eocdOffset) {
  for (let i = eocdOffset - 20; i >= 0 && i > eocdOffset - 4096; i -= 1) {
    if (buffer.readUInt32LE(i) !== EOCD64_LOC_SIG) continue;
    const recordOffset = Number(buffer.readBigUInt64LE(i + 8));
    if (recordOffset + 56 > buffer.length) return null;
    if (buffer.readUInt32LE(recordOffset) !== EOCD64_SIG) return null;
    return {
      entries: Number(buffer.readBigUInt64LE(recordOffset + 32)),
      cdOffset: Number(buffer.readBigUInt64LE(recordOffset + 48)),
    };
  }
  return null;
}

function zip64Extra(extra, wants) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    if (id === 0x0001) {
      const out = {};
      let cursor = 0;
      if (wants.uncompressed && cursor + 8 <= body.length) { out.uncompressedSize = Number(body.readBigUInt64LE(cursor)); cursor += 8; }
      if (wants.compressed && cursor + 8 <= body.length) { out.compressedSize = Number(body.readBigUInt64LE(cursor)); cursor += 8; }
      if (wants.offset && cursor + 8 <= body.length) { out.localOffset = Number(body.readBigUInt64LE(cursor)); cursor += 8; }
      return out;
    }
    offset += 4 + size;
  }
  return {};
}

/**
 * 读取 ZIP 目录。返回 { names, has, read }。
 * read(name) 返回解码后的 Buffer（已解压）。
 */
export function readZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  // EOCD 布局：+8 本盘条目数，+10 总条目数，+12 中央目录大小，+16 中央目录偏移，+20 注释长度
  let entryCount = buffer.readUInt16LE(eocd + 10);
  let cdSize = buffer.readUInt32LE(eocd + 12);
  let cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const zip64 = readZip64End(buffer, eocd);
    if (zip64 !== null) {
      entryCount = zip64.entries;
      cdOffset = zip64.cdOffset;
    }
  }

  const entries = new Map();
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CEN_SIG) break;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const extra = buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const fix = zip64Extra(extra, {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localOffset === 0xffffffff,
      });
      uncompressedSize = fix.uncompressedSize ?? uncompressedSize;
      compressedSize = fix.compressedSize ?? compressedSize;
      localOffset = fix.localOffset ?? localOffset;
    }

    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset, flags });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  function read(name) {
    const entry = entries.get(name);
    if (entry === undefined) return undefined;
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`ZIP 条目过大，已跳过：${name}`);
    if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== LOC_SIG) {
      throw new Error(`ZIP 本地头损坏：${name}`);
    }
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method !== 8) throw new Error(`不支持的压缩方式 ${entry.method}：${name}`);
    return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
  }

  return {
    entries,
    names: () => [...entries.keys()],
    has: name => entries.has(name),
    read,
    readText: name => {
      const data = read(name);
      return data === undefined ? undefined : data.toString('utf8');
    },
  };
}

/** XML 实体解码（含数字实体）。 */
export function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
