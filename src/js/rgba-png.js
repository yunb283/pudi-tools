const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

function chunk(name, data) {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < out.length - 4; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ out[i]) & 255];
  view.setUint32(out.length - 4, crc ^ 0xffffffff);
  return out;
}

// Canvas stores premultiplied pixels. Encode the straight RGBA normal values
// directly so a low alpha channel cannot change the direction of a normal.
export async function encodeRgbaPng({ width, height, data }) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;

  const row = width * 4;
  const filtered = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (row + 1);
    const input = y * row;
    filtered[start] = 1; // Sub filter
    filtered.set(data.subarray(input, input + 4), start + 1);
    for (let x = 4; x < row; x++) filtered[start + 1 + x] = data[input + x] - data[input + x - 4];
  }
  const stream = new Blob([filtered]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const png = new Blob([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array()),
  ]);
  return new Uint8Array(await png.arrayBuffer());
}
