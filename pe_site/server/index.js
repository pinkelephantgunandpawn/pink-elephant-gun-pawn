import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { z } from 'zod';
import fs from 'node:fs/promises';
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
  const {rows}=await pool.query(`SELECT id,title,category,quantity,price_cents,price_label,sale_price_cents,sku,item_type,condition,description,image_url,image_urls,regulated,featured FROM inventory WHERE public_visible=true AND quantity>0 ORDER BY updated_at DESC`);
  res.json(rows);
});

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
  phone:process.env.SHIP_FROM_PHONE||'6065065030'
}}
const shippingQuoteSchema=z.object({
  customer:z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(180),phone:z.string().trim().min(7).max(40)}),
  shipping:z.object({address1:z.string().trim().min(3).max(180),city:z.string().trim().min(2).max(100),state:z.string().trim().min(2).max(50),postal:z.string().trim().min(3).max(20)}),
  items:z.array(z.object({inventory_id:z.string().uuid(),quantity:z.number().int().positive().max(99)})).min(1).max(25)
});
app.post('/api/public/shipping-rates',checkoutLimit,async(req,res)=>{
  const p=shippingQuoteSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Enter your contact and shipping address first.'});
  try{
    // Confirm the cart only contains live, non-regulated inventory before asking Shippo for rates.
    for(const requested of p.data.items){
      const inv=(await pool.query('SELECT id,quantity,regulated,public_visible FROM inventory WHERE id=$1',[requested.inventory_id])).rows[0];
      if(!inv||!inv.public_visible||inv.quantity<requested.quantity)return res.status(409).json({error:'An item in your cart is no longer available.'});
      if(inv.regulated)return res.status(400).json({error:'Regulated items use the licensed-dealer checkout flow.'});
    }
    // TEST FOUNDATION: inventory does not have package dimensions/weight yet, so use a configurable test parcel.
    const parcel={
      length:String(process.env.SHIP_TEST_LENGTH_IN||12),width:String(process.env.SHIP_TEST_WIDTH_IN||10),height:String(process.env.SHIP_TEST_HEIGHT_IN||6),distance_unit:'in',
      weight:String(process.env.SHIP_TEST_WEIGHT_LB||3),mass_unit:'lb'
    };
    const body={address_from:shipFromAddress(),address_to:{name:p.data.customer.name,street1:p.data.shipping.address1,city:p.data.shipping.city,state:p.data.shipping.state.toUpperCase(),zip:p.data.shipping.postal,country:'US',phone:p.data.customer.phone,email:p.data.customer.email},parcels:[parcel],async:false};
    const r=await fetch(SHIPPO_API+'/shipments/',{method:'POST',headers:shippoHeaders(),body:JSON.stringify(body)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.detail||j.message||j.error||'Shippo could not create a rate quote.');
    const rates=(j.rates||[]).filter(x=>x.object_id&&Number.isFinite(Number(x.amount))).map(x=>({
      rate_id:x.object_id,shipment_id:j.object_id,provider:x.provider||'',service:x.servicelevel?.name||x.servicelevel?.token||'Shipping',amount_cents:Math.round(Number(x.amount)*100),currency:x.currency||'USD',estimated_days:x.estimated_days??null,duration_terms:x.duration_terms||'',test:!!x.test
    })).sort((a,b)=>a.amount_cents-b.amount_cents).slice(0,12);
    if(!rates.length)return res.status(502).json({error:'Shippo returned no shipping rates for this address.'});
    res.json({rates,test_mode:rates.every(x=>x.test),parcel_note:`Test parcel: ${parcel.length}×${parcel.width}×${parcel.height} in, ${parcel.weight} lb`});
  }catch(e){console.error(e);res.status(e.status||502).json({error:e.message||'Could not load shipping rates.'})}
});
async function verifyShippoRate(rateId,shipmentId){
  const r=await fetch(SHIPPO_API+'/rates/'+encodeURIComponent(rateId),{headers:shippoHeaders()});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.detail||j.message||'Could not verify the selected shipping rate.');
  if(shipmentId&&j.shipment!==shipmentId)throw new Error('The selected shipping rate does not match this quote.');
  const cents=Math.round(Number(j.amount)*100);if(!Number.isFinite(cents)||cents<0)throw new Error('The selected shipping rate is invalid.');
  return {cents,provider:j.provider||'',service:j.servicelevel?.name||j.servicelevel?.token||'Shipping',rate_id:j.object_id,shipment_id:j.shipment||shipmentId||null,test:!!j.test};
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
app.post('/api/public/orders',checkoutLimit,async(req,res)=>{
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
    const shippingCents=verifiedShipping?.cents||0; const total=subtotal+shippingCents;
    const order=(await c.query(`INSERT INTO orders(order_number,customer_name,customer_email,customer_phone,fulfillment,shipping_address,notes,subtotal_cents,tax_cents,shipping_cents,total_cents,shippo_rate_id,shippo_shipment_id,shipping_provider,shipping_service) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,$14) RETURNING id,order_number,subtotal_cents,shipping_cents,total_cents,order_status,payment_status`,
      [orderNumber,p.data.customer.name,p.data.customer.email.toLowerCase(),p.data.customer.phone,p.data.fulfillment,shippingAddress,p.data.notes,subtotal,shippingCents,total,verifiedShipping?.rate_id||null,verifiedShipping?.shipment_id||null,verifiedShipping?.provider||null,verifiedShipping?.service||null])).rows[0];
    for(const item of items){
      await c.query(`INSERT INTO order_items(order_id,inventory_id,item_title,quantity,unit_price_cents,line_total_cents) VALUES($1,$2,$3,$4,$5,$6)`,
        [order.id,item.inv.id,item.inv.title,item.quantity,item.unit,item.line]);
      await c.query('UPDATE inventory SET quantity=quantity-$1,updated_at=now() WHERE id=$2',[item.quantity,item.inv.id]);
    }
    await c.query('COMMIT');
    res.status(201).json({order_number:order.order_number,subtotal_cents:order.subtotal_cents,total_cents:order.total_cents,status:order.order_status,payment_status:order.payment_status});
  }catch(e){
    try{await c.query('ROLLBACK')}catch{}
    console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Could not place order. Please call the shop if the problem continues.'});
  }finally{c.release()}
});

