import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
const {VIPPS_BASE:B,CLIENT_ID,CLIENT_SECRET,SUB_KEY,MSN,PUBLIC_URL,FALLBACK_URL,ADMIN_KEY='change-me',PORT=3000,MIN_AGE='18'}=process.env;
const LIVE=!!(CLIENT_ID&&CLIENT_SECRET&&SUB_KEY&&MSN&&PUBLIC_URL);
const DRINKS=JSON.parse(fs.readFileSync('public/drinks.json','utf8'));
const byId=new Map(DRINKS.map(d=>[d.id,d]));
const load=(f,def)=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):def;
const orders=new Map(load('orders.json',[]));
const hidden=new Set(load('hidden.json',[]));
const save=()=>fs.writeFileSync('orders.json',JSON.stringify([...orders]));
const saveHidden=()=>fs.writeFileSync('hidden.json',JSON.stringify([...hidden]));
const app=express();app.use(express.json({limit:'20kb'}));

// Home page: hide switched-off drinks before the browser sees them
const FIX=`(()=>{const vis=r=>getComputedStyle(r).display!=='none';const rows=[...document.querySelectorAll('.row')];document.querySelectorAll('section').forEach(s=>{const n=[...s.querySelectorAll('.row')].filter(vis).length;if(!n)s.style.display='none';else{const u=s.querySelector('sup');if(u)u.textContent=String(n).padStart(2,'0')}});const f=rows.find(vis);if(f&&!vis(rows[0]))f.click()})()`;
app.get(['/','/index.html'],(_q,res)=>{
  let h=fs.readFileSync('public/index.html','utf8');
  const css=hidden.size?`<style>${[...hidden].map(i=>'#r'+i).join(',')}{display:none!important}</style>`:'';
  h=h.replace('</head>',css+'</head>').replace('</body>',`<script>${FIX}</script></body>`);
  res.set('Cache-Control','no-store').type('html').send(h);
});
app.use(express.static('public'));

let tok={v:null,exp:0};
async function token(){
  if(tok.v&&Date.now()<tok.exp)return tok.v;
  const r=await fetch(`${B}/accesstoken/get`,{method:'POST',headers:{client_id:CLIENT_ID,client_secret:CLIENT_SECRET,'Ocp-Apim-Subscription-Key':SUB_KEY,'Merchant-Serial-Number':MSN}});
  if(!r.ok)throw new Error('token '+r.status);const j=await r.json();
  tok={v:j.access_token,exp:Date.now()+(Number(j.expires_in)-60)*1000};return tok.v;
}
async function api(path,method='GET',body){
  const r=await fetch(B+path,{method,headers:{Authorization:`Bearer ${await token()}`,'Ocp-Apim-Subscription-Key':SUB_KEY,'Merchant-Serial-Number':MSN,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),'Vipps-System-Name':'last-orders-bar','Vipps-System-Version':'1.0.0'},body:body&&JSON.stringify(body)});
  const t=await r.text();if(!r.ok)throw new Error(`${r.status} ${t}`);return t?JSON.parse(t):{};
}
const hits=new Map();
function limited(ip){const n=Date.now(),a=(hits.get(ip)||[]).filter(t=>n-t<60000);a.push(n);hits.set(ip,a);return a.length>12}

app.get('/api/config',(_q,res)=>res.json({live:LIVE,fallback:!LIVE&&!!FALLBACK_URL}));
app.get('/api/hidden',(_q,res)=>res.json([...hidden]));

app.post('/api/create-payment',async(req,res)=>{
  try{
    if(limited(req.ip))return res.status(429).json({error:'slow_down'});
    const items=(req.body.items||[]).map(i=>({d:byId.get(i.id),qty:i.qty})).filter(i=>i.d&&Number.isInteger(i.qty)&&i.qty>0&&i.qty<=20);
    if(!items.length)return res.status(400).json({error:'empty'});
    if(items.some(i=>hidden.has(i.d.id)))return res.status(409).json({error:'unavailable'});
    const dkk=items.reduce((s,i)=>s+i.d.price*i.qty,0);
    const hasAlc=items.some(i=>i.d.alc);
    const reference='bar-'+crypto.randomBytes(8).toString('hex');
    const desc=items.map(i=>`${i.qty}x ${i.d.name}`).join(', ').slice(0,100);
    const order={reference,dkk,desc,items:items.map(i=>({id:i.d.id,name:i.d.name,qty:i.qty})),status:'PENDING',created:Date.now()};
    orders.set(reference,order);save();
    if(!LIVE){
      if(!FALLBACK_URL)return res.status(503).json({error:'payments_not_configured'});
      return res.json({fallbackUrl:FALLBACK_URL,amount:dkk,reference});
    }
    const body={amount:{currency:'DKK',value:dkk*100},paymentMethod:{type:'WALLET'},reference,userFlow:'WEB_REDIRECT',
      returnUrl:`${PUBLIC_URL}/?ref=${reference}`,paymentDescription:desc};
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

// Staff endpoints: refuse to work while ADMIN_KEY is still the default
const admin=(req,res,next)=>(ADMIN_KEY!=='change-me'&&req.query.key===ADMIN_KEY)?next():res.sendStatus(401);
app.get('/api/orders',admin,(_q,res)=>res.json([...orders.values()].sort((a,b)=>b.created-a.created).slice(0,100)));
app.post('/api/orders/:ref/served',admin,(req,res)=>{const o=orders.get(req.params.ref);if(o){o.served=true;save()}res.sendStatus(204)});
app.get('/api/drinks',admin,(_q,res)=>res.json(DRINKS.map(d=>({id:d.id,name:d.name,cat:d.cat,price:d.price,hidden:hidden.has(d.id)}))));
app.post('/api/drinks/:id/hidden',admin,(req,res)=>{
  const id=Number(req.params.id);if(!byId.has(id))return res.sendStatus(404);
  if(req.body.hidden)hidden.add(id);else hidden.delete(id);saveHidden();res.json({id,hidden:hidden.has(id)});
});
app.listen(PORT,()=>console.log(`http://localhost:${PORT}  payments: ${LIVE?'Vipps MobilePay API':FALLBACK_URL?'fallback link':'NOT CONFIGURED'}`));
