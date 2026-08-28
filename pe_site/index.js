import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { z } from 'zod';

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

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
const allowedOrigins = new Set([
  'https://pinkelephantgunandpawn.com',
  'https://www.pinkelephantgunandpawn.com',
  'https://pink-elephant-gun-pawn.onrender.com',
  ...(process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
]);
app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server / same-origin tools with no Origin header, and the approved storefronts.
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: '6mb' }));
app.use(rateLimit({ windowMs: 15*60*1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
const loginLimit = rateLimit({ windowMs: 15*60*1000, limit: 10, message: { error:'Too many login attempts. Try again later.' } });

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
  const {rows}=await pool.query(`SELECT id,title,category,quantity,price_cents,price_label,sku,item_type,description,image_url,regulated FROM inventory WHERE public_visible=true AND quantity>0 ORDER BY updated_at DESC`);
  res.json(rows);
});

const inventorySchema=z.object({title:z.string().min(1).max(180),category:z.string().min(1).max(80),quantity:z.number().int().min(0),cost_cents:z.number().int().min(0),price_cents:z.number().int().min(0).nullable().optional(),price_label:z.string().max(80).nullable().optional(),sku:z.string().max(80).nullable().optional(),item_type:z.enum(['quantity','individual']),low_stock:z.number().int().min(0),description:z.string().max(5000),image_url:z.string().max(5*1024*1024).refine(v=>/^https?:\/\//i.test(v)||/^data:image\/(jpeg|png|webp);base64,/i.test(v),'Image must be an http(s) URL or uploaded image').nullable().optional(),regulated:z.boolean().default(false),public_visible:z.boolean().default(true)});

app.get('/api/inventory',auth,requireRole('viewer'),async (_req,res)=>{const {rows}=await pool.query('SELECT * FROM inventory ORDER BY updated_at DESC');res.json(rows);});
app.post('/api/inventory',auth,requireRole('manager'),async (req,res)=>{
  const p=inventorySchema.safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.issues}); const x=p.data;
  const {rows}=await pool.query(`INSERT INTO inventory(title,category,quantity,cost_cents,price_cents,price_label,sku,item_type,low_stock,description,image_url,regulated,public_visible) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[x.title,x.category,x.quantity,x.cost_cents,x.price_cents??null,x.price_label??null,x.sku||null,x.item_type,x.low_stock,x.description,x.image_url??null,x.regulated,x.public_visible]);
  await audit(req,'CREATE','inventory',rows[0].id,{title:x.title,regulated:x.regulated}); res.status(201).json(rows[0]);
});
app.patch('/api/inventory/:id',auth,requireRole('manager'),async (req,res)=>{
  const p=inventorySchema.partial().safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.issues}); const keys=Object.keys(p.data); if(!keys.length)return res.status(400).json({error:'No changes'});
  const map={price_cents:'price_cents',price_label:'price_label',title:'title',category:'category',quantity:'quantity',cost_cents:'cost_cents',sku:'sku',item_type:'item_type',low_stock:'low_stock',description:'description',image_url:'image_url',regulated:'regulated',public_visible:'public_visible'};
  const vals=[]; const sets=[]; keys.forEach((k,i)=>{sets.push(`${map[k]}=$${i+1}`); vals.push(p.data[k]??null)}); vals.push(req.params.id);
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
app.get('/api/audit',auth,requireRole('admin'),async(_req,res)=>{const {rows}=await pool.query('SELECT id,user_id,action,entity_type,entity_id,metadata,created_at FROM audit_log ORDER BY created_at DESC LIMIT 500');res.json(rows);});

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});
ensureBootstrapAdmin().then(()=>app.listen(port,()=>console.log(`Pink Elephant API listening on ${port}`))).catch(err=>{console.error(err);process.exit(1)});
