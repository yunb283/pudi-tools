export const NEUTRAL = 128;
export const FLOW_SIZES = [512, 1024, 2048, 4096];
export const wrap = (v, size) => ((v % size) + size) % size;
export const decodeFlow = (v) => (v - NEUTRAL) / (v < NEUTRAL ? 128 : 127);
export const encodeFlow = (v) => Math.round(NEUTRAL + v * (v < 0 ? 128 : 127));
export const flipFlow = (v) => encodeFlow(-decodeFlow(v));

// Separable box blur. Read the entire source when sampling a selection boundary,
// but write only the selected pixels. In tiled mode both passes wrap.
export function featherFlow(data, width, height, radius, region, tiled) {
  const { x, y, w, h, mask } = region;
  const tmp = new Float32Array(w * (h + 2 * radius));
  const prefix = new Float64Array(Math.max(width + 2 * radius, h + 2 * radius) + 1);
  for (let ch = 0; ch < 2; ch++) {
    for (let row = 0; row < h + 2 * radius; row++) {
      const sy = y + row - radius;
      if (!tiled && (sy < 0 || sy >= height)) continue;
      const start = tiled ? x - radius : Math.max(0, x - radius);
      const end = tiled ? x + w + radius : Math.min(width, x + w + radius);
      const offset = (sy < 0 || sy >= height ? wrap(sy, height) : sy) * width;
      for (let col = start; col < end; col++) {
        const sx = col < 0 || col >= width ? wrap(col, width) : col;
        prefix[col - start + 1] = prefix[col - start] + data[(offset + sx) * 2 + ch];
      }
      for (let i = 0; i < w; i++) {
        const a = Math.max(start, x + i - radius);
        const b = Math.min(end, x + i + radius + 1);
        tmp[row * w + i] = (prefix[b - start] - prefix[a - start]) / (b - a);
      }
    }
    for (let col = 0; col < w; col++) {
      for (let row = 0; row < h + 2 * radius; row++) {
        prefix[row + 1] = prefix[row] + tmp[row * w + col];
      }
      for (let row = 0; row < h; row++) {
        if (mask && !mask[row * w + col]) continue;
        const a = tiled ? row : Math.max(row, radius - y);
        const b = tiled ? row + 2 * radius + 1 : Math.min(row + 2 * radius + 1, height - y + radius);
        data[((y + row) * width + x + col) * 2 + ch] = Math.round((prefix[b] - prefix[a]) / (b - a));
      }
    }
  }
}

// Work on channel bytes in linear space. Area sampling for downscaling and
// bilinear sampling for upscaling; the latter wraps at tile boundaries.
export function resizeFlow(data, width, height, w, h, tiled) {
  if (width === w && height === h) return data.slice();
  function weights(from, to) {
    const ratio = from / to;
    return Array.from({ length: to }, (_, i) => {
      const result = [];
      if (ratio >= 1) {
        for (let j = Math.floor(i * ratio); j < Math.min(from, Math.ceil((i + 1) * ratio)); j++) {
          result.push([j, (Math.min(j + 1, (i + 1) * ratio) - Math.max(j, i * ratio)) / ratio]);
        }
      } else {
        const center = (i + 0.5) * ratio - 0.5;
        const a = Math.floor(center);
        const address = (j) => tiled ? wrap(j, from) : Math.max(0, Math.min(from - 1, j));
        result.push([address(a), 1 - (center - a)], [address(a + 1), center - a]);
      }
      return result;
    });
  }
  const xs = weights(width, w), ys = weights(height, h);
  const row = new Float64Array(w * 2);
  const sum = new Float64Array(w * 2);
  let cachedRow = -1;
  function sampleRow(y) {
    if (cachedRow === y) return;
    cachedRow = y;
    row.fill(0);
    for (let x = 0; x < w; x++) {
      for (const [sx, weight] of xs[x]) {
        const src = (y * width + sx) * 2;
        row[x * 2] += data[src] * weight;
        row[x * 2 + 1] += data[src + 1] * weight;
      }
    }
  }
  const out = new Uint8Array(w * h * 2);
  for (let y = 0; y < h; y++) {
    sum.fill(0);
    for (const [sy, weight] of ys[y]) {
      sampleRow(sy);
      for (let i = 0; i < sum.length; i++) sum[i] += row[i] * weight;
    }
    const offset = y * w * 2;
    for (let i = 0; i < sum.length; i++) out[offset + i] = Math.round(sum[i]);
  }
  return out;
}

const MAGIC = new TextEncoder().encode('PUDIFLOW');
const HEADER = MAGIC.length + 4;
const MAX_BASE_BYTES = 24 * 1024 * 1024;

export function packFlowProject(size, data, settings, base) {
  if ((base?.size || 0) > MAX_BASE_BYTES) throw new Error('工程底图超过 24 MB');
  const metadata = new TextEncoder().encode(JSON.stringify({ version: 1, size, settings }));
  const header = new Uint8Array(HEADER);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(MAGIC.length, metadata.length, true);
  return new Blob([header, metadata, data, ...(base ? [base] : [])]);
}

export function unpackFlowProject(bytes) {
  if (bytes.length < HEADER || !MAGIC.every((v, i) => bytes[i] === v)) throw new Error('不是 Flowmap 工程文件');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length, true);
  if (!length || length > 16384 || HEADER + length > bytes.length) throw new Error('工程参数不完整');
  const { version, size, settings } = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER, HEADER + length)));
  if (version !== 1 || !FLOW_SIZES.includes(size)) throw new Error('不支持的工程版本或尺寸');
  const start = HEADER + length;
  const end = start + size * size * 2;
  if (end > bytes.length || bytes.length - end > MAX_BASE_BYTES) throw new Error('工程像素或底图数据不完整');
  return { size, settings, data: bytes.subarray(start, end), base: bytes.subarray(end) };
}
