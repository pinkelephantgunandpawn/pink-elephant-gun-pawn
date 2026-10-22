import { Router } from 'express';
import { attachChattanoogaReferenceRoutes } from './chattanooga_reference.js';
import { createChattanoogaClient } from './chattanooga_client.js';
import { retailPriceCents, parseSupplierMoneyCents, draftAdvertisedPrice } from './chattanooga_pricing.js';

// All routes MUST be mounted behind the application's existing auth and manager role middleware.
export function createChattanoogaRouter(pool) {
  const router=Router();
  attachChattanoogaReferenceRoutes(router,pool);
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
    const excluded=/\b(?:powder|primers?|ammunition|ammo|magazines?|reloading|holsters?|mounts?|rings?|bases?|batter(?:y|ies)|cleaning|knives?|suppressors?|silencers?|airguns?|pellets?|accessories)\b/;
    if(excluded.test(fields))return null;
    // A handgun listing may mention included magazines; don't treat that as a magazine-only accessory.
    const firearmTitle=/\b(?:handgun|pistol|revolver|rifle|shotgun)\b/.test(name);
    const accessoryTitle=/\b(?:magazine\s+(?:for|fits|compatible)|replacement\s+magazine|spare\s+magazine|holster|scope\s+mount|rifle\s+case)\b/.test(name);
    if(excluded.test(name)&&!(firearmTitle&&!accessoryTitle))return null;
    if(firearmTitle&&!accessoryTitle)return 'Firearms';
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
  const normalize=(x,reference=null)=>{
    const id=text(x.cssi_id??x.item_id??x.itemId??x.id??x.sku,120);
    const title=text(x.name??x.title??x.description,180);
    if(!id||!title) return null;
    // Exact dealer-portal-verified firearm; never infer firearm status from arbitrary numeric flags.
    const verifiedCategory=id==='TX1GX293110EN1'?'Firearms':null;
    const catalogCategory=reference?.category??verifiedCategory??scope(x);if(!catalogCategory)return null;
    const rawCost=x.drop_ship_price??x.cost??x.dealer_price??x.wholesale_price??x.unit_cost;
    if(rawCost===undefined||rawCost===null)return null;
    let costCents;try{costCents=money(rawCost);}catch{return null;}
    const mapRaw=x.retail_map_price;
    let mapCents=null;
    if(mapRaw!==undefined&&mapRaw!==null&&String(mapRaw).trim()!==''){try{mapCents=money(mapRaw);}catch{mapCents=null;}}
    if(mapCents===null&&reference?.map_cents!==null&&reference?.map_cents!==undefined)mapCents=Number(reference.map_cents);
    return {id,title:reference?.reference_title||title,category:catalogCategory,
      brand:text(x.manufacturer??x.brand??reference?.manufacturer,120),sku:text(x.sku??x.cssi_id??x.item_id??id,80),upc:text(x.upc??x.upc_code??reference?.upc,80),
      description:text(x.long_description??x.product_description??x.description??reference?.reference_title??'',4000),
      image_url:imageUrl(x),
      map_cents:mapCents,cost_cents:costCents,quantity:Math.max(0,Math.floor(Number(x.inventory??x.quantity_available??x.available_quantity??x.quantity??x.qty??0)||0)),raw:x};
  };
  const referenceFor=async(id)=>{
    const {rows}=await pool.query('SELECT category,reference_title,manufacturer,upc,map_cents FROM chattanooga_reference WHERE supplier_item_id=$1',[id]);
    return rows[0]??null;
  };
  const referencesFor=async(items)=>{
    const ids=items.map(x=>text(x.cssi_id??x.item_id??x.itemId??x.id??x.sku,120)).filter(Boolean);
    if(!ids.length)return new Map();
    const {rows}=await pool.query('SELECT supplier_item_id,category,reference_title,manufacturer,upc,map_cents FROM chattanooga_reference WHERE supplier_item_id=ANY($1::text[])',[ids]);
    return new Map(rows.map(x=>[x.supplier_item_id,x]));
  };
  router.get('/health',(_req,res)=>res.json({configured:!!(process.env.CHATTANOOGA_SID&&process.env.CHATTANOOGA_TOKEN),version:'v6',default_markup:20,ordering_enabled:false}));
  // Read-only product-feed diagnostic: fetch only a small prefix of the supplier CSV.
  // Never expose a signed feed URL, API credentials, or item records to the browser.
  let feedInspectionCooldownUntil=0;
  router.get('/product-feed/diagnostics',async(_req,res)=>{
    const remaining=Math.ceil((feedInspectionCooldownUntil-Date.now())/1000);
    if(remaining>0)return res.status(429).json({error:'Chattanooga product-feed inspection is cooling down. Please wait about '+Math.ceil(remaining/60)+' minute(s) before trying again. No products changed.',retry_after_seconds:remaining});
    let step='requesting supplier feed';
    try{
      const feed=await client().getProductFeed({optional_columns:'retail_map,specifications',primary_image_only_flag:1});
      step='checking supplier feed response';
      const link=feed?.product_feed?.url;
      if(typeof link!=='string')return res.status(502).json({error:'Supplier did not return a product-feed URL'});
      step='validating supplier CSV location';
      const u=new URL(link);
      if(u.protocol!=='https:'||u.hostname!=='api.chattanoogashooting.com'||!/^\/rest\/v[456]\/files\/customer_feeds\/products\//.test(u.pathname)||u.username||u.password)
        return res.status(502).json({error:'Supplier returned an unexpected product-feed location'});
      step='downloading CSV header';
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),12000);
      let response;
      try{
        response=await fetch(u,{headers:{Range:'bytes=0-65535',Accept:'text/csv'},signal:controller.signal,redirect:'error'});
        if(!response.ok)return res.status(502).json({error:'Unable to retrieve supplier product-feed header'});
        const reader=response.body?.getReader();
        if(!reader)return res.status(502).json({error:'Supplier feed returned no readable content'});
        const decoder=new TextDecoder();let prefix='',total=0;
        try{
          while(total<65536&&!prefix.includes('\n')){
            const chunk=await reader.read();if(chunk.done)break;
            total+=chunk.value.byteLength;
            if(total>65536)throw Error('Feed header exceeds safety limit');
            prefix+=decoder.decode(chunk.value,{stream:true});
          }
        }finally{await reader.cancel().catch(()=>{});}
        step='parsing CSV columns';
        const header=prefix.split(/\r?\n/,1)[0].replace(/^\uFEFF/,'');
        if(!header||header.length>16384)throw Error('Invalid CSV header');
        const columns=header.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)?.map(x=>x.replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"').trim()).filter(Boolean)||[];
        if(!columns.length)throw Error('No CSV columns');
        res.set('Cache-Control','no-store');
        res.json({column_count:columns.length,columns:columns.slice(0,150),image_columns:columns.filter(x=>/image|photo|picture|media|thumbnail/i.test(x)),map_columns:columns.filter(x=>/map|minimum.advertised/i.test(x)),stock_columns:columns.filter(x=>/inventory|stock|allocat|quantity/i.test(x)),notice:'Read-only column inspection. No CSV saved, products staged, or supplier orders submitted.'});
      }finally{clearTimeout(timer);}
    }catch(e){if(e?.status===429||e?.code==='too-many-requests'){feedInspectionCooldownUntil=Date.now()+30*60*1000;res.set('Retry-After','1800');}console.error('Chattanooga product feed diagnostic:',e?.message);res.status(502).json({error:'Product-feed inspection failed at '+step+'. Supplier HTTP status: '+(Number.isInteger(e?.status)?e.status:'unknown')+'; supplier code: '+(e?.code===undefined||e?.code===null?'none':String(e.code).slice(0,32))+'. No products changed.'});}
  });
  router.get('/field-diagnostics',async(_req,res)=>{try{
    const data=await client().getItems({page:1,per_page:3});
    const items=list(data);
    const fields=[...new Set(items.flatMap(item=>Object.keys(item)))].sort();
    const imageFields=fields.filter(key=>/image|photo|picture|media|thumbnail|asset/i.test(key));
    const categoryFields=fields.filter(key=>/categor|department|group|type|class|subcategor/i.test(key));
    res.set('Cache-Control','no-store');
    res.json({sample_size:items.length,image_field_names:imageFields,category_field_names:categoryFields,eligible_count:items.map(normalize).filter(Boolean).length,notice:'Field names only; no credentials, supplier costs, or raw records exposed'});
  }catch(e){res.status(502).json({error:'Unable to inspect supplier field names'});}});
  // Inspect one known supplier SKU safely: metadata only, no wholesale values or raw payload.
  router.get('/sku-diagnostics',async(req,res)=>{
    try{
      const sku=text(req.query.sku,24);
      if(!/^[A-Za-z0-9_-]{3,24}$/.test(sku))return res.status(400).json({error:'Enter a valid Chattanooga item number'});
      const data=await client().getItems({item_ids:sku});
      const items=list(data);
      const item=items.find(x=>String(x.cssi_id??x.item_id??x.sku??'').toUpperCase()===sku.toUpperCase());
      if(!item)return res.status(404).json({error:'Supplier SKU not found'});
      const normalized=normalize(item,await referenceFor(sku));
      const keys=Object.keys(item).sort();
      res.set('Cache-Control','no-store');
      res.json({sku,found:true,title:text(item.name??item.title,180),serialized_flag:item.serialized_flag===true||item.serialized_flag===1||item.serialized_flag==='1',
        image_field_names:keys.filter(k=>/image|photo|picture|media|thumbnail|asset/i.test(k)),
        category_field_names:keys.filter(k=>/categor|department|group|type|class|subcategor/i.test(k)),
        recognized_category:normalized?.category??null,has_usable_image:!!normalized?.image_url,
        available_quantity_reported:Number(item.inventory??0),
        note:'Diagnostic only. No price, raw supplier record, or credentials exposed. This does not approve or publish products.'});
    }catch(e){res.status(502).json({error:'Unable to inspect supplier SKU'});}
  });
  // Exact-SKU preview, read-only. Approval and publishing remain separate and disabled respectively.
  router.get('/lookup',async(req,res)=>{
    try{
      const sku=text(req.query.sku,24);
      if(!/^[A-Za-z0-9_-]{3,24}$/.test(sku))return res.status(400).json({error:'Invalid supplier item number'});
      const data=await client().getItems({item_ids:sku});
      const item=list(data).find(x=>String(x.cssi_id??x.item_id??x.sku??'').toUpperCase()===sku.toUpperCase());
      if(!item)return res.status(404).json({error:'Supplier item not found'});
      const product=normalize(item,await referenceFor(sku));
      if(!product)return res.status(422).json({error:'Item not verified as firearm or optic, or supplier cost unavailable'});
      const {raw,...preview}=product;
      res.set('Cache-Control','no-store');res.json({product:preview,publishing_enabled:false});
    }catch(e){res.status(502).json({error:'Supplier SKU lookup unavailable'});}
  });
  router.get('/remote',async(req,res)=>{try{
    const page=bounded(req.query.page,1,100000),per_page=bounded(req.query.per_page,50,50);
    if(req.query.feed==='1') return res.status(400).json({error:'Product-feed CSV is not available in this read-only preview'});
    const data=await client().getItems({page,per_page});
    res.set('Cache-Control','no-store');
    const supplierItems=list(data);const refs=await referencesFor(supplierItems);res.json({normalized:supplierItems.map(x=>normalize(x,refs.get(text(x.cssi_id??x.item_id??x.itemId??x.id??x.sku,120)))).filter(Boolean).map(({raw,...item})=>item),page,per_page,supplier_count:supplierItems.length});
  }catch(e){res.status(e.status===401?502:502).json({error:'Chattanooga catalog unavailable',code:e.code??null});}});
  // Read-only refresh of one staged SKU. Never publishes or modifies storefront inventory.
  router.post('/products/:id/refresh',async(req,res)=>{
    try{
      const existing=await pool.query("SELECT supplier_item_id,status FROM distributor_catalog WHERE id=$1 AND supplier='chattanooga'",[req.params.id]);
      if(!existing.rows.length)return res.status(404).json({error:'Product not found'});
      if(existing.rows[0].status!=='draft')return res.status(409).json({error:'Only draft supplier records may be refreshed'});
      const supplierId=existing.rows[0].supplier_item_id;
      const data=await client().getItems({item_ids:supplierId});
      const ref=await referenceFor(supplierId);const item=list(data).map(x=>normalize(x,ref)).find(x=>x?.id===supplierId);
      if(!item)return res.status(422).json({error:'Supplier item unavailable or outside firearms/optics scope; draft left unchanged'});
      const {rows}=await pool.query(`UPDATE distributor_catalog SET title=$2,category=$3,brand=$4,sku=$5,upc=$6,description=$7,image_url=$8,cost_cents=$9,available_quantity=$10,raw_data=$11,map_cents=$12,review_status='pending',reviewed_at=NULL,last_synced_at=now(),updated_at=now()
        WHERE id=$1 AND supplier='chattanooga' AND status='draft' RETURNING id,title,category,image_url,available_quantity,last_synced_at`,
        [req.params.id,item.title,item.category,item.brand,item.sku,item.upc,item.description,item.image_url,item.cost_cents,item.quantity,JSON.stringify(item.raw),item.map_cents]);
      if(!rows.length)return res.status(409).json({error:'Draft changed; refresh not applied'});
      res.set('Cache-Control','no-store');res.json({...rows[0],published:false});
    }catch(e){res.status(502).json({error:'Supplier refresh failed; existing draft retained'});}
  });
  // Preview current supplier availability for one staged item without changing its approval or storefront state.
  router.get('/products/:id/availability',async(req,res)=>{
    try{
      const {rows}=await pool.query("SELECT supplier_item_id,category FROM distributor_catalog WHERE id=$1 AND supplier='chattanooga' AND status='draft'",[req.params.id]);
      if(!rows.length)return res.status(404).json({error:'Draft not found'});
      const supplierId=rows[0].supplier_item_id;
      const data=await client().getItems({item_ids:supplierId});
      const reference=await referenceFor(supplierId);
      const item=list(data).map(x=>normalize(x,reference)).find(x=>x?.id===supplierId);
      if(!item)return res.status(422).json({error:'Supplier availability not verifiable; do not promise stock'});
      res.set('Cache-Control','no-store');
      res.json({supplier_item_id:supplierId,reported_quantity:item.quantity,category:item.category,available_to_sell_verified:false,note:'Supplier quantity is informational, not a confirmed allocation or checkout reservation'});
    }catch(e){res.status(502).json({error:'Unable to verify supplier stock'});}
  });
  // Database-only launch readiness summary. No supplier API calls and no storefront writes.
  router.get('/readiness',async(_req,res)=>{
    try{
      const {rows}=await pool.query(`SELECT
        count(*) FILTER (WHERE status='draft' AND category IN ('Firearms','Optics'))::int AS scoped_drafts,
        count(*) FILTER (WHERE status='draft' AND category IN ('Firearms','Optics') AND review_status='approved')::int AS approved_drafts,
        count(*) FILTER (WHERE status='draft' AND category IN ('Firearms','Optics') AND review_status='pending')::int AS pending_drafts,
        count(*) FILTER (WHERE status='draft' AND category IN ('Firearms','Optics') AND (map_cents IS NULL))::int AS missing_map_verification,
        count(*) FILTER (WHERE status='draft' AND category IN ('Firearms','Optics') AND (image_url IS NULL OR image_url=''))::int AS missing_images,
        count(*) FILTER (WHERE status='draft' AND category IN ('Firearms','Optics') AND available_quantity=0)::int AS zero_reported_stock,
        count(*) FILTER (WHERE status='published' AND category IN ('Firearms','Optics'))::int AS published_rows
        FROM distributor_catalog WHERE supplier='chattanooga'`);
      res.set('Cache-Control','no-store');
      res.json({...rows[0],supplier_orders_enabled:false,automatic_publishing_enabled:false,stock_allocation_verified:false,ffl_fulfillment_verified:false,note:'Local draft snapshot only. Missing MAP does not necessarily mean no manufacturer MAP; allocation is not verified.'});
    }catch(e){fail(res,e);}
  });
  router.get('/categories',async(_req,res)=>{try{const {rows}=await pool.query("SELECT category,count(*)::int AS total,count(*) FILTER (WHERE status='draft')::int AS drafts,count(*) FILTER (WHERE status='published')::int AS published FROM distributor_catalog WHERE supplier='chattanooga' AND category IN ('Firearms','Optics') GROUP BY category ORDER BY category");res.json(rows);}catch(e){fail(res,e);}});
  router.get('/products',async(req,res)=>{try{
    const where=["supplier='chattanooga'"],values=[];
    if(req.query.category){values.push(text(req.query.category,80));where.push(`category=$${values.length}`);}
    if(allowed.includes(req.query.status)){values.push(req.query.status);where.push(`status=$${values.length}`);}
    if(req.query.search){values.push('%'+text(req.query.search,100)+'%');where.push(`(title ILIKE ${values.length} OR sku ILIKE ${values.length} OR brand ILIKE ${values.length} OR upc ILIKE ${values.length})`);}
    const attention=text(req.query.attention,32);
    const attentionFilters={
      pending:"status='draft' AND review_status='pending'",
      missing_image:"status='draft' AND (image_url IS NULL OR image_url='')",
      map_unverified:"status='draft' AND map_cents IS NULL",
      zero_stock:"status='draft' AND available_quantity=0",
      approved:"status='draft' AND review_status='approved'"
    };
    if(attention && !Object.hasOwn(attentionFilters,attention))return res.status(400).json({error:'Invalid review filter'});
    if(attention)where.push('('+attentionFilters[attention]+')');
    where.push("category IN ('Firearms','Optics')");

    const limit=bounded(req.query.limit,50,100),offset=(bounded(req.query.page,1,100000)-1)*limit;
    values.push(limit,offset);
    const {rows}=await pool.query(`SELECT id,supplier_item_id,title,category,brand,sku,upc,description,image_url,cost_cents,map_cents,available_quantity,markup_percent,price_override_cents,status,review_status,reviewed_at,inventory_id,last_synced_at FROM distributor_catalog WHERE ${where.join(' AND ')} ORDER BY category,title LIMIT $${values.length-1} OFFSET $${values.length}`,values);
    res.set('Cache-Control','no-store');res.json(rows.map(x=>{const p=draftAdvertisedPrice({costCents:x.cost_cents,mapCents:x.map_cents,markupPercent:Number(x.markup_percent),overrideCents:x.price_override_cents});return {...x,retail_price_cents:p.proposedCents,advertised_price_cents:p.advertisedCents,map_verified:p.mapVerified,below_map:p.belowMap,allocation_verified:false,launch_ready:false};}));
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
        const ref=await referenceFor(id);const item=list(result).map(x=>normalize(x,ref)).find(x=>x?.id===id);
        if(!item)return res.status(422).json({error:'Product is not a verified firearm/optic or supplier cost and stock could not be confirmed',item_id:id});
        normalized.push(item);
      }
    }catch(e){return res.status(502).json({error:'Supplier verification unavailable; nothing staged'});}
    const db=await pool.connect();try{await db.query('BEGIN');
      for(const x of normalized){await db.query(`INSERT INTO distributor_catalog(supplier_item_id,title,category,brand,sku,upc,description,image_url,cost_cents,available_quantity,raw_data,map_cents,last_synced_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
        ON CONFLICT(supplier,supplier_item_id) DO UPDATE SET
        title=EXCLUDED.title,category=EXCLUDED.category,brand=EXCLUDED.brand,sku=EXCLUDED.sku,upc=EXCLUDED.upc,description=EXCLUDED.description,
        image_url=EXCLUDED.image_url,cost_cents=EXCLUDED.cost_cents,available_quantity=EXCLUDED.available_quantity,
        raw_data=EXCLUDED.raw_data,map_cents=EXCLUDED.map_cents,review_status='pending',reviewed_at=NULL,last_synced_at=now(),updated_at=now() WHERE distributor_catalog.status='draft'`,[x.id,x.title,x.category,x.brand,x.sku,x.upc,x.description,x.image_url,x.cost_cents,x.quantity,JSON.stringify(x.raw),x.map_cents]);}
      await db.query('COMMIT');res.json({staged:normalized.length});
    }catch(e){await db.query('ROLLBACK');fail(res,e);}finally{db.release();}
  });
  router.patch('/products/:id',async(req,res)=>{
    const {markup_percent,price_override_cents}=req.body||{};
    if(markup_percent===undefined&&price_override_cents===undefined)return res.status(400).json({error:'No changes supplied'});
    if(markup_percent!==undefined&&(!Number.isFinite(markup_percent)||markup_percent<0||markup_percent>500))return res.status(400).json({error:'Invalid markup'});
    if(price_override_cents!==undefined&&price_override_cents!==null&&(!Number.isSafeInteger(price_override_cents)||price_override_cents<0))return res.status(400).json({error:'Invalid override'});
    // Overrides are private draft targets; the computed advertised price always floors at MAP.
    try{const {rows}=await pool.query(`UPDATE distributor_catalog SET markup_percent=COALESCE($2,markup_percent),price_override_cents=CASE WHEN $3 THEN $4 ELSE price_override_cents END,review_status='pending',reviewed_at=NULL,updated_at=now() WHERE id=$1 AND supplier='chattanooga' AND status='draft' RETURNING id,status`,[req.params.id,markup_percent??null,price_override_cents!==undefined,price_override_cents??null]);if(!rows.length)return res.status(404).json({error:'Not found'});res.json(rows[0]);}catch(e){fail(res,e);}
  });
  // Publishing stays disabled until cost semantics, MAP and shipping restrictions are verified.
  // Admin approval is a separate explicit action and never implies publication.
  router.post('/products/:id/publish',(_req,res)=>res.status(409).json({
    error:'Supplier publication is not yet enabled: verify MAP, shipping, product restrictions and final pricing first.'
  }));
  router.post('/products/:id/approve',async(req,res)=>{
    try {
      const {rows}=await pool.query(`UPDATE distributor_catalog SET review_status='approved',reviewed_at=now(),updated_at=now()
        WHERE id=$1 AND supplier='chattanooga' AND status='draft' AND review_status='pending' AND category IN ('Firearms','Optics') RETURNING id,review_status,status`,[req.params.id]);
      if(!rows.length)return res.status(409).json({error:'Product not pending approval or not found'});
      res.json({...rows[0],published:false});
    }catch(e){fail(res,e);}
  });
  router.post('/products/:id/reject',async(req,res)=>{
    try {
      const {rows}=await pool.query(`UPDATE distributor_catalog SET review_status='rejected',reviewed_at=now(),updated_at=now()
        WHERE id=$1 AND supplier='chattanooga' AND status='draft' AND review_status='pending' AND category IN ('Firearms','Optics') RETURNING id,review_status,status`,[req.params.id]);
      if(!rows.length)return res.status(409).json({error:'Product not pending approval or not found'});
      res.json({...rows[0],published:false});
    }catch(e){fail(res,e);}
  });
  // Manual refresh for staged SKUs only. No supplier ordering and no automatic publishing.
  router.post('/sync',(_req,res)=>res.status(409).json({error:'Supplier inventory sync is disabled until catalog pricing and fulfillment are verified'}));
  router.post('/products/:id/hide',async(req,res)=>{
    const db=await pool.connect();try{await db.query('BEGIN');
      const {rows}=await db.query("SELECT inventory_id FROM distributor_catalog WHERE id=$1 AND supplier='chattanooga' FOR UPDATE",[req.params.id]);
      if(!rows.length){await db.query('ROLLBACK');return res.status(404).json({error:'Not found'});}
      if(rows[0].inventory_id)await db.query('UPDATE inventory SET public_visible=false,updated_at=now() WHERE id=$1',[rows[0].inventory_id]);
      await db.query("UPDATE distributor_catalog SET status='hidden',updated_at=now() WHERE id=$1 AND supplier='chattanooga'",[req.params.id]);
      await db.query('COMMIT');res.json({hidden:true});
    }catch(e){await db.query('ROLLBACK');fail(res,e);}finally{db.release();}
  });
  return router;
}