const inventorySchema=z.object({title:z.string().min(1).max(180),category:z.string().min(1).max(80),quantity:z.number().int().min(0),cost_cents:z.number().int().min(0),price_cents:z.number().int().min(0).nullable().optional(),price_label:z.string().max(80).nullable().optional(),sku:z.string().max(80).nullable().optional(),item_type:z.enum(['quantity','individual']),low_stock:z.number().int().min(0),description:z.string().max(5000),image_url:z.string().max(5*1024*1024).refine(v=>/^https?:\/\//i.test(v)||/^data:image\/(jpeg|png|webp);base64,/i.test(v),'Image must be an http(s) URL or uploaded image').nullable().optional(),image_urls:z.array(z.string().max(5*1024*1024)).max(4).default([]),condition:z.string().min(1).max(80).default('Good'),sale_price_cents:z.number().int().min(0).nullable().optional(),featured:z.boolean().default(false),regulated:z.boolean().default(false),public_visible:z.boolean().default(true)});
app.get('/api/inventory',auth,requireRole('viewer'),async (_req,res)=>{const {rows}=await pool.query('SELECT * FROM inventory ORDER BY updated_at DESC');res.json(rows);});
app.post('/api/inventory',auth,requireRole('manager'),async (req,res)=>{
  const p=inventorySchema.safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.issues}); const x=p.data;
  const {rows}=await pool.query(`INSERT INTO inventory(title,category,quantity,cost_cents,price_cents,price_label,sku,item_type,low_stock,description,image_url,image_urls,condition,sale_price_cents,featured,regulated,public_visible) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,[x.title,x.category,x.quantity,x.cost_cents,x.price_cents??null,x.price_label??null,x.sku||null,x.item_type,x.low_stock,x.description,x.image_url??(x.image_urls?.[0]||null),JSON.stringify(x.image_urls||[]),x.condition,x.sale_price_cents??null,x.featured,x.regulated,x.public_visible]);
  await audit(req,'CREATE','inventory',rows[0].id,{title:x.title,regulated:x.regulated}); res.status(201).json(rows[0]);
});
app.patch('/api/inventory/:id',auth,requireRole('manager'),async (req,res)=>{
  const p=inventorySchema.partial().safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.issues}); const keys=Object.keys(p.data); if(!keys.length)return res.status(400).json({error:'No changes'});
  const map={price_cents:'price_cents',price_label:'price_label',title:'title',category:'category',quantity:'quantity',cost_cents:'cost_cents',sku:'sku',item_type:'item_type',low_stock:'low_stock',description:'description',image_url:'image_url',image_urls:'image_urls',condition:'condition',sale_price_cents:'sale_price_cents',featured:'featured',regulated:'regulated',public_visible:'public_visible'};
  const vals=[]; const sets=[]; keys.forEach((k,i)=>{sets.push(`${map[k]}=$${i+1}`); vals.push(k==='image_urls'?JSON.stringify(p.data[k]||[]):(p.data[k]??null))}); vals.push(req.params.id);
  const {rows}=await pool.query(`UPDATE inventory SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals); if(!rows[0])return res.status(404).json({error:'Inventory item not found'});
  await audit(req,'UPDATE','inventory',rows[0].id,{fields:keys}); res.json(rows[0]);
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

app.get('/api/orders',auth,requireRole('viewer'),async(_req,res)=>{
  const {rows}=await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('title',oi.item_title,'quantity',oi.quantity,'unit_price_cents',oi.unit_price_cents,'line_total_cents',oi.line_total_cents)) FILTER (WHERE oi.id IS NOT NULL),'[]') AS items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 1000`);
  res.json(rows);
});
app.patch('/api/orders/:id',auth,requireRole('manager'),async(req,res)=>{
  const p=z.object({order_status:z.enum(['new','confirmed','ready','shipped','completed','cancelled']).optional(),payment_status:z.enum(['pending','paid','refunded','cancelled']).optional(),tracking_number:z.string().max(180).nullable().optional(),admin_notes:z.string().max(3000).optional()}).safeParse(req.body);
  if(!p.success)return res.status(400).json({error:p.error.issues});const keys=Object.keys(p.data);if(!keys.length)return res.status(400).json({error:'No changes'});
  const c=await pool.connect();try{await c.query('BEGIN');const current=(await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!current){await c.query('ROLLBACK');return res.status(404).json({error:'Order not found'})}
    if(p.data.order_status==='cancelled'&&!current.inventory_restocked){const {rows:items}=await c.query('SELECT inventory_id,quantity FROM order_items WHERE order_id=$1',[current.id]);for(const i of items)if(i.inventory_id)await c.query('UPDATE inventory SET quantity=quantity+$1,updated_at=now() WHERE id=$2',[i.quantity,i.inventory_id]);p.data.inventory_restocked=true}
    const k2=Object.keys(p.data);const vals=[];const sets=[];k2.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(p.data[k]??null)});vals.push(req.params.id);const {rows}=await c.query(`UPDATE orders SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);await c.query('COMMIT');await audit(req,'UPDATE','order',rows[0].id,{fields:k2});res.json(rows[0]);
  }catch(e){try{await c.query('ROLLBACK')}catch{};console.error(e);res.status(500).json({error:'Could not update order'})}finally{c.release()}
});


