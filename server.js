import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {removeBackground} from './lib/cutout.js';
const {VIPPS_BASE:B,CLIENT_ID,CLIENT_SECRET,SUB_KEY,MSN,PUBLIC_URL,FALLBACK_URL,ADMIN_KEY='change-me',PORT=3000,MIN_AGE='18',DATA_DIR='data',GITHUB_TOKEN,GITHUB_REPO,GITHUB_BRANCH='main',GOOGLE_API_KEY,GOOGLE_CX}=process.env;
const LIVE=!!(CLIENT_ID&&CLIENT_SECRET&&SUB_KEY&&MSN&&PUBLIC_URL);
const NOALC=['Soft Drinks','Non-Alc. Beers','Ginger Beer & Kombucha'],BEERS=['Normal Beers','Non-Alc. Beers'];
fs.mkdirSync(path.join(DATA_DIR,'img'),{recursive:true});
const DFILE=path.join(DATA_DIR,'drinks.json');
if(!fs.existsSync(DFILE))fs.copyFileSync('public/drinks.json',DFILE);
let DRINKS=JSON.parse(fs.readFileSync(DFILE,'utf8'));
const find=id=>DRINKS.find(d=>d.id===id);
const load=(f,def)=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):def;
const orders=new Map(load('orders.json',[]));
const hidden=new Set(load('hidden.json',[]));
const save=()=>fs.writeFileSync('orders.json',JSON.stringify([...orders]));
const saveHidden=()=>fs.writeFileSync('hidden.json',JSON.stringify([...hidden]));

// optional backup of drinks.json and images to GitHub ([skip render] avoids a redeploy per edit)
let gq=Promise.resolve();
function gh(p,buf,msg){
  if(!GITHUB_TOKEN||!GITHUB_REPO)return;
  gq=gq.then(async()=>{try{
    const url=`https://api.github.com/repos/${GITHUB_REPO}/contents/${p}`;
    const h={Authorization:`Bearer ${GITHUB_TOKEN}`,'User-Agent':'bar','Accept':'application/vnd.github+json','Content-Type':'application/json'};
    const g=await fetch(url+'?ref='+GITHUB_BRANCH,{headers:h});const sha=g.ok?(await g.json()).sha:undefined;
    const r=await fetch(url,{method:'PUT',headers:h,body:JSON.stringify({message:'[skip render] '+msg,content:buf.toString('base64'),branch:GITHUB_BRANCH,sha})});
    if(!r.ok)console.error('github sync',r.status,await r.text());
  }catch(e){console.error('github sync',e)}});
}
function saveDrinks(msg){const s=JSON.stringify(DRINKS,null,1);fs.writeFileSync(DFILE,s);gh('public/drinks.json',Buffer.from(s),msg||'Update drinks')}

