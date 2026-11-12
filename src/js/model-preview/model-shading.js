// Use the stored components without rounding distinct vectors into the same key.
export function vectorKey(values, offset) {
  return `${values[offset]},${values[offset + 1]},${values[offset + 2]}`;
}

// Preserve source hard edges: average only faces explicitly connected by a source group.
export function groupNormals(vertices, faces, groups, bitmask = false) {
  const normals = faces.map(face => {
    const n = [0,0,0];
    for (let j=0;j<face.length;j++) {
      const a=vertices[face[j]], b=vertices[face[(j+1)%face.length]];
      if (!a || !b) continue;
      n[0]+=(a[1]-b[1])*(a[2]+b[2]); n[1]+=(a[2]-b[2])*(a[0]+b[0]); n[2]+=(a[0]-b[0])*(a[1]+b[1]);
    }
    return n;
  });
  const at=new Map();
  faces.forEach((face,f)=>face.forEach(v=>{if(!at.has(v))at.set(v,[]);at.get(v).push(f);}));
  return faces.map((face,f)=>face.map(v=>{
    const n=[0,0,0];
    for(const other of at.get(v)) if(other===f || (groups[f] && (bitmask ? (groups[f]&groups[other])!==0 : groups[f]===groups[other]))) {
      for(let k=0;k<3;k++)n[k]+=normals[other][k];
    }
    const len=Math.hypot(...n)||1;return n.map(x=>x/len);
  }));
}

// Inverse-transpose for normals, including non-uniform node scale.
export function transformNormal(m,n) {
  const a=m[0],b=m[4],c=m[8],d=m[1],e=m[5],f=m[9],g=m[2],h=m[6],i=m[10];
  const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if(Math.abs(det)<1e-15)return [0,0,0];
  const q=[((e*i-f*h)*n[0]+(f*g-d*i)*n[1]+(d*h-e*g)*n[2])/det,
    ((c*h-b*i)*n[0]+(a*i-c*g)*n[1]+(b*g-a*h)*n[2])/det,
    ((b*f-c*e)*n[0]+(c*d-a*f)*n[1]+(a*e-b*d)*n[2])/det];
  const len=Math.hypot(...q)||1;return q.map(v=>v/len);
}

// A linear gradient represents barycentric interpolation of the three corner lights.
export function shadeGradient(ctx, points, values, color, alpha = false) {
  const [x0,y0,x1,y1,x2,y2]=points, [s0,s1,s2]=values;
  const dx1=x1-x0,dy1=y1-y0,dx2=x2-x0,dy2=y2-y0,det=dx1*dy2-dx2*dy1;
  const gx=((s1-s0)*dy2-(s2-s0)*dy1)/det, gy=(dx1*(s2-s0)-dx2*(s1-s0))/det;
  const length=gx*gx+gy*gy;
  const paint=s=>alpha ? `rgba(0,0,0,${(1-s)*.5})` : `rgb(${color.map(v=>Math.round(v*s)).join(',')})`;
  if(!Number.isFinite(length)||length<1e-14)return paint(s0);
  const low=Math.min(...values),high=Math.max(...values);
  const gradient=ctx.createLinearGradient(x0+gx*(low-s0)/length,y0+gy*(low-s0)/length,
    x0+gx*(high-s0)/length,y0+gy*(high-s0)/length);
  gradient.addColorStop(0,paint(low));gradient.addColorStop(1,paint(high));return gradient;
}

// Transport authored corner normals with each deformed face, averaging only within
// the original normal fans. Coincident corners with different normals stay split.
export function poseCornerNormals(model) {
  if (!model.hasSourceNormals) return;
  const unit=v=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l);};
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const frame=(p,o)=>{
    const a=[0,1,2].map(k=>p[o+3+k]-p[o+k]),b=[0,1,2].map(k=>p[o+6+k]-p[o+k]);
    const x=unit(a),z=unit(cross(a,b));return [x,cross(z,x),z];
  };
  if (!model.normalFans) {
    const ids=new Map();model.normalFans=new Uint32Array(model.pos.length/3);
    for(let i=0;i<model.normalFans.length;i++){
      if (!model.sourceNormalMask[i]) continue;
      const offset=i*3;
      const key=`${vectorKey(model.restPos, offset)}:${vectorKey(model.restCornerNrm, offset)}`;
      if(!ids.has(key))ids.set(key,ids.size);model.normalFans[i]=ids.get(key);
    }
    model.normalFanCount=ids.size;
  }
  const sums=new Float32Array(model.normalFanCount*3);
  for(let o=0;o<model.pos.length;o+=9){
    const old=frame(model.restPos,o),now=frame(model.pos,o);
    for(let j=0;j<3;j++){
      if (!model.sourceNormalMask[o / 3 + j]) continue;
      const n=model.restCornerNrm.subarray(o+j*3,o+j*3+3),local=old.map(axis=>axis.reduce((v,x,k)=>v+x*n[k],0));
      const id=model.normalFans[o/3+j]*3;
      for(let k=0;k<3;k++)for(let a=0;a<3;a++)sums[id+k]+=now[a][k]*local[a];
    }
  }
  for(let i=0;i<model.normalFans.length;i++)model.cornerNrm.set(unit(Array.from(sums.subarray(model.normalFans[i]*3,model.normalFans[i]*3+3))),i*3);
}
