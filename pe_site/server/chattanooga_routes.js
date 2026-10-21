import { Router } from 'express';
import { createChattanoogaClient } from './chattanooga_client.js';
import { retailPriceCents } from './chattanooga_pricing.js';

// All routes MUST be mounted behind the application's existing auth and manager role middleware.
export function createChattanoogaRouter(pool) {
  const router=Router();
  const allowed=['draft','published','hidden'];
  const fail=(res,e)=>{console.error('Chattanooga admin request:',e?.message);res.status(500).json({error:'Distributor operation failed'});};
  const client=()=>createChattanoogaClient();
  const bounded=(v,def,max)=>Number.isInteger(Number(v))&&Number(v)>0?Math.min(Number(v),max):def;
  const text=(v,n=255)=>String(v??'').trim().slice(0,n);
  const money=(v)=>{const n=Number(v);return Number.isFinite(n)&&n>=0?Math.round(n*100):0;};
  const list=(body)=>Array.isArray(body)?body:(Array.isArray(body?.items)?body.items:Array.isArray(body?.product_feed)?body.product_feed:[]);
  const normalize=(x)=>{
    const id=text(x.item_id??x.itemId??x.id??x.sku,120);
    const title=text(x.description??x.name??x.title,180);
    if(!id||!title) return null;
    const rawCost=x.cost??x.price??x.dealer_price??x.wholesale_price;
    if(rawCost===undefined||rawCost===null||!Number.isFinite(Number(rawCost))||Number(rawCost)<0)return null;
    return {id,title,category:text(x.category_name??x.category??x.product_category??'Uncategorized',80)||'Uncategorized',
      brand:text(x.manufacturer??x.brand,120),sku:text(x.sku??x.item_id??id,80),upc:text(x.upc??x.upc_code,80),
      description:text(x.long_description??x.product_description??x.description??'',4000),
      image_url:text(x.image_url??x.image??'',1000),
      cost_cents:money(rawCost),quantity:Math.max(0,Math.floor(Number(x.quantity_available??x.available_quantity??x.quantity??x.qty??0)||0)),raw:x};
  };
  router.get('/health',(_req,res)=>res.json({configured:!!(process.env.CHATTANOOGA_SID&&process.env.CHATTANOOGA_TOKEN),version:'v6',default_markup:20,ordering_enabled:false}));
  router.get('/remote',async(req,res)=>{try{
    const page=bounded(req.query.page,1,100000),per_page=bounded(req.query.per_page,50,100);
    const feed=req.query.feed==='1';
    const data=await (feed?client().getProductFeed({page,per_page}):client().getItems({page,per_page}));
    res.set('Cache-Control','no-store');
    res.json({data,normalized:list(data).map(normalize).filter(Boolean),page,per_page});
  }catch(e){res.status(e.status===401?502:502).json({error:'Chattanooga catalog unavailable',code:e.code??null});}});
  router.get('/categories',async(_req,res)=>{try{const {rows}=await pool.query("SELECT category,count(*)::int AS total,count(*) FILTER (WHERE status='draft')::int AS drafts,count(*) FILTER (WHERE status='published')::int AS published FROM distributor_catalog GROUP BY category ORDER BY category");res.json(rows);}catch(e){fail(res,e);}});
  router.get('/products',async(req,res)=>{try{
    const where=["supplier='chattanooga'"],values=[];
    if(req.query.category){values.push(text(req.query.category,80));where.push(`category=$${values.length}`);}
    if(allowed.includes(req.query.status)){values.push(req.query.status);where.push(`status=$${values.length}`);}
    if(req.query.search){values.push('%'+text(req.query.search,100)+'%');where.push(`(title ILIKE $${values.length} OR sku ILIKE $${values.length} OR brand ILIKE $${values.length} OR upc ILIKE $${values.length})`);}
    const limit=bounded(req.query.limit,50,100),offset=(bounded(req.query.page,1,100000)-1)*limit;
    values.push(limit,offset);
    const {rows}=await pool.query(`SELECT id,supplier_item_id,title,category,brand,sku,upc,description,image_url,cost_cents,available_quantity,markup_percent,price_override_cents,status,inventory_id,last_synced_at FROM distributor_catalog WHERE ${where.join(' AND ')} ORDER BY category,title LIMIT $${values.length-1} OFFSET $${values.length}`,values);
    res.json(rows.map(x=>({...x,retail_price_cents:retailPriceCents(x.cost_cents,Number(x.markup_percent),x.price_override_cents)})));
  }catch(e){fail(res,e);}});
  router.post('/stage',async(req,res)=>{const raw=Array.isArray(req.body?.items)?req.body.items:[];
    if(!raw.length||raw.length>100)return res.status(400).json({error:'Select 1–100 products'});
    const normalized=raw.map(normalize);if(normalized.some(x=>!x))return res.status(400).json({error:'Invalid item or missing cost; verify supplier fields'});
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
  router.post('/products/:id/publish',async(req,res)=>{
    const db=await pool.connect();try{await db.query('BEGIN');
      const {rows}=await db.query('SELECT * FROM distributor_catalog WHERE id=$1 FOR UPDATE',[req.params.id]);
      const x=rows[0];if(!x){await db.query('ROLLBACK');return res.status(404).json({error:'Not found'});}
      if(!x.cost_cents){await db.query('ROLLBACK');return res.status(422).json({error:'Cannot publish item without verified cost'});}
      const price=retailPriceCents(x.cost_cents,Number(x.markup_percent),x.price_override_cents);
      // Conservative policy: all distributor products are hidden from checkout pending category/FFL review.
      // Publishing makes the listing visible; existing regulated checkout controls remain in place.
      const regulated=/firearm|rifle|shotgun|handgun|pistol|ammo|ammunition|receiver|silencer|suppressor/i.test(x.category);
      const sku='CSSI-'+x.supplier_item_id;
      if(x.inventory_id){
        await db.query('UPDATE inventory SET title=$2,category=$3,quantity=$4,cost_cents=$5,price_cents=$6,description=$7,image_url=$8,regulated=$9,public_visible=true,updated_at=now() WHERE id=$1',
          [x.inventory_id,x.title,x.category,x.available_quantity,x.cost_cents,price,x.description,x.image_url||null,regulated]);
      }else{
        const created=await db.query(`INSERT INTO inventory(title,category,quantity,cost_cents,price_cents,sku,item_type,description,image_url,regulated,public_visible)
          VALUES($1,$2,$3,$4,$5,$6,'quantity',$7,$8,$9,true) RETURNING id`,
          [x.title,x.category,x.available_quantity,x.cost_cents,price,sku,x.description,x.image_url||null,regulated]);
        await db.query('UPDATE distributor_catalog SET inventory_id=$2 WHERE id=$1',[x.id,created.rows[0].id]);
      }
      await db.query("UPDATE distributor_catalog SET status='published',updated_at=now() WHERE id=$1",[x.id]);
      await db.query('COMMIT');res.json({published:true});
    }catch(e){await db.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'SKU already exists'});fail(res,e);}finally{db.release();}
  });
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