// image pull: Ambrosia number, direct URL, or Google image search; white background removed
const UA={'User-Agent':'Mozilla/5.0'};
async function googleUrls(name,fmt){
  if(!GOOGLE_API_KEY||!GOOGLE_CX)return [];
  const q=encodeURIComponent(`${name} ${fmt==='can'?'can':fmt==='wine'?'wine bottle':'bottle'} white background`);
  const r=await fetch(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${q}&searchType=image&imgType=photo&num=5&safe=active`);
  return r.ok?((await r.json()).items||[]).map(i=>i.link):[];
}
async function toCutout(buf){
  const {data,info}=await sharp(buf).rotate().ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const bb=removeBackground(data,info.width,info.height);
  return sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).extract(bb).resize({width:700,height:900,fit:'inside',withoutEnlargement:true}).png().toBuffer();
}
async function pullImage(d,imageUrl,ambrosiaNo){
  let urls=[];
  const no=String(ambrosiaNo||'').trim();
  if(/^[0-9]+$/.test(no))urls=['jpg','png'].map(e=>`https://ambrosiagroup.dk/img/prod/${no}.${e}`);
  else if(/^https?:/.test(String(imageUrl||'').trim()))urls=[String(imageUrl).trim()];
  else urls=await googleUrls(d.name,d.fmt);
  if(!urls.length)return {ok:false,error:'No image source: enter an Ambrosia number or image URL, or set GOOGLE_API_KEY and GOOGLE_CX'};
  for(const u of urls){
    try{
      const r=await fetch(u,{headers:UA,signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(String(r.status));
      const png=await toCutout(Buffer.from(await r.arrayBuffer()));
      fs.writeFileSync(path.join(DATA_DIR,'img',d.id+'.png'),png);
      gh(`public/img/${d.id}.png`,png,`Image for ${d.name}`);
      return {ok:true,source:u};
    }catch(e){console.error('image',u,e.message)}
  }
  return {ok:false,error:'None of the image sources worked'};
}

const app=express();app.use(express.json({limit:'20kb'}));
const FIX=`(()=>{const vis=r=>getComputedStyle(r).display!=='none';const rows=[...document.querySelectorAll('.row')];document.querySelectorAll('section').forEach(s=>{const n=[...s.querySelectorAll('.row')].filter(vis).length;if(!n)s.style.display='none';else{const u=s.querySelector('sup');if(u)u.textContent=String(n).padStart(2,'0')}});const f=rows.find(vis);if(f&&!vis(rows[0]))f.click()})()`;
app.get(['/','/index.html'],(_q,res)=>{
  let h=fs.readFileSync('public/index.html','utf8');
  const css=hidden.size?`<style>${[...hidden].map(i=>'#r'+i).join(',')}{display:none!important}</style>`:'';
  h=h.replace('</head>',css+'</head>').replace('</body>',`<script>${FIX}</script></body>`);
  res.set('Cache-Control','no-store').type('html').send(h);
});
app.use(express.static(DATA_DIR));
app.use(express.static('public'));

let tok={v:null,exp:0};
async function token(){
  if(tok.v&&Date.now()<tok.exp)return tok.v;
  const r=await fetch(`${B}/accesstoken/get`,{method:'POST',headers:{client_id:CLIENT_ID,client_secret:CLIENT_SECRET,'Ocp-Apim-Subscription-Key':SUB_KEY,'Merchant-Serial-Number':MSN}});
  if(!r.ok)throw new Error('token '+r.status);const j=await r.json();
  tok={v:j.access_token,exp:Date.now()+(Number(j.expires_in)-60)*1000};return tok.v;
}
async function api(p,method='GET',body){
  const r=await fetch(B+p,{method,headers:{Authorization:`Bearer ${await token()}`,'Ocp-Apim-Subscription-Key':SUB_KEY,'Merchant-Serial-Number':MSN,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),'Vipps-System-Name':'last-orders-bar','Vipps-System-Version':'1.0.0'},body:body&&JSON.stringify(body)});
  const t=await r.text();if(!r.ok)throw new Error(`${r.status} ${t}`);return t?JSON.parse(t):{};
}
const hits=new Map();
function limited(ip){const n=Date.now(),a=(hits.get(ip)||[]).filter(t=>n-t<60000);a.push(n);hits.set(ip,a);return a.length>12}

app.get('/api/config',(_q,res)=>res.json({live:LIVE,fallback:!LIVE&&!!FALLBACK_URL}));
app.get('/api/hidden',(_q,res)=>res.json([...hidden]));

app.post('/api/create-payment',async(req,res)=>{
  try{
    if(limited(req.ip))return res.status(429).json({error:'slow_down'});
    const items=(req.body.items||[]).map(i=>({d:find(i.id),qty:i.qty})).filter(i=>i.d&&Number.isInteger(i.qty)&&i.qty>0&&i.qty<=20);
    if(!items.length)return res.status(400).json({error:'empty'});
    if(items.some(i=>hidden.has(i.d.id)))return res.status(409).json({error:'unavailable'});
    const dkk=items.reduce((s,i)=>s+i.d.price*i.qty,0);
    const hasAlc=items.some(i=>i.d.alc);
    const reference='bar-'+crypto.randomBytes(8).toString('hex');
    const desc=items.map(i=>`${i.qty}x ${i.d.name}`).join(', ').slice(0,100);
    orders.set(reference,{reference,dkk,desc,items:items.map(i=>({id:i.d.id,name:i.d.name,qty:i.qty})),status:'PENDING',created:Date.now()});save();
    if(!LIVE){
      if(!FALLBACK_URL)return res.status(503).json({error:'payments_not_configured'});
      return res.json({fallbackUrl:FALLBACK_URL,amount:dkk,reference});
    }
    const body={amount:{currency:'DKK',value:dkk*100},paymentMethod:{type:'WALLET'},reference,userFlow:'WEB_REDIRECT',returnUrl:`${PUBLIC_URL}/?ref=${reference}`,paymentDescription:desc};
    if(hasAlc)body.minimumUserAge=Number(MIN_AGE);
    const p=await api('/epayment/v1/payments','POST',body);
    res.json({redirectUrl:p.redirectUrl,reference});
  }catch(e){console.error(e);res.status(500).json({error:'payment_failed'})}
});
async function settle(ref){
  const o=orders.get(ref);if(!o||o.status!=='PENDING'||!LIVE)return o;
  const p=await api(`/epayment/v1/payments/${ref}`);
  if(p.state==='AUTHORIZED'){
    await api(`/epayment/v1/payments/${ref}/capture`,'POST',{modificationAmount:{currency:'DKK',value:o.dkk*100}});
    o.status='PAID';o.paid=Date.now();save();
  }else if(['ABORTED','EXPIRED','TERMINATED'].includes(p.state)){o.status='FAILED';save()}
  return o;
}
app.get('/api/status/:ref',async(req,res)=>{
  try{const o=await settle(req.params.ref);if(!o)return res.status(404).json({});
    res.json({status:o.status,total:o.dkk,desc:o.desc,code:o.reference.slice(-6).toUpperCase()})}
  catch(e){console.error(e);res.status(500).json({status:'ERROR'})}
});
app.post('/api/webhook',(req,res)=>{const r=req.body?.reference;if(r)settle(r).catch(console.error);res.sendStatus(202)});

// ---- staff endpoints (refuse while ADMIN_KEY is the default) ----
const admin=(req,res,next)=>(ADMIN_KEY!=='change-me'&&req.query.key===ADMIN_KEY)?next():res.sendStatus(401);
app.get('/api/orders',admin,(_q,res)=>res.json([...orders.values()].sort((a,b)=>b.created-a.created).slice(0,100)));
app.post('/api/orders/:ref/served',admin,(req,res)=>{const o=orders.get(req.params.ref);if(o){o.served=true;save()}res.sendStatus(204)});
app.get('/api/drinks',admin,(_q,res)=>res.json(DRINKS.map(d=>({...d,hidden:hidden.has(d.id)}))));
app.post('/api/drinks/:id/hidden',admin,(req,res)=>{
  const id=Number(req.params.id);if(!find(id))return res.sendStatus(404);
  if(req.body.hidden)hidden.add(id);else hidden.delete(id);saveHidden();res.json({id,hidden:hidden.has(id)});
});
app.post('/api/drinks',admin,async(req,res)=>{
  const b=req.body||{},name=String(b.name||'').trim().slice(0,80),cat=String(b.cat||'').trim().slice(0,60),price=Math.round(Number(b.price));
  if(!name||!cat||!(price>0&&price<=2000))return res.status(400).json({error:'Name, category and a price between 1 and 2000 are required'});
  const id=DRINKS.reduce((m,d)=>Math.max(m,d.id),-1)+1;
  const d={id,name,price,cat,isNew:b.isNew!==false,sale:String(b.sale||'').trim().slice(0,60),fmt:['can','bottle','wine'].includes(b.fmt)?b.fmt:(cat==='Wine'?'wine':'can'),alc:typeof b.alc==='boolean'?b.alc:!NOALC.includes(cat),img:[]};
  DRINKS.push(d);
  const image=await pullImage(d,b.imageUrl,b.ambrosiaNo);
  saveDrinks('Add drink '+name);
  res.json({drink:d,image,synced:!!(GITHUB_TOKEN&&GITHUB_REPO)});
});
app.post('/api/drinks/:id/update',admin,(req,res)=>{
  const d=find(Number(req.params.id));if(!d)return res.sendStatus(404);const b=req.body||{};
  if('price' in b){const p=Math.round(Number(b.price));if(p>0&&p<=2000)d.price=p}
  if('isNew' in b)d.isNew=!!b.isNew;
  if('sale' in b)d.sale=String(b.sale||'').trim().slice(0,60);
  if('name' in b&&String(b.name).trim())d.name=String(b.name).trim().slice(0,80);
  if('cat' in b&&String(b.cat).trim())d.cat=String(b.cat).trim().slice(0,60);
  saveDrinks('Edit drink '+d.name);res.json(d);
});
app.post('/api/drinks/:id/image',admin,async(req,res)=>{
  const d=find(Number(req.params.id));if(!d)return res.sendStatus(404);
  res.json(await pullImage(d,req.body?.imageUrl,req.body?.ambrosiaNo));
});
app.delete('/api/drinks/:id',admin,(req,res)=>{
  const id=Number(req.params.id);const d=find(id);if(!d)return res.sendStatus(404);
  DRINKS=DRINKS.filter(x=>x.id!==id);hidden.delete(id);saveHidden();saveDrinks('Remove drink '+d.name);res.sendStatus(204);
});
app.post('/api/bulk',admin,(req,res)=>{
  const {action,scope}=req.body||{};let n=0;
  for(const d of DRINKS){
    if(scope==='beers'&&!BEERS.includes(d.cat))continue;
    if(action==='clearNew'&&d.isNew){d.isNew=false;n++}
    if(action==='clearSale'&&d.sale){d.sale='';n++}
  }
  if(n)saveDrinks(`Bulk ${action} (${scope})`);res.json({changed:n});
});
app.listen(PORT,()=>console.log(`http://localhost:${PORT}  payments: ${LIVE?'Vipps MobilePay API':FALLBACK_URL?'fallback link':'NOT CONFIGURED'}  github sync: ${GITHUB_TOKEN&&GITHUB_REPO?'on':'off'}`));
