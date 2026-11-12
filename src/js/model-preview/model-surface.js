import { UV_COLORS } from './model-uv.js';

export const MODEL_LINE_WIDTH = 1;
export const NORMAL_ARROW_COLORS = ['#ffad62', '#58e784'];
const WIRE_RGB = [124 / 255, 224 / 255, 1];
const WHITE_RGB = [1, 1, 1];
const hexToRgb = color => color.match(/\w\w/g).map(hex => parseInt(hex, 16) / 255);
const SEAM_RGB = hexToRgb(UV_COLORS.seam);
const NORMAL_ARROW_RGB = NORMAL_ARROW_COLORS.map(hexToRgb);

// Render the model surface in one multisampled buffer. The rasterizer assigns
// a sample on a shared edge to just one triangle, including transparent faces.
const VERTEX_SHADER = `
attribute vec4 aPosition;
attribute vec3 aUv;
attribute vec4 aColor;
uniform vec2 uSize;
varying vec3 vUv;
varying vec4 vColor;
void main() {
  vec2 clip = aPosition.xy / uSize * vec2(2.0, -2.0) + vec2(-1.0, 1.0);
  gl_Position = vec4(clip * aPosition.z, aPosition.w * aPosition.z, aPosition.z);
  vUv = aUv;
  vColor = aColor;
}`;

const FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D uTexture;
uniform bool uAdditive;
varying vec3 vUv;
varying vec4 vColor;
void main() {
  if (vUv.z > 1.5) {
    gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
  } else if (vUv.z > 0.5) {
    if (any(lessThan(vUv.xy, vec2(0.0))) || any(greaterThan(vUv.xy, vec2(1.0)))) discard;
    vec4 texel = texture2D(uTexture, vUv.xy);
    float light = uAdditive ? 1.0 : 0.5 + 0.5 * vColor.a;
    gl_FragColor = vec4(texel.rgb * light, texel.a);
  } else {
    gl_FragColor = vec4(vColor.rgb * vColor.a, 1.0);
  }
}`;

function createSurface() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, depth: true, stencil: false });
  if (!gl) return null;
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  for (const [name, count, offset] of [['aPosition', 4, 0], ['aUv', 3, 4], ['aColor', 4, 7]]) {
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, count, gl.FLOAT, false, 11 * 4, offset * 4);
  }
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  // Keep the sampler complete even when drawing a model without a texture.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  canvas.addEventListener('webglcontextlost', (event) => event.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => {
    if (surface?.canvas === canvas) surface = undefined;
  });
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '';
  return {
    software: /SwiftShader|WARP|llvmpipe|Microsoft Basic Render/i.test(renderer),
    canvas, gl, pixels: null, vertices: new Float32Array(0),
    size: gl.getUniformLocation(program, 'uSize'), additive: gl.getUniformLocation(program, 'uAdditive'),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxViewport: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
  };
}

let surface;
export function rasterizeModelSurface(ctx, width, height, {
  order, px, py, texWeights, vertexDepth, nearest, farthest, uv, tex, colors, lighting, mode, uvWire, uvSeams, isPicked, hasPicks, pickCount, depthTest, normalSegments,
}) {
  if (typeof document === 'undefined' || !ctx.getTransform) return null;
  if (surface === undefined) {
    try { surface = createSurface(); } catch (_) { surface = null; }
  }
  if (!surface || surface.gl.isContextLost()) return null;
  // The software renderer can cost more than Canvas 2D for dense line overlays.
  if (!normalSegments && surface.software && order.length >= 10000 && (mode !== 'solid' || uvWire)) return null;
  const { gl, canvas } = surface;
  const matrix = ctx.getTransform();
  const pw = Math.max(1, Math.round(width * Math.hypot(matrix.a, matrix.b)));
  const ph = Math.max(1, Math.round(height * Math.hypot(matrix.c, matrix.d)));
  if (pw > surface.maxViewport[0] || ph > surface.maxViewport[1] ||
      (tex && Math.max(tex.w, tex.h) > surface.maxTexture)) return null;
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  if (gl.drawingBufferWidth !== pw || gl.drawingBufferHeight !== ph) return null;
  if (tex && surface.pixels !== tex.canvas) {
    surface.pixels = null;
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex.canvas); }
    catch (_) { return null; }
    if (gl.getError() !== gl.NO_ERROR) return null;
    surface.pixels = tex.canvas;
  }
  const shaded = mode !== 'wire';
  const nativeLines = !shaded && !hasPicks && pw === width && ph === height;
  const lineOverlay = mode !== 'solid' || uvWire;
  const verticesPerFace = (shaded ? 3 : 0) + (lineOverlay ? (nativeLines ? 6 : 18) : 0);
  const length = Math.min(1_200_000 * 11, (order.length * verticesPerFace + Math.min(order.length, pickCount) * 21) * 11);
  const capacity = Math.max(length, normalSegments ? 512 * 6 * 11 : 0);
  if (surface.vertices.length < capacity) surface.vertices = new Float32Array(capacity);
  const data = surface.vertices;
  let offset = 0, drawn = 0;
  const flush = (primitive = nativeLines ? gl.LINES : gl.TRIANGLES) => {
    if (!offset) return;
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, offset), gl.DYNAMIC_DRAW);
    gl.drawArrays(primitive, 0, offset / 11);
    offset = 0;
  };
  gl.viewport(0, 0, pw, ph);
  gl.clearColor(0, 0, 0, 0);
  if (depthTest) {
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  } else gl.disable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.uniform2f(surface.size, width, height);
  gl.uniform1i(surface.additive, tex?.additive ? 1 : 0);
  const depthScale = vertexDepth ? 1.9 / Math.max(nearest - farthest, 1e-6) : 0;
  const clipDepth = value => .95 - (value - farthest) * depthScale;
  const zAt = (i) => depthTest ? clipDepth(vertexDepth[i]) : 0;
  const overlayVertex = (x, y, color, alpha, z = 0, w = 1) => {
    data[offset++] = x; data[offset++] = y; data[offset++] = w; data[offset++] = z;
    data[offset++] = 0; data[offset++] = 0; data[offset++] = 2;
    data[offset++] = color[0]; data[offset++] = color[1]; data[offset++] = color[2]; data[offset++] = alpha;
  };
  const segmentQuad = (ax, ay, az, bx, by, bz, width, color, alpha) => {
    const dx = bx - ax, dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < 1e-5) return;
    const scale = width * .5 / length;
    const nx = -dy * scale, ny = dx * scale;
    overlayVertex(ax+nx, ay+ny, color, alpha, az);
    overlayVertex(ax-nx, ay-ny, color, alpha, az);
    overlayVertex(bx+nx, by+ny, color, alpha, bz);
    overlayVertex(bx+nx, by+ny, color, alpha, bz);
    overlayVertex(ax-nx, ay-ny, color, alpha, az);
    overlayVertex(bx-nx, by-ny, color, alpha, bz);
  };
  const edgeQuad = (a, b, width, color, alpha) =>
    segmentQuad(px[a], py[a], zAt(a) - 1e-6, px[b], py[b], zAt(b) - 1e-6, width, color, alpha);
  for (const face of order) {
    const a = face * 3, u = face * 6;
    const x0 = px[a], x1 = px[a+1], x2 = px[a+2], y0 = py[a], y1 = py[a+1], y2 = py[a+2];
    if ((x0 < -2 && x1 < -2 && x2 < -2) || (x0 > width+2 && x1 > width+2 && x2 > width+2) ||
        (y0 < -2 && y1 < -2 && y2 < -2) || (y0 > height+2 && y1 > height+2 && y2 > height+2)) continue;
    if (Math.abs((x1-x0)*(y2-y0) - (x2-x0)*(y1-y0)) < .02) continue;
    const picked = hasPicks && isPicked(face);
    if (offset + (verticesPerFace + (picked ? 21 : 0)) * 11 > data.length) flush();
    if (shaded) {
      const mapped = tex && Math.abs((uv[u+2]-uv[u])*(uv[u+5]-uv[u+1]) -
        (uv[u+4]-uv[u])*(uv[u+3]-uv[u+1])) * tex.w * tex.h >= 1e-9;
      const { shade, lights } = lighting(face);
      for (let j = 0; j < 3; j++) {
        data[offset++] = px[a+j]; data[offset++] = py[a+j]; data[offset++] = texWeights?.[a+j] ?? 1; data[offset++] = zAt(a+j);
        data[offset++] = mapped ? uv[u+j*2] : 0;
        data[offset++] = mapped ? uv[u+j*2+1] : 0;
        data[offset++] = mapped ? 1 : 0;
        data[offset++] = colors[a] / 255; data[offset++] = colors[a+1] / 255; data[offset++] = colors[a+2] / 255;
        data[offset++] = lights ? lights[j] : shade;
      }
    }
    if (lineOverlay) {
      for (let j = 0; j < 3; j++) {
        const color = uvWire ? (uvSeams?.[a+j] ? SEAM_RGB : WHITE_RGB) : WIRE_RGB;
        const start = a+j, end = a+(j+1)%3;
        if (nativeLines) {
          overlayVertex(px[start], py[start], color, 1);
          overlayVertex(px[end], py[end], color, 1);
        } else {
          edgeQuad(start, end, MODEL_LINE_WIDTH, color, uvWire || mode === 'wire' ? 1 : .55);
        }
      }
    }
    if (picked) {
      for (let j = 0; j < 3; j++) overlayVertex(px[a+j], py[a+j], WIRE_RGB, .22, zAt(a+j), texWeights?.[a+j] ?? 1);
      for (let j = 0; j < 3; j++) edgeQuad(a+j, a+(j+1)%3, 2.2, WIRE_RGB, 1);
    }
    drawn++;
  }
  flush();
  if (normalSegments) {
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    if (!depthTest) {
      // Wire and translucent surfaces keep their display modes. A depth-only
      // mesh pass prevents their hidden normal arrows from showing through.
      gl.colorMask(false, false, false, false);
      for (const face of order) {
        if (offset + 33 > data.length) flush(gl.TRIANGLES);
        for (let j = 0; j < 3; j++) {
          const i = face * 3 + j;
          overlayVertex(px[i], py[i], WHITE_RGB, 1, clipDepth(vertexDepth[i]));
        }
      }
      flush(gl.TRIANGLES);
      gl.colorMask(true, true, true, true);
    }
    gl.depthMask(false);
    const glyphDepth = z => Math.max(-.9999, Math.min(.9999, clipDepth(z) - 1e-5));
    for (const [x, y, z, endX, endY, endZ, color] of normalSegments()) {
      if (offset + 66 > data.length) flush(gl.TRIANGLES);
      segmentQuad(x, y, glyphDepth(z), endX, endY, glyphDepth(endZ), .91, NORMAL_ARROW_RGB[color], 1);
    }
    flush(gl.TRIANGLES);
    gl.depthMask(true);
  }
  if (gl.isContextLost()) return null;
  ctx.drawImage(canvas, 0, 0, width, height);
  return drawn;
}
