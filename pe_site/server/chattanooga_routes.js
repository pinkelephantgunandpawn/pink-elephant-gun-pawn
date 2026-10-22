import { Router } from 'express';
import { createChattanoogaClient } from './chattanooga_client.js';
import { retailPriceCents, parseSupplierMoneyCents } from './chattanooga_pricing.js';

// All routes MUST be mounted behind the application's existing auth and manager role middleware.
export function createChattanoogaRouter(pool) {
  const router=Router();
  const allowed=['draft','published','hidden'];
  const fail=(res,e)=>{console.error('Chattanooga admin request:',e?.message);res.status(500).json({error:'Distributor operation failed'});};
  const client=()=>createChattanoogaClient();
  const bounded=(v,def,max)=>Number.isInteger(Number(v))&&Number(v)>0?Math.min(Number(v),max):def;
  const text=(v,n=255)=>String(v??'').trim().slice(0,n);
  const money=(v)=>parseSupplierMoneyCents(v);
  const list=(body)=>Array.isArray(body)?body:(Array.isArray(body?.items)?body.items:Array.isArray(body?.product_feed)?body.product_feed:Array.isArray(body?.data)?body.data:[]);
  // Conservative catalog scope: only identifiable firearms and optics. Unknown items stay out.
  const scope=(x)=>{
    const fields=[x.category_name,x.category,x.product_category,x.department_name,x.department,x.product_type,x.subcategory_name,x.subcategory].map(v=>String(v??'')).join(' ').toLowerCase();
    const name=String(x.name??x.title??x.description??'').toLowerCase();
    const excluded=/powder|primer|ammunition|ammo|magazine|reloading|holster|mount|ring|base|battery|cleaning|knife|suppressor|silencer|airgun|pellet|accessor/;
    if(excluded.test(fields)||excluded.test(name))return null;
    if(/firearm|rifle|shotgun|handgun|pistol|revolver/.test(fields))return 'Firearms';
    if(/optic|riflescope|scope|red dot|reflex sight|binocular|rangefinder|spotting scope/.test(fields))return 'Optics';
    if(/riflescope|scope|red dot|reflex sight|binocular|rangefinder|spotting scope/.test(name))return 'Optics';
    return null;
  };
  const imageUrl=(x)=>{
    const candidates=[x.image_url,x.primary_image_url,x.image,x.image_link,x.image_uri,x.product_image_url,x.product_image,x.main_image_url,x.thumbnail_url,x.images,x.product_images];
    for(const candidate of candidates){
      const entries=Array.isArray(candidate)?candidate:[candidate];
      for(const entry of entries){
        const value=typeof entry==='string'?entry:entry&&typeof entry==='object'?(entry.url??entry.image_url??entry.src??entry.large??entry.original):null;
        if(typeof value!=='string')continue;
        try{const u=new URL(value);if(u.protocol==='https:'&&u.username===''&&u.password==='')return text(u.href,1000);}catch{}
      }
    }
    return '';
  };
  const normalize=(x)=>{
    const id=text(x.cssi_id??x.item_id??x.itemId??x.id??x.sku,120);
    const title=text(x.name??x.title??x.description,180);
    if(!id||!title) return null;
    const catalogCategory=scope(x);if(!catalogCategory)return null;
    const rawCost=x.drop_ship_price??x.cost??x.dealer_price??x.wholesale_price??x.unit_cost;
    if(rawCost===undefined||rawCost===null)return null;
    let costCents;try{costCents=money(rawCost);}catch{return null;}
    const mapRaw=x.retail_map_price;
    let mapCents=null;
    if(mapRaw!==undefined&&mapRaw!==null&&String(mapRaw).trim()!==''){try{mapCents=money(mapRaw);}catch{mapCents=null;}}
    return {id,title,category:catalogCategory,
      brand:text(x.manufacturer??x.brand,120),sku:text(x.sku??x.cssi_id??x.item_id??id,80),upc:text(x.upc??x.upc_code,80),
      description:text(x.long_description??x.product_description??x.description??'',4000),
      image_url:imageUrl(x),
      map_cents:mapCents,cost_cents:costCents,quantity:Math.max(0,Math.floor(Number(x.inventory??x.quantity_available??x.available_quantity??x.quantity??x.qty??0)||0)),raw:x};
  };
  router.get('/health',(_req,res)=>res.json({configured:!!(process.env.CHATTANOOGA_SID&&process.env.CHATTANOOGA_TOKEN),version:'v6',default_markup:20,ordering_enabled:false}));
  router.get('/field-diagnostics',async(_req,res)=>{try{
    const data=await client().getItems({page:1,per_page:3});
    const items=list(data);
    const fields=[...new Set(items.flatMap(item=>Object.keys(item)))].sort();
    const imageFields=fields.filter(key=>/image|photo|picture|media|thumbnail|asset/i.test(key));
    const categoryFields=fields.filter(key=>/categor|department|group|type|class|subcategor/i.test(key));
    res.set('Cache-Control','no-store');
    res.json({sample_size:items.length,image_field_names:imageFields,category_field_names:categoryFields,eligible_count:items.map(normalize).filter(Boolean).length,notice:'Field names only; no credentials, supplier costs, or raw records exposed'});
  }catch(e){res.status(502).json({error:'Unable to inspect supplier field names'});}});
  router.get('/remote',async(req,res)=>{try{
    const page=bounded(req.query.page,1,100000),per_page=bounded(req.query.per_page,50,50);
    if(req.query.feed==='1') return res.status(400).json({error:'Product-feed CSV is not available in this read-only preview'});
    const data=await client().getItems({page,per_page});
    res.set('Cache-Control','no-store');
    const supplierItems=list(data);res.json({normalized:supplierItems.map(normalize).filter(Boolean).map(({raw,...item})=>item),page,per_page,supplier_count:supplierItems.length});
  }catch(e){res.status(e.status===401?502:502).json({error:'Chattanooga catalog unavailable',code:e.code??null});}});
  router.get('/categories',async(_req,res)=>{try{const {rows}=await pool.query("SELECT category,count(*)::int AS total,count(*) FILTER (WHERE status='draft')::int AS drafts,count(*) FILTER (WHERE status='published')::int AS published FROM distributor_catalog WHERE supplier='chattanooga' AND category IN ('Firearms','Optics') GROUP BY category ORDER BY category");res.json(rows);}catch(e){fail(res,e);}});
  router.get('/products',async(req,res)=>{try{
    const where=["supplier='chattanooga'"],values=[];
    if(req.query.category){values.push(text(req.query.category,80));where.push(`category=$${values.length}`);}
    if(allowed.includes(req.query.status)){values.push(req.query.status);where.push(`status=$${values.length}`);}
    if(req.query.search){values.push('%'+text(req.query.search,100)+'%');where.push(`(title ILIKE $${values.length} OR sku ILIKE $${values.length} OR brand ILIKE $${values.length} OR upc ILIKE $${values.length})`);}
    const limit=bounded(req.query.limit,50,100),offset=(bounded(req.query.page,1,100000)-1)*limit;
    values.push(limit,offset);
    const {rows}=await pool.query(`SELECT id,supplier_item_id,title,category,brand,sku,upc,description,image_url,cost_cents,available_quantity,markup_percent,price_override_cents,status,review_status,reviewed_at,inventory_id,last_synced_at FROM distributor_catalog WHERE ${where.join(' AND ')} ORDER BY category,title LIMIT $${values.length-1} OFFSET $${values.length}`,values);
    res.json(rows.map(x=>({...x,retail_price_cents:retailPriceCents(x.cost_cents,Number(x.markup_percent),x.price_override_cents)})));
  }catch(e){fail(res,e);}});
  router.post('/stage',async(req,res)=>{const raw=Array.isArray(req.body?.items)?req.body.items:[];
    if(!raw.length||raw.length>10)return res.status(400).json({error:'Select 1–10 products per batch'});
    // Never trust client-submitted wholesale cost, availability or metadata.
    const requestedIds=raw.map(x=>text(x.cssi_id??x.item_id??x.itemId??x.id??x.sku,120));
    if(requestedIds.some(x=>!x)||new Set(requestedIds).size!==requestedIds.length)return res.status(400).json({error:'Invalid or duplicate supplier IDs'});
    const normalized=[];
    try {
      for(const id of requestedIds){
        const result=await client().getItems({item_ids:id});
        const item=list(result).map(normalize).find(x=>x?.id===id);
        if(!item)return res.status(422).json({error:'Product is not a verified firearm/optic or supplier cost and stock could not be confirmed',item_id:id});
        normalized.push(item);
      }
    }catch(e){return res.status(502).json({error:'Supplier verification unavailable; nothing staged'});}
    const db=await pool.connect();try{await db.query('BEGIN');
      for(const x of normalized){await db.query(`INSERT INTO distributor_catalog(supplier_item_id,title,category,brand,sku,upc,description,image_url,cost_cents,available_quantity,raw_data,last_synced_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
        ON CONFLICT(supplier,supplier_item_id) DO UPDATE SET
        title=EXCLUDED.title,category=EXCLUDED.category,brand=EXCLUDED.brand,sku=EXCLUDED.sku,upc=EXCLUDED.upc,description=EXCLUDED.description,
        image_url=EXCLUDED.image_url,cost_cents=EXCLUDED.cost_cents,available_quantity=EXCLUDED.available_quantity,
        raw_data=EXCLUDED.raw_data,last_synced_at=now(),updated_at=now()`,[x.id,x.title,x.category,x.brand,x.sku,x.upc,x.description,x.image_url,x.cost_cents,x.quantity,JSON.stringify(x.raw)]);}
      await db.query('COMMIT');res.json({staged:normalized.length});
    }catch(e){await db.query('ROLLBACK');fail(res,e);}finally{db.release();}
  });
  router.patch('/products/:id',async(req,res)=>{
    const {markup_percent,price_override_cents}=req.body||{};
    if(markup_percent===undefined&&price_override_cents===undefined)return res.status(400).json({error:'No changes supplied'});
    if(markup_percent!==undefined&&(!Number.isFinite(markup_percent)||markup_percent<0||markup_percent>500))return res.status(400).json({error:'Invalid markup'});
    if(price_override_cents!==undefined&&price_override_cents!==null&&(!Number.isSafeInteger(price_override_cents)||price_override_cents<0))return res.status(400).json({error:'Invalid override'});
    try{const {rows}=await pool.query(`UPDATE distributor_catalog SET markup_percent=COALESCE($2,markup_percent),price_override_cents=CASE WHEN $3 THEN $4 ELSE price_override_cents END,updated_at=now() WHERE id=$1 RETURNING id,status`,[req.params.id,markup_percent??null,price_override_cents!==undefined,price_override_cents??null]);if(!rows.length)return res.status(404).json({error:'Not found'});res.json(rows[0]);}catch(e){fail(res,e);}
  });
  // Publishing stays disabled until cost semantics, MAP and shipping restrictions are verified.
  // Admin approval is a separate explicit action and never implies publication.
  router.post('/products/:id/publish',(_req,res)=>res.status(409).json({
    error:'Supplier publication is not yet enabled: verify MAP, shipping, product restrictions and final pricing first.'
  }));
  router.post('/products/:id/approve',async(req,res)=>{
    try {
      const {rows}=await pool.query(`UPDATE distributor_catalog SET review_status='approved',reviewed_at=now(),updated_at=now()
        WHERE id=$1 AND review_status='pending' AND category IN ('Firearms','Optics') RETURNING id,review_status,status`,[req.params.id]);
      if(!rows.length)return res.status(409).json({error:'Product not pending approval or not found'});
      res.json({...rows[0],published:false});
    }catch(e){fail(res,e);}
  });
  router.post('/products/:id/reject',async(req,res)=>{
    try {
      const {rows}=await pool.query(`UPDATE distributor_catalog SET review_status='rejected',reviewed_at=now(),updated_at=now()
        WHERE id=$1 AND review_status='pending' RETURNING id,review_status,status`,[req.params.id]);
      if(!rows.length)return res.status(409).json({error:'Product not pending approval or not found'});
      res.json({...rows[0],published:false});
    }catch(e){fail(res,e);}
  });
  // Manual refresh for staged SKUs only. No supplier ordering and no automatic publishing.
  router.post('/sync',(_req,res)=>res.status(409).json({error:'Supplier inventory sync is disabled until catalog pricing and fulfillment are verified'}));
  router.post('/products/:id/hide',async(req,res)=>{
    const db=await pool.connect();try{await db.query('BEGIN');
      const {rows}=await db.query('SELECT inventory_id FROM distributor_catalog WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!rows.length){await db.query('ROLLBACK');return res.status(404).json({error:'Not found'});}
      if(rows[0].inventory_id)await db.query('UPDATE inventory SET public_visible=false,updated_at=now() WHERE id=$1',[rows[0].inventory_id]);
      await db.query("UPDATE distributor_catalog SET status='hidden',updated_at=now() WHERE id=$1",[req.params.id]);
      await db.query('COMMIT');res.json({hidden:true});
    }catch(e){await db.query('ROLLBACK');fail(res,e);}finally{db.release();}
  });
  return router;
}
