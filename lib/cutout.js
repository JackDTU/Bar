export function removeBackground(d,w,h,tol=22){
  const n=w*h;let tr=0;for(let i=0;i<n;i++)if(d[i*4+3]<250)tr++;
  if(tr/n<=0.05){
    const t=255-tol,seen=new Uint8Array(n),st=new Int32Array(n);let sp=0;
    const near=i=>d[i*4]>=t&&d[i*4+1]>=t&&d[i*4+2]>=t;
    const push=i=>{if(!seen[i]&&near(i)){seen[i]=1;st[sp++]=i}};
    for(let x=0;x<w;x++){push(x);push((h-1)*w+x)}
    for(let y=0;y<h;y++){push(y*w);push(y*w+w-1)}
    while(sp){const i=st[--sp],x=i%w,y=(i-x)/w;if(x>0)push(i-1);if(x<w-1)push(i+1);if(y>0)push(i-w);if(y<h-1)push(i+w)}
    for(let i=0;i<n;i++)if(seen[i])d[i*4+3]=0;
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;if(seen[i])continue;if(seen[i-1]||seen[i+1]||seen[i-w]||seen[i+w]){const k=i*4;if(Math.min(d[k],d[k+1],d[k+2])>=200)d[k+3]=110}}
  }
  let x0=w,y0=h,x1=-1,y1=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(d[(y*w+x)*4+3]>20){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}
  if(x1<0)throw new Error('empty image');
  return {left:x0,top:y0,width:x1-x0+1,height:y1-y0+1};
}
