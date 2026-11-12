// Parsers expand triangles; rebuild stable preview vertex IDs from rest positions.
const vertices = new WeakMap();
export function previewVertices(positions) {
  if (vertices.has(positions)) return vertices.get(positions);
  const ids = new Uint32Array(positions.length / 3), map = new Map();
  for (let i = 0; i < ids.length; i++) {
    const key = [0,1,2].map(k => Math.round(positions[i*3+k] * 1e6)).join(',');
    if (!map.has(key)) map.set(key, map.size);
    ids[i] = map.get(key);
  }
  vertices.set(positions, ids);
  return ids;
}
const seamCache = new WeakMap();
// One flag per triangle edge. Open boundaries and discontinuous UVs are seams.
export function uvSeamFlags(positions, uv) {
  let cached = seamCache.get(uv);
  if (cached?.positions === positions) return cached.flags;
  const ids = previewVertices(positions), edges = new Map(), flags = new Uint8Array(uv.length / 2);
  if (ids.length !== flags.length) throw new Error('UV 与模型顶点数量不一致');
  for (let t=0;t<ids.length/3;t++) for(let j=0;j<3;j++) {
    let a=t*3+j,b=t*3+(j+1)%3;
    if(ids[a]>ids[b]) [a,b]=[b,a];
    const key=ids[a]+':'+ids[b];
    const signature=[uv[a*2],uv[a*2+1],uv[b*2],uv[b*2+1]].map(v=>Math.round(v*1e6)).join(',');
    let edge=edges.get(key);if(!edge)edges.set(key,edge={signature,seam:false,indices:[]});
    edge.indices.push(t*3+j);if(edge.signature!==signature)edge.seam=true;
  }
  for(const edge of edges.values())if(edge.seam||edge.indices.length!==2)for(const i of edge.indices)flags[i]=1;
  seamCache.set(uv,{positions,flags});return flags;
}