const dealerSchema=z.object({
  name:z.string().trim().min(2).max(180),address1:z.string().trim().min(2).max(180),city:z.string().trim().min(2).max(100),state:z.string().trim().min(2).max(50),postal:z.string().trim().min(3).max(20),
  phone:z.string().trim().max(40).nullable().optional(),email:z.string().trim().email().max(180).nullable().optional(),license_on_file:z.boolean().default(false),preferred:z.boolean().default(false),active:z.boolean().default(true),
  latitude:z.number().min(-90).max(90).nullable().optional(),longitude:z.number().min(-180).max(180).nullable().optional()
});
app.get('/api/public/ffl-dealers',async(req,res)=>{
  const q=String(req.query.q||'').trim();
  const values=[]; let where='active=true';
  if(q){values.push('%'+q+'%');where+=` AND (name ILIKE $1 OR city ILIKE $1 OR state ILIKE $1 OR postal ILIKE $1 OR address1 ILIKE $1)`}
  const {rows}=await pool.query(`SELECT id,name,address1,city,state,postal,phone,license_on_file,preferred,latitude,longitude FROM ffl_dealers WHERE ${where} ORDER BY preferred DESC,license_on_file DESC,name ASC LIMIT 75`,values);
  res.json(rows);
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
  customer:z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(180),phone:z.string().trim().min(7).max(40),address1:z.string().trim().max(180).optional(),city:z.string().trim().max(100).optional(),state:z.string().trim().max(50).optional(),postal:z.string().trim().max(20).optional()}),
  request_type:z.enum(['store_pickup','ffl_transfer']),dealer_id:z.string().uuid().nullable().optional(),
  receiving_ffl_name:z.string().trim().max(180).nullable().optional(),receiving_ffl_phone:z.string().trim().max(40).nullable().optional(),
  shipping_method:z.enum(['store_pickup','standard_ground','store_review']).default('store_review'),age_certified:z.literal(true),notes:z.string().trim().max(1500).default('')
});
app.post('/api/public/ffl-requests',checkoutLimit,async(req,res)=>{
  const p=fflRequestSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Please check every required checkout field, including the certification box.'});
  const inv=(await pool.query('SELECT id,title,regulated,quantity,public_visible,price_cents,sale_price_cents FROM inventory WHERE id=$1',[p.data.inventory_id])).rows[0];
  if(!inv||!inv.public_visible||inv.quantity<1)return res.status(404).json({error:'This item is no longer available.'});
  if(!inv.regulated)return res.status(400).json({error:'This checkout is only for regulated items.'});
  let dealer=null;
  if(p.data.request_type==='ffl_transfer'){
    if(!p.data.dealer_id)return res.status(400).json({error:'Choose a receiving FFL dealer before continuing.'});
    dealer=(await pool.query('SELECT id,name,address1,city,state,postal,phone,license_on_file,preferred FROM ffl_dealers WHERE id=$1 AND active=true',[p.data.dealer_id])).rows[0];
    if(!dealer)return res.status(400).json({error:'The selected FFL is unavailable. Please choose another dealer.'});
  }
  const requestNumber='FFL-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
  const address={address1:p.data.customer.address1||'',city:p.data.customer.city||'',state:p.data.customer.state||'',postal:p.data.customer.postal||''};
  const quoted=inv.sale_price_cents!=null?Number(inv.sale_price_cents):(inv.price_cents!=null?Number(inv.price_cents):null);
  const {rows}=await pool.query(`INSERT INTO ffl_requests(request_number,inventory_id,item_title,customer_name,customer_email,customer_phone,request_type,destination_state,receiving_ffl_name,receiving_ffl_phone,notes,dealer_id,dealer_snapshot,customer_address,shipping_method,quoted_total_cents,age_certified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING request_number,status,payment_status`,
    [requestNumber,inv.id,inv.title,p.data.customer.name,p.data.customer.email.toLowerCase(),p.data.customer.phone,p.data.request_type,dealer?.state||p.data.customer.state||null,dealer?.name||p.data.receiving_ffl_name||null,dealer?.phone||p.data.receiving_ffl_phone||null,p.data.notes,dealer?.id||null,dealer?JSON.stringify(dealer):null,JSON.stringify(address),p.data.shipping_method,quoted,p.data.age_certified]);
  res.status(201).json({...rows[0],dealer:dealer?{name:dealer.name,city:dealer.city,state:dealer.state}:null,quoted_total_cents:quoted});
});
app.get('/api/ffl-requests',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query('SELECT * FROM ffl_requests ORDER BY created_at DESC LIMIT 1000');res.json(rows);});
app.patch('/api/ffl-requests/:id',auth,requireRole('manager'),async(req,res)=>{
  const p=z.object({status:z.enum(['new','contacted','awaiting_ffl','ready','completed','declined','cancelled'])}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Invalid status'});
  const {rows}=await pool.query('UPDATE ffl_requests SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[p.data.status,req.params.id]);if(!rows[0])return res.status(404).json({error:'Request not found'});res.json(rows[0]);
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

app.get('/api/audit',auth,requireRole('admin'),async(_req,res)=>{const {rows}=await pool.query('SELECT id,user_id,action,entity_type,entity_id,metadata,created_at FROM audit_log ORDER BY created_at DESC LIMIT 500');res.json(rows);});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});
ensureSchema().then(()=>ensureBootstrapAdmin()).then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Pink Elephant API listening on ${port}`))).catch(err=>{console.error(err);process.exit(1)});

