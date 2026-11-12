// ZIP 归档的最小读取实现：够用就行（.kra / .livp 都是 ZIP）。
//
// 不引第三方库，也不做写操作，只解「找得到中央目录 + 能取成员字节」这一件事。
// 中央目录在文件尾部，所以读归档是从后往前找 EOCD 开始的，不是从头扫。
//
// 覆盖到什么程度：
//   - 压缩方式 0（stored）和 8（deflate）走 DecompressionStream，其余给明确报错；
//   - ZIP64 的扩展字段（成员 >4GB / 条目 >65535）只取真正会用到的那几个值；
//   - 加密位（通用标志 bit 0）直接拒绝：看图场景遇不上，别假装解得开。
// 没覆盖：分卷、数据描述符之外的流式写法（有中央目录就行，能取到真长度）。

const SIG_EOCD = 0x06054b50; // 'PK\x05\x06'
const SIG_CD = 0x02014b50; // 'PK\x01\x02'  中央目录项
const SIG_LH = 0x04034b50; // 'PK\x03\x04'  本地文件头
const SIG_Z64_EOCD = 0x06064b50; // ZIP64 版的 EOCD
const SIG_Z64_LOC = 0x07064b50; // ZIP64 定位器，紧挨在 EOCD 前面

// 注释最长 65535，加上 EOCD 自身 22 字节，往前扫这么多就够了
const EOCD_SCAN = 65557;
const FLAG_ENCRYPTED = 0x0001;

const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0;
}

// 从后往前找 EOCD：注释里可能正好也有这四个字节，所以找到之后要拿注释长度对一下
function findEocd(b) {
  const from = Math.max(0, b.length - EOCD_SCAN);
  for (let o = b.length - 22; o >= from; o--) {
    if (u32(b, o) !== SIG_EOCD) continue;
    const commentLen = u16(b, o + 20);
    if (o + 22 + commentLen === b.length) return o;
  }
  return -1;
}

// ZIP64 的三件事（总条目数、目录偏移、目录大小）在 EOCD 里会被写成 0xFFFF / 0xFFFFFFFF，
// 真值在 ZIP64 EOCD 里。找不到就按 32 位的值用——小文件根本用不上这套。
function readZ64(b, eocd) {
  const loc = eocd - 20;
  if (loc < 0 || u32(b, loc) !== SIG_Z64_LOC) return null;
  const at = Number(readU64(b, loc + 8));
  if (at < 0 || at + 56 > b.length || u32(b, at) !== SIG_Z64_EOCD) return null;
  return { total: readU64(b, at + 32), size: readU64(b, at + 40), offset: readU64(b, at + 48) };
}

function readU64(b, o) {
  let v = 0;
  for (let i = 7; i >= 0; i--) v = v * 256 + b[o + i];
  return v;
}

// 中央目录项里的 ZIP64 扩展字段（0x0001）：原始大小、压缩后大小、本地头偏移依次排列，
// 哪一项溢出了才出现，所以得按「原值是不是 0xFFFFFFFF」逐个往前推
function z64Extra(extra) {
  const out = { size: null, csize: null, offset: null };
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = u16(extra, p);
    const len = u16(extra, p + 2);
    const body = extra.subarray(p + 4, p + 4 + len);
    p += 4 + len;
    if (id !== 0x0001) continue;
    let q = 0;
    const take = () => {
      if (q + 8 > body.length) return null;
      const v = readU64(body, q);
      q += 8;
      return Number(v);
    };
    out.size = take();
    out.csize = take();
    out.offset = take();
    break;
  }
  return out;
}

/**
 * 打开一个 ZIP：读出中央目录里每一项的元信息。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{entries: Array<{name:string, method:number, size:number, csize:number, offset:number, dir:boolean}>, comment:string}|null}
 *          不是 ZIP / 目录坏了就返回 null，不抛异常（调用方一律按「解不开」处理）
 */
export function openZip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 22) return null;
  const eocd = findEocd(b);
  if (eocd < 0) return null;

  const z64 = readZ64(b, eocd);
  let total = u16(b, eocd + 10);
  let cdSize = u32(b, eocd + 12);
  let cdOff = u32(b, eocd + 16);
  if (z64) {
    if (total === 0xffff) total = Number(z64.total);
    if (cdSize === 0xffffffff) cdSize = Number(z64.size);
    if (cdOff === 0xffffffff) cdOff = Number(z64.offset);
  }
  if (cdOff + cdSize > b.length) return null;

  const entries = [];
  let p = cdOff;
  const end = cdOff + cdSize;
  // 条目数只是个上限：目录大小才是真边界，扫到边界就停
  for (let i = 0; i < total && p + 46 <= end; i++) {
    if (u32(b, p) !== SIG_CD) break;
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    let csize = u32(b, p + 20);
    let size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    let offset = u32(b, p + 42);
    if (size === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
      const z = z64Extra(b.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
      if (size === 0xffffffff && z.size != null) size = z.size;
      if (csize === 0xffffffff && z.csize != null) csize = z.csize;
      if (offset === 0xffffffff && z.offset != null) offset = z.offset;
    }
    const nameAt = p + 46;
    const name = decoder
      ? decoder.decode(b.subarray(nameAt, nameAt + nameLen))
      : String.fromCharCode(...b.subarray(nameAt, nameAt + nameLen));
    entries.push({
      name,
      method,
      flags,
      size,
      csize,
      offset,
      dir: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) return null;
  return { entries, bytes: b };
}

/** 按名字取一项（大小写不敏感，Krita / 苹果各自的包大小写不统一） */
export function findZipEntry(zip, name) {
  if (!zip) return null;
  const want = name.toLowerCase();
  return zip.entries.find((e) => e.name.toLowerCase() === want) || null;
}

async function inflateRaw(src) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前环境不支持解压');
  }
  const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/**
 * 取出一个成员的原始字节。
 * @returns {Promise<Uint8Array|null>} 解不开（加密 / 不认识的压缩方式 / 越界）返回 null
 */
export async function readZipEntry(zip, entry) {
  if (!zip || !entry || entry.dir) return null;
  if (entry.flags & FLAG_ENCRYPTED) return null;
  const b = zip.bytes;

  // 长度以中央目录为准：本地头里那两个值在数据描述符模式下是 0（标志位 bit 3）
  const lh = entry.offset;
  if (lh + 30 > b.length || u32(b, lh) !== SIG_LH) return null;
  const nameLen = u16(b, lh + 26);
  const extraLen = u16(b, lh + 28);
  const dataAt = lh + 30 + nameLen + extraLen;
  const csize = entry.csize || entry.size;
  const end = dataAt + csize;
  if (end > b.length) return null;

  const raw = b.subarray(dataAt, end);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  return null;
}

/** 压缩方式 -> 人话（信息面板 / 报错用） */
export function zipMethodName(m) {
  if (m === 0) return '未压缩';
  if (m === 8) return 'Deflate';
  if (m === 9) return 'Deflate64';
  if (m === 12) return 'BZip2';
  if (m === 14) return 'LZMA';
  if (m === 99) return 'AES 加密';
  return `压缩方式 ${m}`;
}
