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

const publicOrderSchema=z.object({
  customer:z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(180),phone:z.string().trim().min(7).max(40)}),
  fulfillment:z.enum(['pickup','shipping']),
  shipping:z.object({address1:z.string().trim().min(3).max(180),city:z.string().trim().min(2).max(100),state:z.string().trim().min(2).max(50),postal:z.string().trim().min(3).max(20)}).nullable().optional(),
  notes:z.string().trim().max(1000).default(''),
  items:z.array(z.object({inventory_id:z.string().uuid(),quantity:z.number().int().positive().max(99)})).min(1).max(25)
});
app.post('/api/public/orders',checkoutLimit,async(req,res)=>{
  const p=publicOrderSchema.safeParse(req.body);
  if(!p.success)return res.status(400).json({error:'Please check the checkout information and try again.'});
  if(p.data.fulfillment==='shipping'&&!p.data.shipping)return res.status(400).json({error:'Shipping address is required.'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    let subtotal=0; const items=[];
    for(const requested of p.data.items){
      const inv=(await c.query('SELECT id,title,quantity,price_cents,regulated,public_visible FROM inventory WHERE id=$1 FOR UPDATE',[requested.inventory_id])).rows[0];
      if(!inv||!inv.public_visible)return res.status(409).json({error:'An item in your cart is no longer available.'});
      if(inv.regulated)return res.status(400).json({error:'Regulated items cannot use the standard online checkout.'});
      if(inv.price_cents==null)return res.status(400).json({error:`${inv.title} requires store pricing.`});
      if(inv.quantity<requested.quantity)return res.status(409).json({error:`Not enough ${inv.title} is available.`});
      const line=Number(inv.price_cents)*requested.quantity; subtotal+=line;
      items.push({inv,quantity:requested.quantity,line});
    }
    const orderNumber='PE-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
    const shippingAddress=p.data.fulfillment==='shipping'?p.data.shipping:null;
    const order=(await c.query(`INSERT INTO orders(order_number,customer_name,customer_email,customer_phone,fulfillment,shipping_address,notes,subtotal_cents,tax_cents,shipping_cents,total_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,$8) RETURNING id,order_number,subtotal_cents,total_cents,order_status,payment_status`,
      [orderNumber,p.data.customer.name,p.data.customer.email.toLowerCase(),p.data.customer.phone,p.data.fulfillment,shippingAddress,p.data.notes,subtotal])).rows[0];
    for(const item of items){
      await c.query(`INSERT INTO order_items(order_id,inventory_id,item_title,quantity,unit_price_cents,line_total_cents) VALUES($1,$2,$3,$4,$5,$6)`,
        [order.id,item.inv.id,item.inv.title,item.quantity,item.inv.price_cents,item.line]);
      await c.query('UPDATE inventory SET quantity=quantity-$1,updated_at=now() WHERE id=$2',[item.quantity,item.inv.id]);
    }
    await c.query('COMMIT');
    res.status(201).json({order_number:order.order_number,subtotal_cents:order.subtotal_cents,total_cents:order.total_cents,status:order.order_status,payment_status:order.payment_status});
  }catch(e){
    try{await c.query('ROLLBACK')}catch{}
    console.error(e);res.status(500).json({error:'Could not place order. Please call the shop if the problem continues.'});
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
  if(!p.success)return res.status(400).json({error:p.error.issues});
  const keys=Object.keys(p.data); if(!keys.length)return res.status(400).json({error:'No changes'});
  const vals=[];const sets=[];keys.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(p.data[k]??null)});vals.push(req.params.id);
  const {rows}=await pool.query(`UPDATE orders SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);
  if(!rows[0])return res.status(404).json({error:'Order not found'});await audit(req,'UPDATE','order',rows[0].id,{fields:keys});res.json(rows[0]);
});

const fflRequestSchema=z.object({
  inventory_id:z.string().uuid(),
  customer:z.object({name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(180),phone:z.string().trim().min(7).max(40)}),
  request_type:z.enum(['store_pickup','ffl_transfer']),
  destination_state:z.string().trim().max(50).nullable().optional(),
  receiving_ffl_name:z.string().trim().max(180).nullable().optional(),
  receiving_ffl_phone:z.string().trim().max(40).nullable().optional(),
  notes:z.string().trim().max(1500).default('')
});
app.post('/api/public/ffl-requests',checkoutLimit,async(req,res)=>{
  const p=fflRequestSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Please check the request information.'});
  const inv=(await pool.query('SELECT id,title,regulated,quantity,public_visible FROM inventory WHERE id=$1',[p.data.inventory_id])).rows[0];
  if(!inv||!inv.public_visible||inv.quantity<1)return res.status(404).json({error:'This item is no longer available.'});
  if(!inv.regulated)return res.status(400).json({error:'This request form is only for regulated items.'});
  const requestNumber='FFL-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
  const {rows}=await pool.query(`INSERT INTO ffl_requests(request_number,inventory_id,item_title,customer_name,customer_email,customer_phone,request_type,destination_state,receiving_ffl_name,receiving_ffl_phone,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING request_number,status`,
    [requestNumber,inv.id,inv.title,p.data.customer.name,p.data.customer.email.toLowerCase(),p.data.customer.phone,p.data.request_type,p.data.destination_state||null,p.data.receiving_ffl_name||null,p.data.receiving_ffl_phone||null,p.data.notes]);
  res.status(201).json(rows[0]);
});
app.get('/api/ffl-requests',auth,requireRole('viewer'),async(_req,res)=>{const {rows}=await pool.query('SELECT * FROM ffl_requests ORDER BY created_at DESC LIMIT 1000');res.json(rows);});
app.patch('/api/ffl-requests/:id',auth,requireRole('manager'),async(req,res)=>{
  const p=z.object({status:z.enum(['new','contacted','awaiting_ffl','ready','completed','declined','cancelled'])}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Invalid status'});
  const {rows}=await pool.query('UPDATE ffl_requests SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[p.data.status,req.params.id]);if(!rows[0])return res.status(404).json({error:'Request not found'});res.json(rows[0]);
});

app.get('/api/audit',auth,requireRole('admin'),async(_req,res)=>{const {rows}=await pool.query('SELECT id,user_id,action,entity_type,entity_id,metadata,created_at FROM audit_log ORDER BY created_at DESC LIMIT 500');res.json(rows);});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});
ensureSchema().then(()=>ensureBootstrapAdmin()).then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Pink Elephant API listening on ${port}`))).catch(err=>{console.error(err);process.exit(1)});
