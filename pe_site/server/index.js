import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import multer from 'multer';
import * as XLSX from 'xlsx';
import csvParser from 'csv-parser';
import os from 'node:os';
import zipcodes from 'zipcodes';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8080);

async function ensureBootstrapAdmin(){
  const email=process.env.ADMIN_EMAIL?.trim().toLowerCase(); const password=process.env.ADMIN_PASSWORD;
  if(!email || !password) return;
  if(password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  const hash=await bcrypt.hash(password,12);
  await pool.query(`INSERT INTO users(email,password_hash,role,active) VALUES($1,$2,'admin',true) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role='admin', active=true`,[email,hash]);
}
if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) throw new Error('DATABASE_URL and JWT_SECRET are required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
async function ensureSchema(){ const schema=await fs.readFile(path.join(__dirname,'schema.sql'),'utf8'); await pool.query(schema); }

app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname,'..')));
app.get('/', (_req,res)=>res.sendFile(path.join(__dirname,'..','index.html')));
app.get('/admin', (_req,res)=>res.sendFile(path.join(__dirname,'..','admin.html')));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: [
    "https://pinkelephantgunandpawn.com",
    "https://www.pinkelephantgunandpawn.com",
    "https://pink-elephant-gun-pawn.onrender.com"
  ],
  credentials: true
}));
app.use(express.json({ limit: '6mb' }));
app.use(rateLimit({ windowMs: 15*60*1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
const loginLimit = rateLimit({ windowMs: 15*60*1000, limit: 10, message: { error:'Too many login attempts. Try again later.' } });
const checkoutLimit = rateLimit({ windowMs: 15*60*1000, limit: 12, message: { error:'Too many checkout attempts. Try again shortly.' } });

function taxConfig(){
  const taxableStates=String(process.env.TAXABLE_STATES||'KY').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
  const storeState=String(process.env.STORE_STATE||'KY').trim().toUpperCase();
  return {taxableStates,storeState};
}
function taxRateBps(state){
  const st=String(state||'').toUpperCase();
  const specific=Number(process.env['TAX_RATE_BPS_'+st]);
  if(Number.isFinite(specific)&&specific>=0)return specific;
  const generic=Number(process.env.SALES_TAX_RATE_BPS||600);
  return Number.isFinite(generic)&&generic>=0?generic:0;
}
function calculateSalesTax({subtotalCents,shippingCents=0,state,fulfillment}){
  const cfg=taxConfig();
  const st=(fulfillment==='pickup'?cfg.storeState:String(state||'').toUpperCase());
  if(!cfg.taxableStates.includes(st))return {tax_cents:0,state:st,rate_bps:0,taxable:false};
  const rate=taxRateBps(st);
  // Kentucky includes seller-responsible delivery charges in taxable sales price. Other states can be configured separately later.
  const taxableBase=Math.max(0,Number(subtotalCents)||0)+Math.max(0,Number(shippingCents)||0);
  return {tax_cents:Math.round(taxableBase*rate/10000),state:st,rate_bps:rate,taxable:true};
}

function smtpTransport(){
  if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS)return null;
  return nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false').toLowerCase()==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
}
async function loadOrderForEmail(orderId){
  const {rows}=await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('title',oi.item_title,'quantity',oi.quantity,'line_total_cents',oi.line_total_cents)) FILTER (WHERE oi.id IS NOT NULL),'[]') AS items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.id=$1 GROUP BY o.id`,[orderId]);
  return rows[0]||null;
}
function moneyText(c){return '$'+(Number(c||0)/100).toFixed(2)}
function emailShell(title,body){return `<!doctype html><html><body style="margin:0;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;color:#18181b"><div style="max-width:640px;margin:0 auto;padding:28px 14px"><div style="background:#e86aa7;color:#16070f;padding:18px 22px;border-radius:14px 14px 0 0"><div style="font-size:22px;font-weight:900">Pink Elephant Gun &amp; Pawn</div><div style="font-size:13px;font-weight:700">Prestonsburg, Kentucky</div></div><div style="background:#fff;border:1px solid #ddd;padding:24px;border-radius:0 0 14px 14px"><h2 style="margin-top:0">${title}</h2>${body}<hr style="border:0;border-top:1px solid #eee;margin:24px 0"><div style="font-size:13px;color:#666">Pink Elephant Gun &amp; Pawn • 30 Colonels Ct, Prestonsburg, KY 41653 • (606) 506-5030</div></div></div></body></html>`}
async function sendOrderEmail(orderId,type='confirmation'){
  const tx=smtpTransport();if(!tx)return {sent:false,reason:'SMTP not configured'};
  const o=await loadOrderForEmail(orderId);if(!o)return {sent:false,reason:'Order not found'};
  const from=process.env.ORDER_FROM_EMAIL||process.env.SMTP_USER;
  const lines=(o.items||[]).map(i=>`${i.title} x ${i.quantity} — ${moneyText(i.line_total_cents)}`).join('\n');
  const itemHtml=(o.items||[]).map(i=>`<tr><td style="padding:7px 0">${String(i.title).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))} × ${i.quantity}</td><td style="padding:7px 0;text-align:right">${moneyText(i.line_total_cents)}</td></tr>`).join('');
  const tracking=o.tracking_number?(o.tracking_url?`<p><a href="${o.tracking_url}" style="display:inline-block;background:#e86aa7;color:#16070f;text-decoration:none;font-weight:900;padding:11px 16px;border-radius:8px">TRACK PACKAGE</a><br><span style="font-size:12px;color:#666">${o.tracking_number}</span></p>`:`<p><b>Tracking:</b> ${o.tracking_number}</p>`):'';
  const subjects={confirmation:`Order received — ${o.order_number}`,confirmed:`Order confirmed — ${o.order_number}`,ready:`Your order is ready — ${o.order_number}`,shipped:`Your order shipped — ${o.order_number}`,completed:`Order complete — ${o.order_number}`,cancelled:`Order cancelled — ${o.order_number}`,refund:`Refund completed — ${o.order_number}`};
  const intros={confirmation:'Thanks for your order. We received it and will keep you updated as it moves through the shop.',confirmed:'Your order has been confirmed and is being prepared.',ready:o.fulfillment==='pickup'?'Your order is ready for pickup at Pink Elephant Gun & Pawn.':'Your order is packed and ready for the next shipping step.',shipped:'Your order has shipped. Tracking information is below.',completed:'Your order is complete. Thanks for shopping with Pink Elephant Gun & Pawn.',cancelled:'This order has been cancelled. If you have questions, call the shop at (606) 506-5030.',refund:`Your PayPal refund for ${moneyText(o.refunded_cents||o.total_cents)} has been completed. Your order has been updated accordingly.`};
  const intro=intros[type]||intros.confirmation;
  const summary=`<p>${intro}</p><p><b>Order:</b> ${o.order_number}</p><table style="width:100%;border-collapse:collapse">${itemHtml}<tr><td style="padding-top:12px;border-top:1px solid #eee">Subtotal</td><td style="padding-top:12px;border-top:1px solid #eee;text-align:right">${moneyText(o.subtotal_cents)}</td></tr><tr><td>Tax</td><td style="text-align:right">${moneyText(o.tax_cents)}</td></tr><tr><td>Shipping</td><td style="text-align:right">${moneyText(o.shipping_cents)}</td></tr><tr><td style="font-weight:900;padding-top:7px">Total</td><td style="font-weight:900;text-align:right;padding-top:7px">${moneyText(o.total_cents)}</td></tr></table>${type==='shipped'?tracking:''}`;
  const text=`${intro}\n\nOrder ${o.order_number}\n${lines}\n\nSubtotal: ${moneyText(o.subtotal_cents)}\nTax: ${moneyText(o.tax_cents)}\nShipping: ${moneyText(o.shipping_cents)}\nTotal: ${moneyText(o.total_cents)}${o.tracking_number?`\nTracking: ${o.tracking_number}${o.tracking_url?' '+o.tracking_url:''}`:''}`;
  try{
    await tx.sendMail({from,to:o.customer_email,subject:`Pink Elephant — ${subjects[type]||subjects.confirmation}`,text,html:emailShell(subjects[type]||'Order update',summary)});
    if(type==='confirmation')await pool.query('UPDATE orders SET customer_email_sent_at=now(),customer_email_error=NULL WHERE id=$1',[o.id]);
    else await pool.query('UPDATE orders SET last_status_email=$1,last_status_email_at=now(),customer_email_error=NULL WHERE id=$2',[type,o.id]);
    return {sent:true,type};
  }catch(e){const detail=`SMTP ERROR code=${e?.code||'unknown'} command=${e?.command||'unknown'} host=${process.env.SMTP_HOST||'missing'} port=${process.env.SMTP_PORT||'587'} secure=${process.env.SMTP_SECURE||'false'} message=${e?.message||e}`;console.error(detail);await pool.query('UPDATE orders SET customer_email_error=$1 WHERE id=$2',[detail.slice(0,1000),o.id]);return {sent:false,reason:detail}}
}
async function sendOrderConfirmation(orderId){return sendOrderEmail(orderId,'confirmation')}



const roles = { viewer: 1, manager: 2, admin: 3 };
const sign = u => jwt.sign({ sub:u.id, email:u.email, role:u.role }, process.env.JWT_SECRET, { expiresIn:'8h', issuer:'pink-elephant-api' });
async function audit(req, action, entityType=null, entityId=null, metadata={}) {
  if (!req.user) return;
  await pool.query('INSERT INTO audit_log(user_id,action,entity_type,entity_id,metadata,ip) VALUES($1,$2,$3,$4,$5,$6)', [req.user.sub,action,entityType,entityId,metadata,req.ip]);
}
function auth(req,res,next){
  const h=req.get('authorization')||''; const token=h.startsWith('Bearer ')?h.slice(7):null;
  if(!token) return res.status(401).json({error:'Authentication required'});
  try{ req.user=jwt.verify(token,process.env.JWT_SECRET,{issuer:'pink-elephant-api'}); next(); }catch{ return res.status(401).json({error:'Invalid or expired session'}); }
}
const requireRole=min => (req,res,next)=> roles[req.user?.role] >= roles[min] ? next() : res.status(403).json({error:'Insufficient permissions'});

app.get('/health', async (_req,res)=>{ try{await pool.query('SELECT 1'); res.json({ok:true});}catch{res.status(503).json({ok:false});} });
app.post('/api/auth/login', loginLimit, async (req,res)=>{
  const body=z.object({email:z.string().email(),password:z.string().min(8)}).safeParse(req.body);
  if(!body.success) return res.status(400).json({error:'Valid email and password are required'});
  const {rows}=await pool.query('SELECT id,email,password_hash,role,active FROM users WHERE lower(email)=lower($1)',[body.data.email]);
  const u=rows[0];
  if(!u || !u.active || !(await bcrypt.compare(body.data.password,u.password_hash))) return res.status(401).json({error:'Invalid credentials'});
  const token=sign(u); req.user={sub:u.id,email:u.email,role:u.role}; await audit(req,'LOGIN');
  res.json({token,user:{id:u.id,email:u.email,role:u.role}});
});
app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));

app.get('/api/public/inventory',async (_req,res)=>{
  const {rows}=await pool.query(`SELECT id,title,category,quantity,price_cents,price_label,sale_price_cents,sku,item_type,condition,description,image_url,image_urls,regulated,featured,created_at,updated_at,low_stock FROM inventory WHERE public_visible=true AND quantity>0 ORDER BY updated_at DESC`);
  res.json(rows);
});
app.get('/api/public/store-config',(_req,res)=>res.json({mobilepawn_url:process.env.MOBILEPAWN_URL||null,mobilepawn_enabled:!!process.env.MOBILEPAWN_URL}));

// ---------- SHIPPO TEST SHIPPING RATES ----------
const SHIPPO_API='https://api.goshippo.com';
function shippoHeaders(){
  const token=process.env.SHIPPO_API_TOKEN?.trim();
  if(!token){const e=new Error('SHIPPO_API_TOKEN is not configured');e.status=503;throw e}
  return {'Authorization':'ShippoToken '+token,'Content-Type':'application/json'};
}
function shipFromAddress(){return {
  name:process.env.SHIP_FROM_NAME||'Pink Elephant Gun & Pawn',
  company:process.env.SHIP_FROM_COMPANY||'Pink Elephant Gun & Pawn',
  street1:process.env.SHIP_FROM_STREET1||'30 Colonels Ct',
  city:process.env.SHIP_FROM_CITY||'Prestonsburg',
  state:process.env.SHIP_FROM_STATE||'KY',
  zip:process.env.SHIP_FROM_ZIP||'41653',
  country:'US',
  phone:process.env.SHIP_FROM_PHONE||'6065065030',
  email:process.env.SHIP_FROM_EMAIL||''
}}
const SHIPPING_ESTIMATE_BUFFER_CENTS=Math.max(0,Number.parseInt(process.env.SHIPPING_ESTIMATE_BUFFER_CENTS||'400',10)||0);
const SHIPPING_DEFAULTS={
  small:{weight:1,length:10,width:8,height:4},
  medium:{weight:4,length:16,width:12,height:8},
  large:{weight:10,length:22,width:18,height:14},
  guitar:{weight:18,length:48,width:20,height:8},
  console:{weight:12,length:18,width:14,height:8}
};
function estimatedParcelForInventory(inv){
  const saved=[inv.shipping_weight_lb,inv.shipping_length_in,inv.shipping_width_in,inv.shipping_height_in].map(Number);
  if(saved.every(v=>Number.isFinite(v)&&v>0))return {weight:saved[0],length:saved[1],width:saved[2],height:saved[3],estimated:false,profile:'saved'};
  const cat=String(inv.category||'').toLowerCase();
  let key='medium';
  if(/jewel|collect|accessor|coin|card/.test(cat))key='small';
  else if(/gaming|console|electronic/.test(cat))key='console';
  else if(/music|guitar|instrument/.test(cat))key='guitar';
  else if(/tool|large|sport/.test(cat))key='large';
  const p={...SHIPPING_DEFAULTS[key]};
  if(Number.isFinite(saved[0])&&saved[0]>0)p.weight=saved[0];
  return {...p,estimated:true,profile:key};
}
const shippingQuoteSchema=z.object({
  customer:z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(180),phone:z.string().trim().min(7).max(40)}),
  shipping:z.object({address1:z.string().trim().min(3).max(180),city:z.string().trim().min(2).max(100),state:z.string().trim().min(2).max(50),postal:z.string().trim().min(3).max(20)}),
  items:z.array(z.object({inventory_id:z.string().uuid(),quantity:z.number().int().positive().max(99)})).min(1).max(25)
});
app.post('/api/public/shipping-rates',checkoutLimit,async(req,res)=>{
  const p=shippingQuoteSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Enter your contact and shipping address first.'});
  try{
    // Confirm cart availability and build parcels from each inventory item's saved package data.
    const parcels=[];
    for(const requested of p.data.items){
      const inv=(await pool.query('SELECT id,title,category,quantity,regulated,public_visible,shipping_weight_lb,shipping_length_in,shipping_width_in,shipping_height_in FROM inventory WHERE id=$1',[requested.inventory_id])).rows[0];
      if(!inv||!inv.public_visible||inv.quantity<requested.quantity)return res.status(409).json({error:'An item in your cart is no longer available.'});
      if(inv.regulated)return res.status(400).json({error:'Regulated items use the licensed-dealer checkout flow.'});
      const parcel=estimatedParcelForInventory(inv);
      for(let n=0;n<requested.quantity;n++)parcels.push({length:String(parcel.length),width:String(parcel.width),height:String(parcel.height),distance_unit:'in',weight:String(parcel.weight),mass_unit:'lb',_estimated:parcel.estimated,_profile:parcel.profile});
    }
    const shippoParcels=parcels.map(({_estimated,_profile,...p})=>p);
    const body={address_from:shipFromAddress(),address_to:{name:p.data.customer.name,street1:p.data.shipping.address1,city:p.data.shipping.city,state:p.data.shipping.state.toUpperCase(),zip:p.data.shipping.postal,country:'US',phone:p.data.customer.phone,email:p.data.customer.email},parcels:shippoParcels,async:false};
    const r=await fetch(SHIPPO_API+'/shipments/',{method:'POST',headers:shippoHeaders(),body:JSON.stringify(body)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.detail||j.message||j.error||'Shippo could not create a rate quote.');
    let subtotalCents=0;
    for(const requested of p.data.items){const inv=(await pool.query('SELECT price_cents,sale_price_cents FROM inventory WHERE id=$1',[requested.inventory_id])).rows[0];const unit=inv?.sale_price_cents!=null?Number(inv.sale_price_cents):Number(inv?.price_cents||0);subtotalCents+=unit*requested.quantity}
    const rates=(j.rates||[]).filter(x=>x.object_id&&Number.isFinite(Number(x.amount))).map(x=>{
      const carrier_amount_cents=Math.round(Number(x.amount)*100);const amount_cents=carrier_amount_cents+SHIPPING_ESTIMATE_BUFFER_CENTS;const tax=calculateSalesTax({subtotalCents,shippingCents:amount_cents,state:p.data.shipping.state,fulfillment:'shipping'});
      return {rate_id:x.object_id,shipment_id:j.object_id,provider:x.provider||'',service:x.servicelevel?.name||x.servicelevel?.token||'Shipping',amount_cents,carrier_amount_cents,estimate_buffer_cents:SHIPPING_ESTIMATE_BUFFER_CENTS,currency:x.currency||'USD',estimated_days:x.estimated_days??null,duration_terms:x.duration_terms||'',test:!!x.test,tax_cents:tax.tax_cents,tax_rate_bps:tax.rate_bps,total_cents:subtotalCents+amount_cents+tax.tax_cents,estimated_shipping:true};
    }).sort((a,b)=>a.amount_cents-b.amount_cents).slice(0,12);
    if(!rates.length)return res.status(502).json({error:'Shippo returned no shipping rates for this address.'});
    res.json({rates,test_mode:rates.every(x=>x.test),subtotal_cents:subtotalCents,parcel_note:`Estimated shipping uses saved package data when available and safe category presets otherwise. A ${'$'}${(SHIPPING_ESTIMATE_BUFFER_CENTS/100).toFixed(2)} packing/estimate buffer is included.`});
  }catch(e){console.error(e);res.status(e.status||502).json({error:e.message||'Could not load shipping rates.'})}
});
app.post('/api/public/tax-preview',checkoutLimit,async(req,res)=>{
  const p=z.object({fulfillment:z.enum(['pickup','shipping']),shipping:z.object({state:z.string().trim().min(2).max(50)}).nullable().optional(),shipping_cents:z.number().int().min(0).default(0),items:z.array(z.object({inventory_id:z.string().uuid(),quantity:z.number().int().positive().max(99)})).min(1).max(25)}).safeParse(req.body);
  if(!p.success)return res.status(400).json({error:'Invalid tax preview request.'});
  try{let subtotal=0;for(const requested of p.data.items){const inv=(await pool.query('SELECT title,quantity,price_cents,sale_price_cents,regulated,public_visible FROM inventory WHERE id=$1',[requested.inventory_id])).rows[0];if(!inv||!inv.public_visible||inv.quantity<requested.quantity)return res.status(409).json({error:'An item in your cart is no longer available.'});if(inv.regulated)return res.status(400).json({error:'Regulated items use the licensed-dealer checkout flow.'});const unit=inv.sale_price_cents!=null?Number(inv.sale_price_cents):Number(inv.price_cents);if(!Number.isFinite(unit))return res.status(400).json({error:`${inv.title} requires store pricing.`});subtotal+=unit*requested.quantity}
    const tax=calculateSalesTax({subtotalCents:subtotal,shippingCents:p.data.shipping_cents,state:p.data.shipping?.state,fulfillment:p.data.fulfillment});res.json({subtotal_cents:subtotal,shipping_cents:p.data.shipping_cents,tax_cents:tax.tax_cents,total_cents:subtotal+p.data.shipping_cents+tax.tax_cents,tax_state:tax.state,tax_rate_bps:tax.rate_bps,taxable:tax.taxable});
  }catch(e){console.error(e);res.status(500).json({error:'Could not calculate tax preview.'})}
});

async function verifyShippoRate(rateId,shipmentId){
  const r=await fetch(SHIPPO_API+'/rates/'+encodeURIComponent(rateId),{headers:shippoHeaders()});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.detail||j.message||'Could not verify the selected shipping rate.');
  if(shipmentId&&j.shipment!==shipmentId)throw new Error('The selected shipping rate does not match this quote.');
  const carrierCents=Math.round(Number(j.amount)*100);const cents=carrierCents+SHIPPING_ESTIMATE_BUFFER_CENTS;if(!Number.isFinite(cents)||cents<0)throw new Error('The selected shipping rate is invalid.');
  return {cents,provider:j.provider||'',service:j.servicelevel?.name||j.servicelevel?.token||'Shipping',rate_id:j.object_id,shipment_id:j.shipment||shipmentId||null,test:!!j.test};
}


function paypalMode(){return String(process.env.PAYPAL_MODE||'sandbox').trim().toLowerCase()==='live'?'live':'sandbox'}
function paypalApiBase(){return paypalMode()==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com'}
function paypalConfigured(){return !!(process.env.PAYPAL_CLIENT_ID&&process.env.PAYPAL_CLIENT_SECRET)}
async function paypalAccessToken(){
  if(!paypalConfigured())throw Object.assign(new Error('PayPal is not configured yet.'),{status:503});
  const basic=Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r=await fetch(paypalApiBase()+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+basic,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
  const j=await r.json().catch(()=>({}));if(!r.ok||!j.access_token)throw Object.assign(new Error(j.error_description||'Could not connect to PayPal.'),{status:502});
  return j.access_token;
}
async function paypalRequest(pathname,{method='GET',body=null,requestId=null}={}){
  const token=await paypalAccessToken();
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};if(requestId)headers['PayPal-Request-Id']=requestId;
  const r=await fetch(paypalApiBase()+pathname,{method,headers,body:body?JSON.stringify(body):undefined});
  const j=await r.json().catch(()=>({}));if(!r.ok){const detail=j?.details?.[0]?.description||j?.message||j?.name||'PayPal request failed.';const e=new Error(detail);e.status=502;e.paypal=j;throw e}return j;
}
function paypalCaptureIdFromOrder(ppOrder){
  const units=Array.isArray(ppOrder?.purchase_units)?ppOrder.purchase_units:[];
  for(const u of units){
    const caps=Array.isArray(u?.payments?.captures)?u.payments.captures:[];
    if(caps[0]?.id)return caps[0].id;
  }
  return null;
}
async function paypalResolveCapture(order){
  let captureId=order.paypal_capture_id||null;
  let ppOrder=null;
  if(!captureId){
    ppOrder=await paypalRequest('/v2/checkout/orders/'+encodeURIComponent(order.payment_reference));
    captureId=paypalCaptureIdFromOrder(ppOrder);
    if(captureId)await pool.query('UPDATE orders SET paypal_capture_id=$1,updated_at=now() WHERE id=$2',[captureId,order.id]);
  }
  if(!captureId){const e=new Error('No PayPal capture was found for this order.');e.status=409;throw e}
  const capture=await paypalRequest('/v2/payments/captures/'+encodeURIComponent(captureId));
  return {captureId,capture,ppOrder};
}
async function finalizePaypalRefund(orderId,{refundId=null,refundStatus='COMPLETED',amountCents=null}={}){
  const c=await pool.connect();let updated=null,changed=false;
  try{
    await c.query('BEGIN');
    const o=(await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
    if(!o){await c.query('ROLLBACK');return null}
    const refundCents=amountCents==null?Number(o.total_cents||0):Math.max(0,Number(amountCents)||0);
    const full=refundCents>=Number(o.total_cents||0);
    if(full&&!o.inventory_restocked){
      const its=(await c.query('SELECT inventory_id,quantity FROM order_items WHERE order_id=$1',[o.id])).rows;
      for(const it of its)if(it.inventory_id)await c.query('UPDATE inventory SET quantity=quantity+$1,updated_at=now() WHERE id=$2',[it.quantity,it.inventory_id]);
    }
    const paymentStatus=full?'refunded':o.payment_status;
    const orderStatus=full?'cancelled':o.order_status;
    updated=(await c.query(`UPDATE orders SET payment_status=$1,order_status=$2,refunded_cents=$3,refunded_tax_cents=$4,refunded_at=COALESCE(refunded_at,now()),refund_status=$5,paypal_refund_id=COALESCE($6,paypal_refund_id),inventory_restocked=CASE WHEN $7 THEN true ELSE inventory_restocked END,cancelled_at=CASE WHEN $7 THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END,updated_at=now() WHERE id=$8 RETURNING *`,[paymentStatus,orderStatus,refundCents,full?Number(o.tax_cents||0):0,refundStatus,refundId,full,o.id])).rows[0];
    changed=o.payment_status!==updated.payment_status||o.refund_status!==updated.refund_status;
    await c.query('COMMIT');
  }catch(e){try{await c.query('ROLLBACK')}catch{};throw e}finally{c.release()}
  if(changed&&updated?.payment_status==='refunded')sendOrderEmail(updated.id,'refund').catch(console.error);
  return updated;
}
async function syncPaypalRefundState(order){
  if(order.payment_provider!=='paypal'||!order.payment_reference){const e=new Error('This order is not a PayPal order.');e.status=400;throw e}
  if(order.paypal_refund_id){
    const refund=await paypalRequest('/v2/payments/refunds/'+encodeURIComponent(order.paypal_refund_id));
    const amount=Math.round(Number(refund?.amount?.value||0)*100);
    await pool.query('UPDATE orders SET refund_status=$1,refunded_cents=GREATEST(refunded_cents,$2),updated_at=now() WHERE id=$3',[refund.status||'UNKNOWN',amount,order.id]);
    if(refund.status==='COMPLETED')return {order:await finalizePaypalRefund(order.id,{refundId:refund.id,refundStatus:refund.status,amountCents:amount}),paypal:{refund_status:refund.status,refund_id:refund.id}};
    return {order:(await pool.query('SELECT * FROM orders WHERE id=$1',[order.id])).rows[0],paypal:{refund_status:refund.status,refund_id:refund.id}};
  }
  const {captureId,capture}=await paypalResolveCapture(order);
  if(capture.status==='REFUNDED')return {order:await finalizePaypalRefund(order.id,{refundStatus:'COMPLETED',amountCents:Number(order.total_cents||0)}),paypal:{capture_status:capture.status,capture_id:captureId}};
  return {order:(await pool.query('SELECT * FROM orders WHERE id=$1',[order.id])).rows[0],paypal:{capture_status:capture.status,capture_id:captureId,notice:'No completed refund is visible on the capture yet.'}};
}

function paypalBlockedItem(inv){
  if(inv.regulated)return true;
  const c=String(inv.category||'').toLowerCase();
  return /(^|\b)(ammo|ammunition|firearm|firearms|gun|guns)(\b|$)/i.test(c);
}
async function pricePublicCheckout(payload,{lockClient=null}={}){
  let verifiedShipping=null;
  if(payload.fulfillment==='shipping')verifiedShipping=await verifyShippoRate(payload.shippo_rate_id,payload.shippo_shipment_id);
  const q=lockClient||pool;let subtotal=0;const items=[];
  for(const requested of payload.items){
    const suffix=lockClient?' FOR UPDATE':'';
    const inv=(await q.query('SELECT id,title,category,quantity,price_cents,sale_price_cents,regulated,public_visible FROM inventory WHERE id=$1'+suffix,[requested.inventory_id])).rows[0];
    if(!inv||!inv.public_visible){const e=new Error('An item in your cart is no longer available.');e.status=409;throw e}
    if(paypalBlockedItem(inv)){const e=new Error('PayPal checkout is not available for firearms or ammunition.');e.status=400;throw e}
    const unit=inv.sale_price_cents!=null?Number(inv.sale_price_cents):(inv.price_cents!=null?Number(inv.price_cents):null);
    if(unit==null){const e=new Error(`${inv.title} requires store pricing.`);e.status=400;throw e}
    if(inv.quantity<requested.quantity){const e=new Error(`Not enough ${inv.title} is available.`);e.status=409;throw e}
    const line=unit*requested.quantity;subtotal+=line;items.push({inv,unit,quantity:requested.quantity,line});
  }
  const shippingCents=verifiedShipping?.cents||0;
  const tax=calculateSalesTax({subtotalCents:subtotal,shippingCents,state:payload.shipping?.state,fulfillment:payload.fulfillment});
  return {items,subtotal,shippingCents,tax,total:subtotal+shippingCents+tax.tax_cents,verifiedShipping};
}
const publicOrderSchema=z.object({
  customer:z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(180),phone:z.string().trim().min(7).max(40)}),
  fulfillment:z.enum(['pickup','shipping']),
  shipping:z.object({address1:z.string().trim().min(3).max(180),city:z.string().trim().min(2).max(100),state:z.string().trim().min(2).max(50),postal:z.string().trim().min(3).max(20)}).nullable().optional(),
  shippo_rate_id:z.string().trim().max(120).nullable().optional(),
  shippo_shipment_id:z.string().trim().max(120).nullable().optional(),
  notes:z.string().trim().max(1000).default(''),
  items:z.array(z.object({inventory_id:z.string().uuid(),quantity:z.number().int().positive().max(99)})).min(1).max(25)
});

const customerAuth=(req,res,next)=>{
  try{
    const raw=req.headers.authorization||'';
    const token=raw.startsWith('Bearer ')?raw.slice(7):'';
    if(!token)return res.status(401).json({error:'Sign in required'});
    const data=jwt.verify(token,process.env.JWT_SECRET);
    if(data.type!=='customer'||!data.customer_id)return res.status(401).json({error:'Invalid customer session'});
    req.customer={id:Number(data.customer_id),email:data.email};
    next();
  }catch(e){return res.status(401).json({error:'Invalid or expired customer session'})}
};

app.post('/api/public/customer/register',async(req,res)=>{
  try{
    const email=String(req.body?.email||'').trim().toLowerCase();
    const password=String(req.body?.password||'');
    const name=String(req.body?.name||'').trim();
    const phone=String(req.body?.phone||'').trim();
    if(!email||!email.includes('@'))return res.status(400).json({error:'Valid email required'});
    if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters'});
    const exists=await pool.query('select id from customers where email=$1',[email]);
    if(exists.rowCount)return res.status(409).json({error:'An account already exists for that email'});
    const hash=await bcrypt.hash(password,12);
    const q=await pool.query(
      `insert into customers(email,password_hash,name,phone) values($1,$2,$3,$4)
       returning id,email,name,phone,created_at`,
      [email,hash,name||null,phone||null]
    );
    const c=q.rows[0];
    const token=jwt.sign({type:'customer',customer_id:c.id,email:c.email},process.env.JWT_SECRET,{expiresIn:'30d'});
    res.status(201).json({token,customer:c});
  }catch(e){console.error(e);res.status(500).json({error:'Could not create account'})}
});

app.post('/api/public/customer/login',async(req,res)=>{
  try{
    const email=String(req.body?.email||'').trim().toLowerCase();
    const password=String(req.body?.password||'');
    const q=await pool.query('select * from customers where email=$1',[email]);
    if(!q.rowCount)return res.status(401).json({error:'Invalid email or password'});
    const c=q.rows[0];
    if(!await bcrypt.compare(password,c.password_hash))return res.status(401).json({error:'Invalid email or password'});
    const token=jwt.sign({type:'customer',customer_id:c.id,email:c.email},process.env.JWT_SECRET,{expiresIn:'30d'});
    res.json({token,customer:{id:c.id,email:c.email,name:c.name,phone:c.phone,created_at:c.created_at}});
  }catch(e){console.error(e);res.status(500).json({error:'Could not sign in'})}
});

app.get('/api/customer/me',customerAuth,async(req,res)=>{
  try{
    const q=await pool.query('select id,email,name,phone,address1,address2,city,state,postal,bravo_customer_id,bravo_link_status,bravo_last_synced_at,created_at from customers where id=$1',[req.customer.id]);
    if(!q.rowCount)return res.status(404).json({error:'Customer not found'});
    res.json(q.rows[0]);
  }catch(e){res.status(500).json({error:'Could not load account'})}
});


app.patch('/api/customer/me',customerAuth,async(req,res)=>{
  try{
    const p=z.object({
      name:z.string().trim().min(1).max(180).optional(),
      phone:z.string().trim().max(40).optional(),
      address1:z.string().trim().max(180).nullable().optional(),
      address2:z.string().trim().max(180).nullable().optional(),
      city:z.string().trim().max(100).nullable().optional(),
      state:z.string().trim().max(50).nullable().optional(),
      postal:z.string().trim().max(20).nullable().optional()
    }).safeParse(req.body);
    if(!p.success)return res.status(400).json({error:'Please check your account information.'});
    const keys=Object.keys(p.data);if(!keys.length)return res.status(400).json({error:'No changes'});
    const vals=[],sets=[];keys.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(p.data[k]??null)});vals.push(req.customer.id);
    const {rows}=await pool.query(`UPDATE customers SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING id,email,name,phone,address1,address2,city,state,postal,bravo_customer_id,bravo_link_status,bravo_last_synced_at,created_at`,vals);
    res.json(rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Could not update account'})}
});

app.post('/api/public/order-lookup',async(req,res)=>{
  try{
    const p=z.object({order_number:z.string().trim().min(3).max(80),email:z.string().trim().email().max(180)}).safeParse(req.body);
    if(!p.success)return res.status(400).json({error:'Enter the order number and email used at checkout.'});
    const {rows}=await pool.query(
      `SELECT o.id,o.order_number,o.created_at,o.order_status,o.payment_status,o.fulfillment,
       o.subtotal_cents,o.tax_cents,o.shipping_cents,o.total_cents,o.shipping_provider,o.shipping_service,
       o.tracking_number,o.tracking_url,
       COALESCE(json_agg(json_build_object('title',oi.item_title,'quantity',oi.quantity,'unit_price_cents',oi.unit_price_cents,'line_total_cents',oi.line_total_cents))
       FILTER (WHERE oi.id IS NOT NULL),'[]') items
       FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
       WHERE upper(o.order_number)=upper($1) AND lower(o.customer_email)=lower($2)
       GROUP BY o.id LIMIT 1`,
      [p.data.order_number,p.data.email]
    );
    if(!rows[0])return res.status(404).json({error:'No order matched that order number and email.'});
    res.json(rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Could not look up order'})}
});

app.get('/api/customer/orders',customerAuth,async(req,res)=>{
  try{
    const q=await pool.query(
      `select o.*,coalesce(json_agg(json_build_object('title',oi.item_title,'quantity',oi.quantity,'unit_price_cents',oi.unit_price_cents,'line_total_cents',oi.line_total_cents)) filter (where oi.id is not null),'[]') items
       from orders o left join order_items oi on oi.order_id=o.id
       where o.customer_id=$1 or lower(o.customer_email)=lower($2)
       group by o.id order by o.created_at desc`,
      [req.customer.id,req.customer.email]
    );
    res.json(q.rows);
  }catch(e){console.error(e);res.status(500).json({error:'Could not load orders'})}
});


app.get('/api/public/paypal/config',(_req,res)=>{
  if(!paypalConfigured())return res.status(503).json({enabled:false,error:'PayPal is not configured.'});
  res.json({enabled:true,client_id:process.env.PAYPAL_CLIENT_ID,mode:paypalMode(),currency:'USD'});
});

app.post('/api/public/paypal/create-order',checkoutLimit,async(req,res)=>{
  const p=publicOrderSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Please check the checkout information and try again.'});
  if(p.data.fulfillment==='shipping'&&!p.data.shipping)return res.status(400).json({error:'Shipping address is required.'});
  if(p.data.fulfillment==='shipping'&&!p.data.shippo_rate_id)return res.status(400).json({error:'Choose a shipping rate before paying.'});
  try{
    const priced=await pricePublicCheckout(p.data);
    const value=(priced.total/100).toFixed(2);
    const j=await paypalRequest('/v2/checkout/orders',{method:'POST',requestId:'pe-create-'+Date.now()+'-'+Math.random().toString(36).slice(2),body:{intent:'CAPTURE',purchase_units:[{description:'Pink Elephant Gun & Pawn merchandise order',amount:{currency_code:'USD',value,breakdown:{item_total:{currency_code:'USD',value:(priced.subtotal/100).toFixed(2)},shipping:{currency_code:'USD',value:(priced.shippingCents/100).toFixed(2)},tax_total:{currency_code:'USD',value:(priced.tax.tax_cents/100).toFixed(2)}}}}]}});
    res.json({id:j.id,total_cents:priced.total,mode:paypalMode()});
  }catch(e){console.error('PAYPAL CREATE',e);res.status(e.status||500).json({error:e.message||'Could not start PayPal checkout.'})}
});

app.post('/api/public/paypal/capture-order',checkoutLimit,async(req,res)=>{
  const schema=publicOrderSchema.extend({paypal_order_id:z.string().trim().min(8).max(80)});const p=schema.safeParse(req.body);
  if(!p.success)return res.status(400).json({error:'Invalid PayPal checkout information.'});
  const paypalOrderId=p.data.paypal_order_id;const payload={...p.data};delete payload.paypal_order_id;
  try{
    const existing=(await pool.query("SELECT * FROM orders WHERE payment_provider='paypal' AND payment_reference=$1",[paypalOrderId])).rows[0];
    if(existing&&existing.payment_status==='paid')return res.json({order_number:existing.order_number,total_cents:existing.total_cents,payment_status:'paid',paypal_order_id:paypalOrderId});
    const pp=await paypalRequest('/v2/checkout/orders/'+encodeURIComponent(paypalOrderId));
    const expectedValue=pp?.purchase_units?.[0]?.amount?.value;const expectedCurrency=pp?.purchase_units?.[0]?.amount?.currency_code;
    if(existing){
      if(expectedCurrency!=='USD'||Math.round(Number(expectedValue)*100)!==Number(existing.total_cents))return res.status(409).json({error:'The PayPal total does not match this order.'});
      let done=pp;
      if(pp.status!=='COMPLETED')done=await paypalRequest('/v2/checkout/orders/'+encodeURIComponent(paypalOrderId)+'/capture',{method:'POST',requestId:'pe-capture-'+paypalOrderId});
      if(done?.status!=='COMPLETED')return res.status(409).json({error:'PayPal did not complete the payment.'});
      const capId=paypalCaptureIdFromOrder(done||pp);const updated=(await pool.query("UPDATE orders SET payment_status='paid',paid_at=COALESCE(paid_at,now()),paypal_capture_id=COALESCE($2,paypal_capture_id),updated_at=now() WHERE id=$1 RETURNING *",[existing.id,capId])).rows[0];
      sendOrderConfirmation(updated.id).catch(console.error);
      return res.json({order_number:updated.order_number,total_cents:updated.total_cents,payment_status:'paid',paypal_order_id:paypalOrderId});
    }
    const priced=await pricePublicCheckout(payload);
    if(expectedCurrency!=='USD'||Math.round(Number(expectedValue)*100)!==priced.total)return res.status(409).json({error:'The order total changed before payment. Please reopen checkout and try again.'});

    let local=null;
    if(!local){
      let checkoutCustomerId=null;try{const raw=req.headers.authorization||'';if(raw.startsWith('Bearer ')){const data=jwt.verify(raw.slice(7),process.env.JWT_SECRET);if(data.type==='customer'&&data.customer_id)checkoutCustomerId=Number(data.customer_id)}}catch(_){}
      const c=await pool.connect();
      try{
        await c.query('BEGIN');const locked=await pricePublicCheckout(payload,{lockClient:c});
        if(locked.total!==priced.total){const e=new Error('The order total changed before payment. Please try again.');e.status=409;throw e}
        const orderNumber='PE-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
        const shippingAddress=payload.fulfillment==='shipping'?payload.shipping:null;
        local=(await c.query(`INSERT INTO orders(order_number,customer_name,customer_email,customer_phone,fulfillment,shipping_address,notes,subtotal_cents,tax_cents,shipping_cents,total_cents,shippo_rate_id,shippo_shipment_id,shipping_provider,shipping_service,customer_id,tax_state,tax_rate_bps_snapshot,payment_provider,payment_reference,payment_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'pending') RETURNING *`,[orderNumber,payload.customer.name,payload.customer.email.toLowerCase(),payload.customer.phone,payload.fulfillment,shippingAddress,payload.notes,locked.subtotal,locked.tax.tax_cents,locked.shippingCents,locked.total,locked.verifiedShipping?.rate_id||null,locked.verifiedShipping?.shipment_id||null,locked.verifiedShipping?.provider||null,locked.verifiedShipping?.service||null,checkoutCustomerId,locked.tax.state||null,locked.tax.rate_bps??null,'paypal',paypalOrderId])).rows[0];
        for(const item of locked.items){await c.query(`INSERT INTO order_items(order_id,inventory_id,item_title,quantity,unit_price_cents,line_total_cents) VALUES($1,$2,$3,$4,$5,$6)`,[local.id,item.inv.id,item.inv.title,item.quantity,item.unit,item.line]);await c.query('UPDATE inventory SET quantity=quantity-$1,updated_at=now() WHERE id=$2',[item.quantity,item.inv.id])}
        await c.query('COMMIT');
      }catch(e){try{await c.query('ROLLBACK')}catch{};throw e}finally{c.release()}
    }

    let captured;
    try{captured=await paypalRequest('/v2/checkout/orders/'+encodeURIComponent(paypalOrderId)+'/capture',{method:'POST',requestId:'pe-capture-'+paypalOrderId})}
    catch(captureErr){
      const check=await paypalRequest('/v2/checkout/orders/'+encodeURIComponent(paypalOrderId)).catch(()=>null);
      if(check?.status==='COMPLETED')captured=check;else{
        const c=await pool.connect();try{await c.query('BEGIN');const o=(await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[local.id])).rows[0];if(o&&o.payment_status!=='paid'&&!o.inventory_restocked){const its=(await c.query('SELECT inventory_id,quantity FROM order_items WHERE order_id=$1',[o.id])).rows;for(const it of its){if(it.inventory_id)await c.query('UPDATE inventory SET quantity=quantity+$1,updated_at=now() WHERE id=$2',[it.quantity,it.inventory_id])}await c.query("UPDATE orders SET order_status='cancelled',payment_status='cancelled',inventory_restocked=true,cancelled_at=now(),updated_at=now() WHERE id=$1",[o.id])}await c.query('COMMIT')}catch(e){try{await c.query('ROLLBACK')}catch{};console.error(e)}finally{c.release()}
        throw captureErr;
      }
    }
    const status=captured?.status||'';if(status!=='COMPLETED')throw Object.assign(new Error('PayPal did not complete the payment.'),{status:409});
    const capId=paypalCaptureIdFromOrder(captured);const updated=(await pool.query("UPDATE orders SET payment_status='paid',paid_at=COALESCE(paid_at,now()),paypal_capture_id=COALESCE($2,paypal_capture_id),updated_at=now() WHERE id=$1 RETURNING *",[local.id,capId])).rows[0];
    sendOrderConfirmation(updated.id).catch(console.error);
    res.json({order_number:updated.order_number,total_cents:updated.total_cents,payment_status:'paid',paypal_order_id:paypalOrderId});
  }catch(e){console.error('PAYPAL CAPTURE',e);res.status(e.status||500).json({error:e.message||'Could not complete PayPal payment.'})}
});

app.post('/api/public/orders',checkoutLimit,async(req,res)=>{
  if(String(process.env.ALLOW_UNPAID_ORDERS||'false').toLowerCase()!=='true')return res.status(410).json({error:'Unpaid order checkout is disabled. Please use PayPal checkout.'});
  let checkoutCustomerId=null;
  try{
    const raw=req.headers.authorization||'';
    if(raw.startsWith('Bearer ')){
      const data=jwt.verify(raw.slice(7),process.env.JWT_SECRET);
      if(data.type==='customer'&&data.customer_id)checkoutCustomerId=Number(data.customer_id);
    }
  }catch(_){}

  const p=publicOrderSchema.safeParse(req.body);
  if(!p.success)return res.status(400).json({error:'Please check the checkout information and try again.'});
  if(p.data.fulfillment==='shipping'&&!p.data.shipping)return res.status(400).json({error:'Shipping address is required.'});
  if(p.data.fulfillment==='shipping'&&!p.data.shippo_rate_id)return res.status(400).json({error:'Choose a shipping rate before placing the order.'});
  let verifiedShipping=null;
  try{if(p.data.fulfillment==='shipping')verifiedShipping=await verifyShippoRate(p.data.shippo_rate_id,p.data.shippo_shipment_id)}catch(e){return res.status(400).json({error:e.message||'Could not verify shipping rate.'})}
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    let subtotal=0; const items=[];
    for(const requested of p.data.items){
      const inv=(await c.query('SELECT id,title,quantity,price_cents,sale_price_cents,regulated,public_visible FROM inventory WHERE id=$1 FOR UPDATE',[requested.inventory_id])).rows[0];
      if(!inv||!inv.public_visible){const e=new Error('An item in your cart is no longer available.');e.status=409;throw e}
      if(inv.regulated){const e=new Error('Regulated items use the licensed-dealer checkout flow.');e.status=400;throw e}
      const unit=inv.sale_price_cents!=null?Number(inv.sale_price_cents):(inv.price_cents!=null?Number(inv.price_cents):null);
      if(unit==null){const e=new Error(`${inv.title} requires store pricing.`);e.status=400;throw e}
      if(inv.quantity<requested.quantity){const e=new Error(`Not enough ${inv.title} is available.`);e.status=409;throw e}
      const line=unit*requested.quantity; subtotal+=line;
      items.push({inv,unit,quantity:requested.quantity,line});
    }
    const orderNumber='PE-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
    const shippingAddress=p.data.fulfillment==='shipping'?p.data.shipping:null;
    const shippingCents=verifiedShipping?.cents||0;
    const tax=calculateSalesTax({subtotalCents:subtotal,shippingCents,state:p.data.shipping?.state,fulfillment:p.data.fulfillment});
    const total=subtotal+shippingCents+tax.tax_cents;
    const order=(await c.query(`INSERT INTO orders(order_number,customer_name,customer_email,customer_phone,fulfillment,shipping_address,notes,subtotal_cents,tax_cents,shipping_cents,total_cents,shippo_rate_id,shippo_shipment_id,shipping_provider,shipping_service,customer_id,tax_state,tax_rate_bps_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id,order_number,subtotal_cents,tax_cents,shipping_cents,total_cents,order_status,payment_status`,
      [orderNumber,p.data.customer.name,p.data.customer.email.toLowerCase(),p.data.customer.phone,p.data.fulfillment,shippingAddress,p.data.notes,subtotal,tax.tax_cents,shippingCents,total,verifiedShipping?.rate_id||null,verifiedShipping?.shipment_id||null,verifiedShipping?.provider||null,verifiedShipping?.service||null,checkoutCustomerId,tax.state||null,tax.rate_bps??null])).rows[0];
    for(const item of items){
      await c.query(`INSERT INTO order_items(order_id,inventory_id,item_title,quantity,unit_price_cents,line_total_cents) VALUES($1,$2,$3,$4,$5,$6)`,
        [order.id,item.inv.id,item.inv.title,item.quantity,item.unit,item.line]);
      await c.query('UPDATE inventory SET quantity=quantity-$1,updated_at=now() WHERE id=$2',[item.quantity,item.inv.id]);
    }
    await c.query('COMMIT');
    sendOrderConfirmation(order.id).catch(console.error);
    res.status(201).json({order_number:order.order_number,subtotal_cents:order.subtotal_cents,tax_cents:order.tax_cents,shipping_cents:order.shipping_cents,total_cents:order.total_cents,status:order.order_status,payment_status:order.payment_status});
  }catch(e){
    try{await c.query('ROLLBACK')}catch{}
    console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Could not place order. Please call the shop if the problem continues.'});
  }finally{c.release()}
});

const inventorySchema=z.object({title:z.string().min(1).max(180),category:z.string().min(1).max(80),quantity:z.number().int().min(0),cost_cents:z.number().int().min(0),price_cents:z.number().int().min(0).nullable().optional(),price_label:z.string().max(80).nullable().optional(),sku:z.string().max(80).nullable().optional(),item_type:z.enum(['quantity','individual']),low_stock:z.number().int().min(0),description:z.string().max(5000),image_url:z.string().max(5*1024*1024).refine(v=>/^https?:\/\//i.test(v)||/^data:image\/(jpeg|png|webp);base64,/i.test(v),'Image must be an http(s) URL or uploaded image').nullable().optional(),image_urls:z.array(z.string().max(5*1024*1024)).max(4).default([]),condition:z.string().min(1).max(80).default('Good'),sale_price_cents:z.number().int().min(0).nullable().optional(),featured:z.boolean().default(false),regulated:z.boolean().default(false),public_visible:z.boolean().default(true),shipping_weight_lb:z.number().positive().nullable().optional(),shipping_length_in:z.number().positive().nullable().optional(),shipping_width_in:z.number().positive().nullable().optional(),shipping_height_in:z.number().positive().nullable().optional()});
app.get('/api/inventory',auth,requireRole('viewer'),async (_req,res)=>{const {rows}=await pool.query('SELECT * FROM inventory ORDER BY updated_at DESC');res.json(rows);});
app.post('/api/inventory',auth,requireRole('manager'),async (req,res)=>{
  const p=inventorySchema.safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.issues}); const x=p.data;
  const {rows}=await pool.query(`INSERT INTO inventory(title,category,quantity,cost_cents,price_cents,price_label,sku,item_type,low_stock,description,image_url,image_urls,condition,sale_price_cents,featured,regulated,public_visible,shipping_weight_lb,shipping_length_in,shipping_width_in,shipping_height_in) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,[x.title,x.category,x.quantity,x.cost_cents,x.price_cents??null,x.price_label??null,x.sku||null,x.item_type,x.low_stock,x.description,x.image_url??(x.image_urls?.[0]||null),JSON.stringify(x.image_urls||[]),x.condition,x.sale_price_cents??null,x.featured,x.regulated,x.public_visible,x.shipping_weight_lb??null,x.shipping_length_in??null,x.shipping_width_in??null,x.shipping_height_in??null]);
  await audit(req,'CREATE','inventory',rows[0].id,{title:x.title,regulated:x.regulated}); res.status(201).json(rows[0]);
});
app.post('/api/inventory/:id/duplicate',auth,requireRole('manager'),async(req,res)=>{
  try{
    const {rows}=await pool.query(`INSERT INTO inventory(title,category,quantity,cost_cents,price_cents,price_label,sku,item_type,low_stock,description,image_url,image_urls,condition,sale_price_cents,featured,regulated,public_visible,shipping_weight_lb,shipping_length_in,shipping_width_in,shipping_height_in)
      SELECT title || ' COPY',category,quantity,cost_cents,price_cents,price_label,NULL,item_type,low_stock,description,image_url,image_urls,condition,sale_price_cents,false,regulated,false,shipping_weight_lb,shipping_length_in,shipping_width_in,shipping_height_in
      FROM inventory WHERE id=$1 RETURNING *`,[req.params.id]);
    if(!rows[0])return res.status(404).json({error:'Inventory item not found'});
    await audit(req,'DUPLICATE','inventory',rows[0].id,{source_id:req.params.id,title:rows[0].title});
    res.status(201).json(rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Could not duplicate inventory item'})}
});
app.patch('/api/inventory/:id',auth,requireRole('manager'),async (req,res)=>{
  const p=inventorySchema.partial().safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.issues}); const keys=Object.keys(p.data); if(!keys.length)return res.status(400).json({error:'No changes'});
  const map={price_cents:'price_cents',price_label:'price_label',title:'title',category:'category',quantity:'quantity',cost_cents:'cost_cents',sku:'sku',item_type:'item_type',low_stock:'low_stock',description:'description',image_url:'image_url',image_urls:'image_urls',condition:'condition',sale_price_cents:'sale_price_cents',featured:'featured',regulated:'regulated',public_visible:'public_visible',shipping_weight_lb:'shipping_weight_lb',shipping_length_in:'shipping_length_in',shipping_width_in:'shipping_width_in',shipping_height_in:'shipping_height_in'};
  const vals=[]; const sets=[]; keys.forEach((k,i)=>{sets.push(`${map[k]}=$${i+1}`); vals.push(k==='image_urls'?JSON.stringify(p.data[k]||[]):(p.data[k]??null))}); vals.push(req.params.id);
  const {rows}=await pool.query(`UPDATE inventory SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals); if(!rows[0])return res.status(404).json({error:'Inventory item not found'});
  await audit(req,'UPDATE','inventory',rows[0].id,{fields:keys}); res.json(rows[0]);
});
const publicOfferSchema=z.object({
  inventory_id:z.string().uuid(),
  customer:z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(180),phone:z.string().trim().max(40).optional().default('')}),
  offer_cents:z.number().int().min(100),
  message:z.string().trim().max(1000).optional().default('')
});
app.post('/api/public/offers',checkoutLimit,async(req,res)=>{
  const p=publicOfferSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Enter your name, email and a valid offer.'});
  try{
    const inv=(await pool.query('SELECT id,title,quantity,price_cents,sale_price_cents,public_visible FROM inventory WHERE id=$1',[p.data.inventory_id])).rows[0];
    if(!inv||!inv.public_visible||Number(inv.quantity)<=0)return res.status(409).json({error:'This item is no longer available.'});
    const asking=inv.sale_price_cents!=null?Number(inv.sale_price_cents):(inv.price_cents!=null?Number(inv.price_cents):null);
    const {rows}=await pool.query(`INSERT INTO offers(inventory_id,item_title,asking_price_cents,offer_cents,customer_name,customer_email,customer_phone,customer_message) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,status,created_at`,[inv.id,inv.title,asking,p.data.offer_cents,p.data.customer.name,p.data.customer.email.toLowerCase(),p.data.customer.phone||null,p.data.message||'']);
    res.status(201).json({ok:true,offer_id:rows[0].id,status:rows[0].status});
  }catch(e){console.error(e);res.status(500).json({error:'Could not submit offer'})}
});
app.get('/api/offers',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query('SELECT * FROM offers ORDER BY created_at DESC LIMIT 1000');res.json(rows)});
app.patch('/api/offers/:id',auth,requireRole('manager'),async(req,res)=>{
  const p=z.object({status:z.enum(['new','contacted','accepted','countered','declined','expired']).optional(),counter_cents:z.number().int().min(0).nullable().optional(),admin_notes:z.string().max(3000).optional()}).safeParse(req.body);
  if(!p.success)return res.status(400).json({error:'Invalid offer update'});const keys=Object.keys(p.data);if(!keys.length)return res.status(400).json({error:'No changes'});
  const vals=[],sets=[];keys.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(p.data[k]??null)});vals.push(req.params.id);
  const {rows}=await pool.query(`UPDATE offers SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);if(!rows[0])return res.status(404).json({error:'Offer not found'});await audit(req,'UPDATE','offer',rows[0].id,{fields:keys});res.json(rows[0]);
});
app.post('/api/sales',auth,requireRole('manager'),async(req,res)=>{
  const p=z.object({inventory_id:z.string().uuid(),quantity:z.number().int().positive(),gross_cents:z.number().int().min(0),tax_cents:z.number().int().min(0),payment_method:z.string().min(1).max(80),order_ref:z.string().max(120).nullable().optional()}).safeParse(req.body);
  if(!p.success)return res.status(400).json({error:p.error.issues}); const c=await pool.connect();
  try{await c.query('BEGIN'); const i=(await c.query('SELECT * FROM inventory WHERE id=$1 FOR UPDATE',[p.data.inventory_id])).rows[0]; if(!i)return res.status(404).json({error:'Item not found'}); if(i.quantity<p.data.quantity)return res.status(409).json({error:'Insufficient inventory'});
    const sale=(await c.query(`INSERT INTO sales(inventory_id,item_title,quantity,gross_cents,tax_cents,cost_cents,payment_method,order_ref,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[i.id,i.title,p.data.quantity,p.data.gross_cents,p.data.tax_cents,i.cost_cents*p.data.quantity,p.data.payment_method,p.data.order_ref??null,req.user.sub])).rows[0];
    await c.query('UPDATE inventory SET quantity=quantity-$1,updated_at=now() WHERE id=$2',[p.data.quantity,i.id]); await c.query('COMMIT'); await audit(req,'CREATE','sale',sale.id,{inventory_id:i.id,quantity:p.data.quantity}); res.status(201).json(sale);
  }catch(e){await c.query('ROLLBACK'); res.status(500).json({error:'Could not record sale'});}finally{c.release();}
});
app.get('/api/sales',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query('SELECT * FROM sales ORDER BY created_at DESC LIMIT 1000');res.json(rows);});
app.delete('/api/inventory/:id',auth,requireRole('manager'),async(req,res)=>{const {rows}=await pool.query('DELETE FROM inventory WHERE id=$1 RETURNING id,title',[req.params.id]); if(!rows[0]) return res.status(404).json({error:'Inventory item not found'}); await audit(req,'DELETE','inventory',rows[0].id,{title:rows[0].title}); res.status(204).end();});
app.get('/api/traffic',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query('SELECT id,traffic_date,visitors FROM foot_traffic ORDER BY traffic_date DESC LIMIT 1000');res.json(rows);});
app.post('/api/traffic',auth,requireRole('manager'),async(req,res)=>{const p=z.object({traffic_date:z.string(),visitors:z.number().int().min(0)}).safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.issues}); const {rows}=await pool.query(`INSERT INTO foot_traffic(traffic_date,visitors,created_by) VALUES($1,$2,$3) ON CONFLICT(traffic_date) DO UPDATE SET visitors=EXCLUDED.visitors,created_by=EXCLUDED.created_by RETURNING *`,[p.data.traffic_date,p.data.visitors,req.user.sub]); await audit(req,'UPSERT','foot_traffic',rows[0].id,{traffic_date:p.data.traffic_date,visitors:p.data.visitors}); res.status(201).json(rows[0]);});

app.get('/api/orders',auth,requireRole('viewer'),async(req,res)=>{
  const includeHidden=String(req.query.include_hidden||'false')==='true';
  const {rows}=await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('title',oi.item_title,'quantity',oi.quantity,'unit_price_cents',oi.unit_price_cents,'line_total_cents',oi.line_total_cents)) FILTER (WHERE oi.id IS NOT NULL),'[]') AS items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE ($1::boolean=true OR o.admin_hidden=false) GROUP BY o.id ORDER BY o.created_at DESC LIMIT 1000`,[includeHidden]);
  res.json(rows);
});
app.patch('/api/orders/:id',auth,requireRole('manager'),async(req,res)=>{
  const p=z.object({order_status:z.enum(['new','confirmed','ready','shipped','completed','cancelled']).optional(),payment_status:z.enum(['pending','paid','refunded','cancelled']).optional(),tracking_number:z.string().max(180).nullable().optional(),admin_notes:z.string().max(3000).optional(),paid_at:z.coerce.date().optional(),shipped_at:z.coerce.date().optional(),completed_at:z.coerce.date().optional(),cancelled_at:z.coerce.date().optional(),admin_hidden:z.boolean().optional(),refunded_cents:z.number().int().min(0).optional(),refunded_tax_cents:z.number().int().min(0).optional(),refunded_at:z.coerce.date().nullable().optional()}).safeParse(req.body);
  if(!p.success)return res.status(400).json({error:p.error.issues});const keys=Object.keys(p.data);if(!keys.length)return res.status(400).json({error:'No changes'});
  const c=await pool.connect();try{await c.query('BEGIN');const current=(await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!current){await c.query('ROLLBACK');return res.status(404).json({error:'Order not found'})}
    if(p.data.order_status==='cancelled'&&!current.inventory_restocked){const {rows:items}=await c.query('SELECT inventory_id,quantity FROM order_items WHERE order_id=$1',[current.id]);for(const i of items)if(i.inventory_id)await c.query('UPDATE inventory SET quantity=quantity+$1,updated_at=now() WHERE id=$2',[i.quantity,i.inventory_id]);p.data.inventory_restocked=true}
    if(p.data.payment_status==='paid'&&!current.paid_at)p.data.paid_at=new Date();
    if(p.data.order_status==='shipped'&&!current.shipped_at)p.data.shipped_at=new Date();
    if(p.data.order_status==='completed'&&!current.completed_at)p.data.completed_at=new Date();
    if(p.data.order_status==='cancelled'&&!current.cancelled_at)p.data.cancelled_at=new Date();
    const k2=Object.keys(p.data);const vals=[];const sets=[];k2.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(p.data[k]??null)});vals.push(req.params.id);const {rows}=await c.query(`UPDATE orders SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);await c.query('COMMIT');await audit(req,'UPDATE','order',rows[0].id,{fields:k2});const changedStatus=p.data.order_status&&p.data.order_status!==current.order_status;res.json(rows[0]);if(changedStatus&&['confirmed','ready','shipped','completed','cancelled'].includes(p.data.order_status))sendOrderEmail(rows[0].id,p.data.order_status).catch(console.error);
  }catch(e){try{await c.query('ROLLBACK')}catch{};console.error(e);res.status(500).json({error:'Could not update order'})}finally{c.release()}
});



app.post('/api/orders/:id/paypal-refund',auth,requireRole('manager'),async(req,res)=>{
  try{
    const order=(await pool.query('SELECT * FROM orders WHERE id=$1',[req.params.id])).rows[0];
    if(!order)return res.status(404).json({error:'Order not found'});
    if(order.payment_provider!=='paypal'||!order.payment_reference)return res.status(400).json({error:'This order was not paid through PayPal.'});
    if(order.payment_status==='refunded')return res.json({ok:true,already_refunded:true,order});
    if(order.paypal_refund_id){const synced=await syncPaypalRefundState(order);return res.json({ok:true,existing_refund:true,...synced})}
    const {captureId}=await paypalResolveCapture(order);
    const refund=await paypalRequest('/v2/payments/captures/'+encodeURIComponent(captureId)+'/refund',{method:'POST',requestId:'pe-refund-'+order.id,body:{amount:{currency_code:'USD',value:(Number(order.total_cents||0)/100).toFixed(2)},note_to_payer:'Pink Elephant Gun & Pawn order refund'}});
    const amount=Math.round(Number(refund?.amount?.value||Number(order.total_cents||0)/100)*100);
    await pool.query('UPDATE orders SET paypal_capture_id=$1,paypal_refund_id=$2,refund_status=$3,refunded_cents=$4,updated_at=now() WHERE id=$5',[captureId,refund.id||null,refund.status||'PENDING',amount,order.id]);
    let updated=(await pool.query('SELECT * FROM orders WHERE id=$1',[order.id])).rows[0];
    if(refund.status==='COMPLETED')updated=await finalizePaypalRefund(order.id,{refundId:refund.id,refundStatus:refund.status,amountCents:amount});
    await audit(req,'PAYPAL_REFUND','order',order.id,{paypal_refund_id:refund.id,status:refund.status,amount_cents:amount});
    res.json({ok:true,refund_status:refund.status,refund_id:refund.id,order:updated});
  }catch(e){console.error('PAYPAL REFUND',e);res.status(e.status||500).json({error:e.message||'Could not refund PayPal order.'})}
});
app.post('/api/orders/:id/paypal-sync',auth,requireRole('manager'),async(req,res)=>{
  try{
    const order=(await pool.query('SELECT * FROM orders WHERE id=$1',[req.params.id])).rows[0];
    if(!order)return res.status(404).json({error:'Order not found'});
    const synced=await syncPaypalRefundState(order);
    await audit(req,'PAYPAL_SYNC','order',order.id,synced.paypal||{});
    res.json({ok:true,...synced});
  }catch(e){console.error('PAYPAL SYNC',e);res.status(e.status||500).json({error:e.message||'Could not sync PayPal order.'})}
});

app.post('/api/orders/archive-test-labels',auth,requireRole('manager'),async(req,res)=>{
  try{
    const {rows}=await pool.query(`UPDATE orders SET admin_hidden=true,updated_at=now()
      WHERE shipping_label_test=true AND admin_hidden=false RETURNING id,order_number`);
    await audit(req,'ARCHIVE','orders',null,{reason:'test_labels',count:rows.length});
    res.json({archived:rows.length,orders:rows});
  }catch(e){console.error(e);res.status(500).json({error:'Could not archive test orders'})}
});
app.post('/api/orders/:id/archive',auth,requireRole('manager'),async(req,res)=>{
  try{
    const {rows}=await pool.query('UPDATE orders SET admin_hidden=true,updated_at=now() WHERE id=$1 RETURNING id,order_number',[req.params.id]);
    if(!rows[0])return res.status(404).json({error:'Order not found'});
    await audit(req,'ARCHIVE','order',rows[0].id,{order_number:rows[0].order_number});
    res.json(rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Could not archive order'})}
});
app.post('/api/orders/:id/unarchive',auth,requireRole('manager'),async(req,res)=>{
  try{
    const {rows}=await pool.query('UPDATE orders SET admin_hidden=false,updated_at=now() WHERE id=$1 RETURNING id,order_number',[req.params.id]);
    if(!rows[0])return res.status(404).json({error:'Order not found'});
    await audit(req,'UNARCHIVE','order',rows[0].id,{order_number:rows[0].order_number});
    res.json(rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Could not restore order'})}
});

app.post('/api/orders/:id/send-confirmation',auth,requireRole('manager'),async(req,res)=>{
  try{const result=await sendOrderConfirmation(req.params.id);if(!result.sent)return res.status(503).json({error:result.reason});res.json(result)}catch(e){console.error(e);res.status(500).json({error:'Could not send confirmation email'})}
});

app.post('/api/orders/:id/label',auth,requireRole('manager'),async(req,res)=>{
  try{
    const {rows}=await pool.query('SELECT * FROM orders WHERE id=$1',[req.params.id]);const o=rows[0];if(!o)return res.status(404).json({error:'Order not found'});
    if(o.fulfillment!=='shipping')return res.status(400).json({error:'Pickup orders do not need a shipping label.'});
    if(o.shipping_label_url)return res.json({label_url:o.shipping_label_url,tracking_number:o.tracking_number,tracking_url:o.tracking_url,test:o.shipping_label_test,existing:true});
    if(!o.shippo_rate_id)return res.status(400).json({error:'This order does not have a Shippo rate. Recreate the order shipping quote first.'});
    const token=process.env.SHIPPO_API_TOKEN||'';if(token.startsWith('shippo_live_')&&String(process.env.ALLOW_LIVE_LABEL_PURCHASE||'false').toLowerCase()!=='true')return res.status(403).json({error:'Live label purchase is locked. Set ALLOW_LIVE_LABEL_PURCHASE=true only when you are ready to buy real postage.'});
    const r=await fetch(SHIPPO_API+'/transactions',{method:'POST',headers:shippoHeaders(),body:JSON.stringify({rate:o.shippo_rate_id,async:false,label_file_type:'PDF_4x6',metadata:o.order_number.slice(0,100)})});
    const j=await r.json().catch(()=>({}));if(!r.ok||j.status==='ERROR')return res.status(502).json({error:j.messages?.map(x=>x.text).filter(Boolean).join('; ')||j.detail||j.message||'Shippo could not create the label.'});
    const {rows:updated}=await pool.query(`UPDATE orders SET shippo_transaction_id=$1,shipping_label_url=$2,tracking_number=COALESCE($3,tracking_number),tracking_url=$4,shipping_label_test=$5,label_created_at=now(),updated_at=now() WHERE id=$6 RETURNING *`,[j.object_id||null,j.label_url||null,j.tracking_number||null,j.tracking_url_provider||null,!!j.test,o.id]);
    await audit(req,'CREATE','shipping_label',o.id,{shippo_transaction_id:j.object_id,test:!!j.test});
    res.status(201).json({label_url:j.label_url,tracking_number:j.tracking_number,tracking_url:j.tracking_url_provider,test:!!j.test,transaction_id:j.object_id,order:updated[0]});
  }catch(e){console.error(e);res.status(500).json({error:e.message||'Could not create shipping label'})}
});

app.post('/api/orders/:id/refund-label',auth,requireRole('manager'),async(req,res)=>{
  try{const o=(await pool.query('SELECT * FROM orders WHERE id=$1',[req.params.id])).rows[0];if(!o)return res.status(404).json({error:'Order not found'});if(!o.shippo_transaction_id)return res.status(400).json({error:'No Shippo label exists for this order.'});
    const r=await fetch(SHIPPO_API+'/refunds',{method:'POST',headers:shippoHeaders(),body:JSON.stringify({transaction:o.shippo_transaction_id,async:false})});const j=await r.json().catch(()=>({}));if(!r.ok)return res.status(502).json({error:j.detail||j.message||'Shippo could not request the label refund.'});
    await pool.query('UPDATE orders SET shippo_refund_id=$1,shippo_refund_status=$2,updated_at=now() WHERE id=$3',[j.object_id||null,j.status||'PENDING',o.id]);await audit(req,'REFUND','shipping_label',o.id,{refund_id:j.object_id,status:j.status});res.json(j);
  }catch(e){console.error(e);res.status(500).json({error:e.message||'Could not refund shipping label'})}
});



const ATF_STATE_LAWS_URL='https://www.atf.gov/firearms/tools-and-services-firearms-industry/state-laws-and-published-ordinances-firearms';
const ATF_EZCHECK_URL='https://fflezcheck.atf.gov/FFLEzCheck/fflSearch.action?warning_banner_accept=true';
const STATE_NAMES={AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
const STATE_REVIEW_TEMPLATE=code=>({
  state_code:code,state_name:STATE_NAMES[code]||code,review_level:'manual_review',
  summary:`Manual compliance review required before release. Confirm current ${STATE_NAMES[code]||code} law for the firearm type, purchaser residency/age, permits or waiting periods, prohibited configurations/features, magazine restrictions, and any applicable local rules. Do not rely on this summary alone.`,
  source_url:ATF_STATE_LAWS_URL
});
async function ensureStateLawProfiles(){
  for(const code of Object.keys(STATE_NAMES)){
    const x=STATE_REVIEW_TEMPLATE(code);
    await pool.query(`INSERT INTO state_law_profiles(state_code,state_name,review_level,summary,source_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(state_code) DO NOTHING`,[x.state_code,x.state_name,x.review_level,x.summary,x.source_url]);
  }
}
app.get('/api/state-law-profiles',auth,requireRole('viewer'),async(_req,res)=>{
  try{await ensureStateLawProfiles();const {rows}=await pool.query('SELECT * FROM state_law_profiles ORDER BY state_name');res.json({official_atf_url:ATF_STATE_LAWS_URL,ffl_ezcheck_url:ATF_EZCHECK_URL,profiles:rows})}
  catch(e){console.error(e);res.status(500).json({error:'Could not load state law references'})}
});
app.patch('/api/state-law-profiles/:state',auth,requireRole('manager'),async(req,res)=>{
  const code=String(req.params.state||'').toUpperCase();if(!STATE_NAMES[code])return res.status(404).json({error:'Unknown state'});
  const p=z.object({review_level:z.enum(['manual_review','restricted','blocked','store_policy_ok']).optional(),summary:z.string().max(6000).optional(),internal_notes:z.string().max(6000).optional(),source_url:z.string().url().max(1000).optional(),mark_verified:z.boolean().optional()}).safeParse(req.body);
  if(!p.success)return res.status(400).json({error:'Invalid state-law update'});await ensureStateLawProfiles();
  const x=p.data;const {rows}=await pool.query(`UPDATE state_law_profiles SET review_level=COALESCE($1,review_level),summary=COALESCE($2,summary),internal_notes=COALESCE($3,internal_notes),source_url=COALESCE($4,source_url),last_verified_at=CASE WHEN $5 THEN now() ELSE last_verified_at END,updated_at=now(),updated_by=$6 WHERE state_code=$7 RETURNING *`,[x.review_level??null,x.summary??null,x.internal_notes??null,x.source_url??null,!!x.mark_verified,req.user.sub,code]);
  await audit(req,'UPDATE','state_law_profile',null,{state:code,fields:Object.keys(x)});res.json(rows[0]);
});


const atfUpload=multer({
  storage:multer.diskStorage({
    destination:(_req,_file,cb)=>cb(null,os.tmpdir()),
    filename:(_req,file,cb)=>cb(null,`pink-elephant-atf-${Date.now()}-${String(file.originalname||'ffl').replace(/[^a-zA-Z0-9._-]/g,'_')}`)
  }),
  limits:{fileSize:100*1024*1024}
});
function firstField(row,names){for(const n of names){if(row[n]!==undefined&&row[n]!==null&&String(row[n]).trim()!=='')return String(row[n]).trim()}return ''}
function atfDealerFromRow(row){
  const norm={};for(const [k,v] of Object.entries(row||{}))norm[String(k).trim().toUpperCase().replace(/[^A-Z0-9]+/g,'_')]=v;
  const type=firstField(norm,['LIC_TYPE','LICENSE_TYPE','TYPE']).padStart(2,'0');
  if(['03','06'].includes(type))return null;
  const name=firstField(norm,['BUSINESS_NAME','TRADE_NAME','DBA_NAME','LICENSE_NAME','LIC_NAME']);
  const address1=firstField(norm,['PREMISE_STREET','PREMISE_ADDRESS','PREMISES_STREET','STREET']);
  const city=firstField(norm,['PREMISE_CITY','PREMISES_CITY','CITY']);
  const state=firstField(norm,['PREMISE_STATE','PREMISES_STATE','STATE']).toUpperCase();
  let postal=firstField(norm,['PREMISE_ZIP_CODE','PREMISE_ZIP','PREMISES_ZIP_CODE','ZIP_CODE','ZIP']);postal=postal.replace(/\.0$/,'').padStart(5,'0');
  if(!name||!address1||!city||!state||postal.length<5)return null;
  const zip5=postal.slice(0,5),z=zipcodes.lookup(zip5)||{};
  const zlat=Number(z.latitude),zlng=Number(z.longitude);
  let lic=firstField(norm,['FFL_NUMBER','LICENSE_NUMBER','LIC_NUMBER','LIC_NO']);
  if(!lic){
    const parts=['LIC_REGN','LIC_DIST','LIC_CNTY','LIC_TYPE','LIC_XPRDTE','LIC_SEQN'].map(k=>firstField(norm,[k]));
    if(parts.every(Boolean))lic=parts.join('-');
  }
  const phone=firstField(norm,['VOICE_PHONE','PHONE','TELEPHONE']);
  return {name,address1,city,state,postal:zip5,phone:phone||null,license_type:type||null,source_license_number:lic||null,latitude:Number.isFinite(zlat)?zlat:null,longitude:Number.isFinite(zlng)?zlng:null};
}
async function upsertAtfBatch(batch){
  let added=0,updated=0;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    for(const d of batch){
      const r=await client.query(`INSERT INTO ffl_dealers(name,address1,city,state,postal,phone,active,latitude,longitude,source,source_license_number,license_type,source_updated_at)
        VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,'ATF',$9,$10,now())
        ON CONFLICT (source,name,address1,city,state,postal) DO UPDATE SET phone=COALESCE(EXCLUDED.phone,ffl_dealers.phone),latitude=COALESCE(EXCLUDED.latitude,ffl_dealers.latitude),longitude=COALESCE(EXCLUDED.longitude,ffl_dealers.longitude),source_license_number=COALESCE(EXCLUDED.source_license_number,ffl_dealers.source_license_number),license_type=COALESCE(EXCLUDED.license_type,ffl_dealers.license_type),active=true,source_updated_at=now(),updated_at=now() RETURNING (xmax = 0) AS inserted`,[d.name,d.address1,d.city,d.state,d.postal,d.phone,d.latitude,d.longitude,d.source_license_number,d.license_type]);
      if(r.rows[0]?.inserted)added++;else updated++;
    }
    await client.query('COMMIT');return {added,updated};
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
async function importAtfCsvStream(filePath){
  let batch=[],rows=0,added=0,updated=0;
  const stream=createReadStream(filePath).pipe(csvParser({mapHeaders:({header})=>String(header||'').replace(/^\uFEFF/,'').trim()}));
  for await(const row of stream){
    const d=atfDealerFromRow(row);if(!d)continue;
    batch.push(d);rows++;
    if(batch.length>=250){const r=await upsertAtfBatch(batch);added+=r.added;updated+=r.updated;batch=[]}
  }
  if(batch.length){const r=await upsertAtfBatch(batch);added+=r.added;updated+=r.updated}
  return {rows,added,updated};
}
app.post('/api/ffl-dealers/import-atf',auth,requireRole('manager'),atfUpload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose the official ATF complete FFL .csv file first.'});
  const filePath=req.file.path;
  try{
    const ext=path.extname(req.file.originalname||'').toLowerCase();
    if(ext!=='.csv')return res.status(400).json({error:'Upload the official ATF complete FFL .csv file.'});
    const result=await importAtfCsvStream(filePath);
    if(!result.rows)return res.status(400).json({error:'No usable FFL dealer rows were found in the ATF CSV.'});
    await audit(req,'IMPORT','ffl_dealers',null,{source:'ATF',...result,file:req.file.originalname});
    res.json({ok:true,...result});
  }catch(e){console.error('ATF FFL CSV streaming import error',e);res.status(500).json({error:'Could not import the ATF dealer CSV. Check Render logs for ATF FFL CSV streaming import error.'})}
  finally{if(filePath)fs.unlink(filePath).catch(()=>{})}
});
app.get('/api/ffl-dealers/import-status',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query(`SELECT count(*)::int AS total,max(source_updated_at) AS last_import FROM ffl_dealers WHERE source='ATF'`);res.json(rows[0])});

const dealerSchema=z.object({
  name:z.string().trim().min(2).max(180),address1:z.string().trim().min(2).max(180),city:z.string().trim().min(2).max(100),state:z.string().trim().min(2).max(50),postal:z.string().trim().min(3).max(20),
  phone:z.string().trim().max(40).nullable().optional(),email:z.string().trim().email().max(180).nullable().optional(),license_on_file:z.boolean().default(false),preferred:z.boolean().default(false),active:z.boolean().default(true),
  latitude:z.number().min(-90).max(90).nullable().optional(),longitude:z.number().min(-180).max(180).nullable().optional()
});
app.get('/api/public/ffl-dealers',async(req,res)=>{
  const q=String(req.query.q||'').trim(),zipMatch=q.match(/\b(\d{5})\b/),latQ=Number(req.query.lat),lngQ=Number(req.query.lng);
  let lat=Number.isFinite(latQ)?latQ:null,lng=Number.isFinite(lngQ)?lngQ:null;
  if((lat==null||lng==null)&&zipMatch){const z=zipcodes.lookup(zipMatch[1])||{};const a=Number(z.latitude),b=Number(z.longitude);if(Number.isFinite(a)&&Number.isFinite(b)){lat=a;lng=b}}
  const hasGeo=Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;
  const fields='id,name,address1,city,state,postal,phone,license_on_file,preferred,latitude,longitude,source,source_license_number,license_type';
  let rows=[];
  if(zipMatch&&typeof zipcodes.radius==='function'){
    const nearbyZips=zipcodes.radius(zipMatch[1],110)||[];
    const zips=[...new Set([zipMatch[1],...nearbyZips].map(x=>typeof x==='string'?x:String(x?.zip||x?.zipcode||'')).filter(x=>/^\d{5}$/.test(x)))];
    if(zips.length){rows=(await pool.query(`SELECT ${fields} FROM ffl_dealers WHERE active=true AND postal = ANY($1::text[]) LIMIT 6000`,[zips])).rows}
  }
  if(!rows.length&&hasGeo){
    const latPad=1.7,lngPad=Math.min(3.2,1.7/Math.max(Math.cos(lat*Math.PI/180),0.35));
    rows=(await pool.query(`SELECT ${fields} FROM ffl_dealers WHERE active=true AND latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4 LIMIT 6000`,[lat-latPad,lat+latPad,lng-lngPad,lng+lngPad])).rows;
  }
  if(!rows.length){
    const values=[];let where='active=true';
    if(q&&!zipMatch){values.push('%'+q+'%');where+=` AND (name ILIKE $1 OR city ILIKE $1 OR state ILIKE $1 OR postal ILIKE $1 OR address1 ILIKE $1)`}
    else if(zipMatch){values.push(zipMatch[1]);where+=` AND postal=$1`}
    rows=(await pool.query(`SELECT ${fields} FROM ffl_dealers WHERE ${where} LIMIT 500`,values)).rows;
  }
  const rad=x=>x*Math.PI/180;const distance=(a,b,c,d)=>{const R=3958.8,da=rad(c-a),dl=rad(d-b),h=Math.sin(da/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.sqrt(h))};
  let out=rows.map(x=>{let a=Number(x.latitude),b=Number(x.longitude);if(!Number.isFinite(a)||!Number.isFinite(b)){const z=zipcodes.lookup(String(x.postal||'').slice(0,5))||{};a=Number(z.latitude);b=Number(z.longitude)}return {...x,latitude:Number.isFinite(a)?a:null,longitude:Number.isFinite(b)?b:null,distance_miles:hasGeo&&Number.isFinite(a)&&Number.isFinite(b)?Math.round(distance(lat,lng,a,b)*10)/10:null}});
  if(hasGeo)out=out.filter(x=>x.distance_miles!=null&&x.distance_miles<=100).sort((a,b)=>a.distance_miles-b.distance_miles||Number(b.preferred)-Number(a.preferred)||a.name.localeCompare(b.name)).slice(0,75);
  else out=out.sort((a,b)=>Number(b.preferred)-Number(a.preferred)||Number(b.license_on_file)-Number(a.license_on_file)||a.name.localeCompare(b.name)).slice(0,75);
  res.json(out);
});
app.get('/api/ffl-dealers',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query('SELECT * FROM ffl_dealers ORDER BY active DESC,preferred DESC,name');res.json(rows)});
app.post('/api/ffl-dealers',auth,requireRole('manager'),async(req,res)=>{
  const p=dealerSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:p.error.issues});const x=p.data;
  const {rows}=await pool.query(`INSERT INTO ffl_dealers(name,address1,city,state,postal,phone,email,license_on_file,preferred,active,latitude,longitude) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[x.name,x.address1,x.city,x.state,x.postal,x.phone||null,x.email||null,x.license_on_file,x.preferred,x.active,x.latitude??null,x.longitude??null]);
  await audit(req,'CREATE','ffl_dealer',rows[0].id,{name:x.name});res.status(201).json(rows[0]);
});
app.patch('/api/ffl-dealers/:id',auth,requireRole('manager'),async(req,res)=>{
  const p=dealerSchema.partial().safeParse(req.body);if(!p.success)return res.status(400).json({error:p.error.issues});const keys=Object.keys(p.data);if(!keys.length)return res.status(400).json({error:'No changes'});
  const vals=[];const sets=[];keys.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(p.data[k]??null)});vals.push(req.params.id);
  const {rows}=await pool.query(`UPDATE ffl_dealers SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);if(!rows[0])return res.status(404).json({error:'Dealer not found'});await audit(req,'UPDATE','ffl_dealer',rows[0].id,{fields:keys});res.json(rows[0]);
});
app.delete('/api/ffl-dealers/:id',auth,requireRole('manager'),async(req,res)=>{const {rows}=await pool.query('DELETE FROM ffl_dealers WHERE id=$1 RETURNING id,name',[req.params.id]);if(!rows[0])return res.status(404).json({error:'Dealer not found'});await audit(req,'DELETE','ffl_dealer',rows[0].id,{name:rows[0].name});res.status(204).end()});

const fflRequestSchema=z.object({
  inventory_id:z.string().uuid(),
  customer:z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(180),phone:z.string().trim().min(7).max(40),address1:z.string().trim().max(180).optional(),city:z.string().trim().max(100).optional(),state:z.string().trim().min(2).max(50),postal:z.string().trim().max(20).optional(),date_of_birth:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),residence_state:z.string().trim().min(2).max(2)}),
  request_type:z.enum(['store_pickup','ffl_transfer']),dealer_id:z.string().uuid().nullable().optional(),
  receiving_ffl_name:z.string().trim().max(180).nullable().optional(),receiving_ffl_phone:z.string().trim().max(40).nullable().optional(),
  shipping_method:z.enum(['store_pickup','standard_ground','store_review']).default('store_review'),age_certified:z.literal(true),notes:z.string().trim().max(1500).default('')
});
app.post('/api/public/ffl-requests',checkoutLimit,async(req,res)=>{
  const p=fflRequestSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Please check every required checkout field, including date of birth, residence state, and certification.'});
  const dob=new Date(p.data.customer.date_of_birth+'T12:00:00Z');if(Number.isNaN(dob.getTime()))return res.status(400).json({error:'Enter a valid date of birth.'});
  const now=new Date();let age=now.getUTCFullYear()-dob.getUTCFullYear();const m=now.getUTCMonth()-dob.getUTCMonth();if(m<0||(m===0&&now.getUTCDate()<dob.getUTCDate()))age--;if(age<18)return res.status(400).json({error:'Online firearm requests cannot be submitted by a person under 18.'});
  const residence=String(p.data.customer.residence_state||'').toUpperCase();if(!STATE_NAMES[residence])return res.status(400).json({error:'Choose a valid state of residence.'});
  const inv=(await pool.query('SELECT id,title,regulated,quantity,public_visible,price_cents,sale_price_cents FROM inventory WHERE id=$1',[p.data.inventory_id])).rows[0];
  if(!inv||!inv.public_visible||inv.quantity<1)return res.status(404).json({error:'This item is no longer available.'});if(!inv.regulated)return res.status(400).json({error:'This checkout is only for regulated items.'});
  let dealer=null;if(p.data.request_type==='ffl_transfer'){if(!p.data.dealer_id)return res.status(400).json({error:'Choose a receiving FFL dealer before continuing.'});dealer=(await pool.query('SELECT id,name,address1,city,state,postal,phone,license_on_file,preferred,source,source_license_number,license_type FROM ffl_dealers WHERE id=$1 AND active=true',[p.data.dealer_id])).rows[0];if(!dealer)return res.status(400).json({error:'The selected FFL is unavailable. Please choose another dealer.'});}
  const requestNumber='FFL-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();const address={address1:p.data.customer.address1||'',city:p.data.customer.city||'',state:p.data.customer.state||'',postal:p.data.customer.postal||''};const quoted=inv.sale_price_cents!=null?Number(inv.sale_price_cents):(inv.price_cents!=null?Number(inv.price_cents):null);
  const {rows}=await pool.query(`INSERT INTO ffl_requests(request_number,inventory_id,item_title,customer_name,customer_email,customer_phone,request_type,destination_state,receiving_ffl_name,receiving_ffl_phone,receiving_ffl_number,receiving_ffl_license_type,notes,dealer_id,dealer_snapshot,customer_address,shipping_method,quoted_total_cents,age_certified,buyer_date_of_birth,buyer_residence_state,ffl_verified,compliance_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'hold') RETURNING request_number,status,payment_status,compliance_status`,
    [requestNumber,inv.id,inv.title,p.data.customer.name,p.data.customer.email.toLowerCase(),p.data.customer.phone,p.data.request_type,dealer?.state||residence,dealer?.name||p.data.receiving_ffl_name||null,dealer?.phone||p.data.receiving_ffl_phone||null,dealer?.source_license_number||null,dealer?.license_type||null,p.data.notes,dealer?.id||null,dealer?JSON.stringify(dealer):null,JSON.stringify(address),p.data.shipping_method,quoted,p.data.age_certified,p.data.customer.date_of_birth,residence,p.data.request_type==='ffl_transfer'?!!dealer?.license_on_file:false]);
  res.status(201).json({...rows[0],dealer:dealer?{name:dealer.name,city:dealer.city,state:dealer.state,license_on_file:dealer.license_on_file,source_license_number:dealer.source_license_number,license_type:dealer.license_type}:null,quoted_total_cents:quoted,manual_compliance_review:true});
});
app.get('/api/ffl-requests',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query('SELECT * FROM ffl_requests ORDER BY created_at DESC LIMIT 1000');res.json(rows);});
app.patch('/api/ffl-requests/:id',auth,requireRole('manager'),async(req,res)=>{
  const p=z.object({status:z.enum(['new','contacted','awaiting_ffl','ready','completed','declined','cancelled']).optional(),state_law_reviewed:z.boolean().optional(),age_reviewed:z.boolean().optional(),identity_reviewed:z.boolean().optional(),ffl_verified:z.boolean().optional(),release_approved:z.boolean().optional(),compliance_notes:z.string().max(6000).optional()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Invalid firearm request update'});
  const current=(await pool.query('SELECT * FROM ffl_requests WHERE id=$1',[req.params.id])).rows[0];if(!current)return res.status(404).json({error:'Request not found'});const next={...current,...p.data};const needsFfl=next.request_type==='ffl_transfer';
  const cleared=!!next.state_law_reviewed&&!!next.age_reviewed&&!!next.identity_reviewed&&(!needsFfl||!!next.ffl_verified)&&!!next.release_approved;
  if(['ready','completed'].includes(p.data.status)&&!cleared)return res.status(409).json({error:'Compliance hold: complete state-law, age/ID, receiving-FFL verification (when shipped), and RELEASE APPROVED before marking this request ready/completed.'});
  const keys=Object.keys(p.data);if(!keys.length)return res.status(400).json({error:'No changes'});const vals=[],sets=[];keys.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(p.data[k]??null)});sets.push(`compliance_status=$${vals.length+1}`,`compliance_reviewed_at=CASE WHEN $${vals.length+1}='cleared' THEN now() ELSE compliance_reviewed_at END`,`compliance_reviewed_by=CASE WHEN $${vals.length+1}='cleared' THEN $${vals.length+2} ELSE compliance_reviewed_by END`,`updated_at=now()`);vals.push(cleared?'cleared':'hold',req.user.sub,req.params.id);
  const {rows}=await pool.query(`UPDATE ffl_requests SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`,vals);await audit(req,'UPDATE','ffl_request',rows[0].id,{fields:keys,compliance_status:rows[0].compliance_status});res.json(rows[0]);
});



// ---------- BATCH INVENTORY INTAKE ----------
const batchCreateSchema=z.object({name:z.string().trim().min(1).max(120)});
const batchItemSchema=z.object({filename:z.string().trim().max(255).default('photo.jpg'),image_data:z.string().max(2*1024*1024).refine(v=>/^data:image\/(jpeg|png|webp);base64,/i.test(v),'Invalid image')});
app.get('/api/batches',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query(`SELECT b.*,COUNT(bi.id)::int AS item_count,COUNT(bi.id) FILTER (WHERE bi.status='published')::int AS published_count FROM batch_uploads b LEFT JOIN batch_items bi ON bi.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`);res.json(rows)});
app.post('/api/batches',auth,requireRole('manager'),async(req,res)=>{const p=batchCreateSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Batch name is required'});const {rows}=await pool.query('INSERT INTO batch_uploads(name,created_by) VALUES($1,$2) RETURNING *',[p.data.name,req.user.sub]);res.status(201).json(rows[0])});
app.get('/api/batches/:id/items',auth,requireRole('viewer'),async(req,res)=>{const {rows}=await pool.query('SELECT * FROM batch_items WHERE batch_id=$1 ORDER BY created_at,id',[req.params.id]);res.json(rows)});
app.post('/api/batches/:id/items',auth,requireRole('manager'),async(req,res)=>{const p=z.object({items:z.array(batchItemSchema).min(1).max(25)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Upload up to 25 compressed JPG/PNG/WebP images at a time'});const batch=(await pool.query('SELECT id FROM batch_uploads WHERE id=$1',[req.params.id])).rows[0];if(!batch)return res.status(404).json({error:'Batch not found'});const c=await pool.connect();try{await c.query('BEGIN');const rows=[];for(const x of p.data.items){rows.push((await c.query(`INSERT INTO batch_items(batch_id,filename,image_data) VALUES($1,$2,$3) RETURNING *`,[batch.id,x.filename,x.image_data])).rows[0])}await c.query('COMMIT');res.status(201).json(rows)}catch(e){try{await c.query('ROLLBACK')}catch{};console.error(e);res.status(500).json({error:'Could not save batch photos'})}finally{c.release()}});
const batchPatchSchema=z.object({title:z.string().trim().max(180).optional(),suggested_title:z.string().trim().max(180).nullable().optional(),category:z.string().trim().max(80).optional(),condition:z.string().trim().max(80).optional(),quantity:z.number().int().min(1).max(9999).optional(),price_cents:z.number().int().min(0).nullable().optional(),suggested_price_cents:z.number().int().min(0).nullable().optional(),market_low_cents:z.number().int().min(0).nullable().optional(),market_high_cents:z.number().int().min(0).nullable().optional(),confidence:z.number().min(0).max(1).nullable().optional(),source_label:z.string().max(120).nullable().optional(),status:z.enum(['pending','analyzed','reviewed','published','error']).optional(),notes:z.string().max(1000).optional()});
app.patch('/api/batch-items/:id',auth,requireRole('manager'),async(req,res)=>{const p=batchPatchSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Invalid batch item changes'});const keys=Object.keys(p.data);if(!keys.length)return res.status(400).json({error:'No changes'});const vals=[];const sets=[];keys.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(p.data[k]??null)});vals.push(req.params.id);const {rows}=await pool.query(`UPDATE batch_items SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);if(!rows[0])return res.status(404).json({error:'Batch item not found'});res.json(rows[0])});
app.post('/api/batch-items/:id/analyze',auth,requireRole('manager'),async(req,res)=>{const item=(await pool.query('SELECT * FROM batch_items WHERE id=$1',[req.params.id])).rows[0];if(!item)return res.status(404).json({error:'Batch item not found'});const analyzer=process.env.BATCH_ANALYZER_URL?.trim();if(!analyzer)return res.status(503).json({error:'Automatic image identification is ready to connect, but BATCH_ANALYZER_URL is not configured yet.',needs_configuration:true});try{const headers={'Content-Type':'application/json'};if(process.env.BATCH_ANALYZER_SECRET)headers.Authorization='Bearer '+process.env.BATCH_ANALYZER_SECRET;const r=await fetch(analyzer,{method:'POST',headers,body:JSON.stringify({filename:item.filename,image_data:item.image_data})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Analyzer request failed');const clean={suggested_title:String(j.title||'').slice(0,180)||null,title:String(j.title||'').slice(0,180)||item.title,category:String(j.category||'Other').slice(0,80),condition:String(j.condition||'Good').slice(0,80),suggested_price_cents:Number.isFinite(Number(j.suggested_price_cents))?Math.max(0,Math.round(Number(j.suggested_price_cents))):null,price_cents:Number.isFinite(Number(j.suggested_price_cents))?Math.max(0,Math.round(Number(j.suggested_price_cents))):item.price_cents,market_low_cents:Number.isFinite(Number(j.market_low_cents))?Math.max(0,Math.round(Number(j.market_low_cents))):null,market_high_cents:Number.isFinite(Number(j.market_high_cents))?Math.max(0,Math.round(Number(j.market_high_cents))):null,confidence:Number.isFinite(Number(j.confidence))?Math.max(0,Math.min(1,Number(j.confidence))):null,source_label:String(j.source_label||'Automated lookup').slice(0,120),status:'analyzed'};const {rows}=await pool.query(`UPDATE batch_items SET suggested_title=$1,title=$2,category=$3,condition=$4,suggested_price_cents=$5,price_cents=$6,market_low_cents=$7,market_high_cents=$8,confidence=$9,source_label=$10,status=$11,updated_at=now() WHERE id=$12 RETURNING *`,[clean.suggested_title,clean.title,clean.category,clean.condition,clean.suggested_price_cents,clean.price_cents,clean.market_low_cents,clean.market_high_cents,clean.confidence,clean.source_label,clean.status,item.id]);res.json(rows[0])}catch(e){console.error(e);await pool.query("UPDATE batch_items SET status='error',updated_at=now() WHERE id=$1",[item.id]);res.status(502).json({error:'Automatic lookup failed: '+e.message})}});
app.post('/api/batches/:id/publish',auth,requireRole('manager'),async(req,res)=>{const p=z.object({item_ids:z.array(z.string().uuid()).min(1).max(500)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Choose at least one batch item'});const c=await pool.connect();try{await c.query('BEGIN');const published=[];const skipped=[];for(const id of p.data.item_ids){const x=(await c.query('SELECT * FROM batch_items WHERE id=$1 AND batch_id=$2 FOR UPDATE',[id,req.params.id])).rows[0];if(!x){skipped.push({id,reason:'not found'});continue}if(!x.title?.trim()||x.price_cents==null){skipped.push({id,reason:'title and price required'});continue}if(['Firearms','Ammunition'].includes(x.category)){skipped.push({id,reason:'regulated items require manual inventory review'});continue}const inv=(await c.query(`INSERT INTO inventory(title,category,quantity,cost_cents,price_cents,price_label,sku,item_type,low_stock,description,image_url,image_urls,condition,sale_price_cents,featured,regulated,public_visible) VALUES($1,$2,$3,0,$4,NULL,NULL,$5,1,$6,$7,$8,$9,NULL,false,false,true) RETURNING id,title`,[x.title.trim(),x.category||'Other',x.quantity||1,x.price_cents,(x.quantity||1)>1?'quantity':'individual',x.notes||'',x.image_data,JSON.stringify([x.image_data]),x.condition||'Good'])).rows[0];await c.query("UPDATE batch_items SET status='published',inventory_id=$1,updated_at=now() WHERE id=$2",[inv.id,x.id]);published.push(inv)}await c.query(`UPDATE batch_uploads SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM batch_items WHERE batch_id=$1 AND status<>'published') THEN 'published' ELSE 'review' END,updated_at=now() WHERE id=$1`,[req.params.id]);await c.query('COMMIT');res.json({published,skipped})}catch(e){try{await c.query('ROLLBACK')}catch{};console.error(e);res.status(500).json({error:'Could not publish batch inventory'})}finally{c.release()}});


// ---------- YEAR-END SALES / TAX REPORTING ----------
app.get('/api/reports/year-end',auth,requireRole('manager'),async(req,res)=>{
  try{
    const year=Number.parseInt(String(req.query.year||new Date().getFullYear()),10);
    if(!Number.isInteger(year)||year<2000||year>2100)return res.status(400).json({error:'Invalid report year'});
    const start=`${year}-01-01T00:00:00.000Z`,end=`${year+1}-01-01T00:00:00.000Z`;
    const online=(await pool.query(`SELECT id,order_number,created_at,customer_name,customer_email,fulfillment,shipping_address,subtotal_cents,shipping_cents,tax_cents,total_cents,payment_status,order_status,tax_state,tax_rate_bps_snapshot,refunded_cents,refunded_tax_cents,refunded_at FROM orders WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at`,[start,end])).rows;
    const manual=(await pool.query(`SELECT id,created_at,item_title,quantity,gross_cents,tax_cents,cost_cents,payment_method,order_ref FROM sales WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at`,[start,end])).rows;
    const paidOnline=online.filter(o=>o.payment_status==='paid');
    const fullyRefunded=online.filter(o=>o.payment_status==='refunded');
    const recognizedOnline=online.filter(o=>o.payment_status==='paid'||o.payment_status==='refunded');
    const onlineSubtotal=recognizedOnline.reduce((a,o)=>a+Number(o.subtotal_cents||0),0);
    const onlineShipping=recognizedOnline.reduce((a,o)=>a+Number(o.shipping_cents||0),0);
    const onlineTax=recognizedOnline.reduce((a,o)=>a+Number(o.tax_cents||0),0);
    const onlineTotal=recognizedOnline.reduce((a,o)=>a+Number(o.total_cents||0),0);
    const refundedTotal=online.reduce((a,o)=>a+Number(o.refunded_cents||0)+(o.payment_status==='refunded'&&!Number(o.refunded_cents||0)?Number(o.total_cents||0):0),0);
    const refundedTax=online.reduce((a,o)=>a+Number(o.refunded_tax_cents||0)+(o.payment_status==='refunded'&&!Number(o.refunded_tax_cents||0)?Number(o.tax_cents||0):0),0);
    const manualGross=manual.reduce((a,x)=>a+Number(x.gross_cents||0),0);
    const manualTax=manual.reduce((a,x)=>a+Number(x.tax_cents||0),0);
    const manualCost=manual.reduce((a,x)=>a+Number(x.cost_cents||0),0);
    const monthly={};
    for(let m=1;m<=12;m++)monthly[String(m).padStart(2,'0')]={month:m,online_sales_cents:0,online_tax_cents:0,manual_sales_cents:0,manual_tax_cents:0,refunds_cents:0};
    for(const o of recognizedOnline){const k=String(new Date(o.created_at).getUTCMonth()+1).padStart(2,'0');monthly[k].online_sales_cents+=Number(o.subtotal_cents||0)+Number(o.shipping_cents||0);monthly[k].online_tax_cents+=Number(o.tax_cents||0);monthly[k].refunds_cents+=Number(o.refunded_cents||0)+(o.payment_status==='refunded'&&!Number(o.refunded_cents||0)?Number(o.total_cents||0):0)}
    for(const x of manual){const k=String(new Date(x.created_at).getUTCMonth()+1).padStart(2,'0');monthly[k].manual_sales_cents+=Number(x.gross_cents||0);monthly[k].manual_tax_cents+=Number(x.tax_cents||0)}
    const states={};
    for(const o of recognizedOnline){const addr=o.shipping_address||{};const st=String(o.tax_state||(o.fulfillment==='pickup'?'KY':addr.state)||'UNKNOWN').toUpperCase();if(!states[st])states[st]={state:st,orders:0,sales_cents:0,tax_cents:0,refunds_cents:0};states[st].orders++;states[st].sales_cents+=Number(o.subtotal_cents||0)+Number(o.shipping_cents||0);states[st].tax_cents+=Number(o.tax_cents||0);states[st].refunds_cents+=Number(o.refunded_cents||0)+(o.payment_status==='refunded'&&!Number(o.refunded_cents||0)?Number(o.total_cents||0):0)}
    res.json({year,generated_at:new Date().toISOString(),summary:{online_order_count:online.length,paid_online_count:paidOnline.length,refunded_online_count:fullyRefunded.length,pending_online_count:online.filter(o=>o.payment_status==='pending').length,cancelled_online_count:online.filter(o=>o.order_status==='cancelled'||o.payment_status==='cancelled').length,online_subtotal_cents:onlineSubtotal,online_shipping_cents:onlineShipping,online_tax_collected_cents:onlineTax,online_total_cents:onlineTotal,refunds_cents:refundedTotal,refunded_tax_cents:refundedTax,manual_sale_count:manual.length,manual_sales_cents:manualGross,manual_tax_cents:manualTax,manual_cost_cents:manualCost,manual_estimated_profit_cents:manualGross-manualCost,combined_sales_before_tax_cents:onlineSubtotal+onlineShipping+manualGross,combined_tax_collected_cents:onlineTax+manualTax,combined_refunds_cents:refundedTotal},monthly:Object.values(monthly),states:Object.values(states).sort((a,b)=>a.state.localeCompare(b.state)),online_orders:online,manual_sales:manual,notes:['This report is an operational bookkeeping aid, not a filed tax return.','Pending/cancelled orders are shown in counts but are not included in recognized online sales totals.','Older online orders may not have a stored tax-rate snapshot; use the saved tax amount as the historical source of truth.']});
  }catch(e){console.error(e);res.status(500).json({error:'Could not build year-end report'})}
});

app.get('/api/audit',auth,requireRole('admin'),async(_req,res)=>{const {rows}=await pool.query('SELECT id,user_id,action,entity_type,entity_id,metadata,created_at FROM audit_log ORDER BY created_at DESC LIMIT 500');res.json(rows);});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});
ensureSchema().then(()=>ensureBootstrapAdmin()).then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Pink Elephant API listening on ${port}`))).catch(err=>{console.error(err);process.exit(1)});
