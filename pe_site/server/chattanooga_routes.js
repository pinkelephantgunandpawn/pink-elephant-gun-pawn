import { Router } from 'express';
import { attachChattanoogaReferenceRoutes } from './chattanooga_reference.js';
import { createChattanoogaClient, evaluateFflStatus, ChattanoogaApiError } from './chattanooga_client.js';
import { retailPriceCents, parseSupplierMoneyCents, draftAdvertisedPrice } from './chattanooga_pricing.js';

// All routes MUST be mounted behind the application's existing auth and manager role middleware.
export function createChattanoogaRouter(pool) {
  const router=Router();
  attachChattanoogaReferenceRoutes(router,pool);
  const allowed=['draft','published','hidden'];
  const fail=(res,e)=>{console.error('Chattanooga admin request:',e?.message);res.status(500).json({error:'Distributor operation failed'});};
  const client=()=>createChattanoogaClient();
  // Read-only supplier lookup. Never infer eligibility from on-file status alone.
  router.get('/ffl-status/:fflNumber',async(req,res)=>{
    try{
      const body=await client().getFflStatus(req.params.fflNumber);
      const result=evaluateFflStatus(body,req.params.fflNumber);
      res.set('Cache-Control','no-store');
      res.json({...result,source:'chattanooga_v6_read_only',checked_at:new Date().toISOString()});
    }catch(e){
      if(e instanceof TypeError||e instanceof RangeError)return res.status(400).json({error:'Invalid FFL number'});
      if(e instanceof ChattanoogaApiError)return res.status(e.status===504?504:502).json({error:'Supplier FFL lookup unavailable or returned an invalid record'});
      fail(res,e);
    }
  });

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
    if(remaining>0){res.set('Retry-After',String(remaining));res.set('Cache-Control','no-store');return res.status(429).json({error:'Chattanooga product-feed inspection is cooling down. Please wait about '+Math.ceil(remaining/60)+' minute(s) before trying again. No products changed.',retry_after_seconds:remaining});}
    let step='requesting supplier feed';
    try{
      const feed=await client().getProductFeed({optional_columns:'retail_map,specifications',primary_image_only_flag:1});
      step='checking supplier feed response';
      const link=feed?.product_feed?.url;
      if(typeof link!=='string')return res.status(502).json({error:'Supplier did not return a product-feed URL'});
      step='validating supplier CSV location';
      const u=new URL(link);
      if(!['https:','http:'].includes(u.protocol)||u.hostname!=='api.chattanoogashooting.com'||!/^\/rest\/v[456]\/files\/customer_feeds\/products\//.test(u.pathname)||u.username||u.password){
        // Do not follow an unapproved URL. Expose only safe routing metadata,
        // never the full link, signed query, path identifiers, or credentials.
        res.set('Cache-Control','no-store');
        return res.status(502).json({error:'Supplier returned an unexpected product-feed location',feed_location_diagnostic:{https:u.protocol==='https:',host_is_expected:u.hostname==='api.chattanoogashooting.com',host_suffix:u.hostname.endsWith('.chattanoogashooting.com')?'chattanoogashooting.com':'other',path_shape:u.pathname.split('/').filter(Boolean).slice(0,3).map(part=>/^[a-z_-]{1,24}$/i.test(part)?part:'[redacted]').join('/'),has_query:!!u.search,approved_host:u.hostname==='api.chattanoogashooting.com'},note:'No download attempted. Share only this diagnostic metadata with support; never share the signed feed URL.'});
      }
      // CSSI support confirms product-feed links may be HTTP. Never fetch those
      // links over plaintext: even a CSV can disclose private supplier catalog data.
      if(u.protocol==='http:'){
        res.set('Cache-Control','no-store');
        return res.status(409).json({error:'Chattanooga supplied its documented HTTP CSV location. Download intentionally blocked pending confirmation of an HTTPS alternative.',feed_location_diagnostic:{https:false,host_is_expected:true,host_suffix:'chattanoogashooting.com',path_shape:'rest/v6/files',has_query:!!u.search,approved_host:true},note:'Supplier URL format confirmed by CSSI support. No insecure CSV download attempted; no products changed.'});
      }
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
    }catch(e){if(e?.status===429||e?.code==='too-many-requests'){feedInspectionCooldownUntil=Date.now()+30*60*1000;res.set('Retry-After','1800');}console.error('Chattanooga product feed diagnostic:',e?.message);res.status(e?.status===429||e?.code==='too-many-requests'?429:502).json({error:'Product-feed inspection failed at '+step+'. Supplier HTTP status: '+(Number.isInteger(e?.status)?e.status:'unknown')+'; supplier code: '+(e?.code===undefined||e?.code===null?'none':String(e.code).slice(0,32))+'. No products changed.'});}
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
  // Read-only, bounded eligibility breakdown. Counts only: never return costs or raw supplier records.
  router.get('/eligibility-diagnostics',async(_req,res)=>{
    try{
      const supplierItems=list(await client().getItems({page:1,per_page:50}));
      const refs=await referencesFor(supplierItems);
      const counts={sampled:supplierItems.length,missing_identity:0,missing_classification:0,missing_cost:0,invalid_cost:0,eligible:0};
      for(const item of supplierItems){
        const id=text(item.cssi_id??item.item_id??item.itemId??item.id??item.sku,120);
        const title=text(item.name??item.title??item.description,180);
        if(!id||!title){counts.missing_identity++;continue;}
        const category=refs.get(id)?.category??(id==='TX1GX293110EN1'?'Firearms':null)??scope(item);
        if(category!=='Firearms'&&category!=='Optics'){counts.missing_classification++;continue;}
        const rawCost=item.drop_ship_price??item.cost??item.dealer_price??item.wholesale_price??item.unit_cost;
        if(rawCost===undefined||rawCost===null||String(rawCost).trim()===''){counts.missing_cost++;continue;}
        try{money(rawCost);}catch{counts.invalid_cost++;continue;}
        counts.eligible++;
      }
      res.set('Cache-Control','no-store');
      res.json({...counts,notice:'Read-only first-page sample. Each record counted under its first rejection reason. No costs or raw supplier data returned. No products changed.'});
    }catch(e){
      console.error('Chattanooga eligibility diagnostic:',e?.name);
      res.status(e?.status===429?429:502).json({error:'Eligibility diagnostic unavailable. No products changed.'});
    }
  });
  // Read-only first-page identity matching diagnostic. No identifiers, prices, or records returned.
  router.get('/id-match-diagnostics',async(_req,res)=>{
    try{
      const items=list(await client().getItems({page:1,per_page:50}));
      const keys=['cssi_id','item_id','itemId','id','sku'];
      const values=Object.fromEntries(keys.map(key=>[key,new Set()]));
      for(const item of items)for(const key of keys){
        const value=text(item[key],120);
        if(value)values[key].add(value);
      }
      const allIds=[...new Set(keys.flatMap(key=>[...values[key]]))];
      const rows=allIds.length?(await pool.query('SELECT supplier_item_id FROM chattanooga_reference WHERE supplier_item_id=ANY($1::text[])',[allIds])).rows:[];
      const known=new Set(rows.map(row=>row.supplier_item_id));
      const matched_by_field=Object.fromEntries(keys.map(key=>[key,[...values[key]].filter(id=>known.has(id)).length]));
      const matched_items=items.filter(item=>keys.some(key=>known.has(text(item[key],120)))).length;
      const fields_present=Object.fromEntries(keys.map(key=>[key,items.filter(item=>!!text(item[key],120)).length]));
      res.set('Cache-Control','no-store');
      res.json({sampled:items.length,matched_items,unmatched_items:items.length-matched_items,matched_by_field,fields_present,notice:'Read-only sample; counts only. No IDs, prices, or raw supplier data returned. No products changed.'});
    }catch(e){
      console.error('Chattanooga ID matching diagnostic:',e?.name);
      res.status(e?.status===429?429:502).json({error:'ID matching diagnostic unavailable. No products changed.'});
    }
  });
  // Bounded read-only comparison of stored reference IDs and live supplier cssi_id formats.
  router.get('/reference-format-diagnostics',async(_req,res)=>{
    try{
      const items=list(await client().getItems({page:1,per_page:50}));
      const live=items.map(x=>text(x.cssi_id,120)).filter(Boolean);
      const {rows}=await pool.query('SELECT supplier_item_id FROM chattanooga_reference ORDER BY supplier_item_id LIMIT 250');
      const stored=rows.map(x=>text(x.supplier_item_id,120)).filter(Boolean);
      const shape=id=>/^\\d+$/.test(id)?'numeric':/^[A-Za-z]+$/.test(id)?'letters':/^[A-Za-z0-9]+$/.test(id)?'alphanumeric':'mixed_or_punctuated';
      const summary=ids=>({
        count:ids.length,
        formats:Object.fromEntries(['numeric','letters','alphanumeric','mixed_or_punctuated'].map(k=>[k,ids.filter(id=>shape(id)===k).length])),
        min_length:ids.length?Math.min(...ids.map(id=>id.length)):0,
        max_length:ids.length?Math.max(...ids.map(id=>id.length)):0
      });
      const lower=new Set(live.map(id=>id.toLowerCase()));
      const exact=new Set(live);
      const {rows:caseRows}=live.length?await pool.query('SELECT supplier_item_id FROM chattanooga_reference WHERE LOWER(supplier_item_id)=ANY($1::text[])',[...lower]):{rows:[]};
      const caseInsensitiveMatches=caseRows.filter(row=>!exact.has(row.supplier_item_id)).length;
      res.set('Cache-Control','no-store');
      res.json({reference_sample:summary(stored),supplier_sample:summary(live),case_insensitive_only_matches:caseInsensitiveMatches,notice:'Reference sample is first 250 sorted IDs; supplier sample is first 50 API records. Aggregate formats only; no IDs or prices returned. No products changed.'});
    }catch(e){
      console.error('Chattanooga reference format diagnostic:',e?.name);
      res.status(e?.status===429?429:502).json({error:'Reference format diagnostic unavailable. No products changed.'});
    }
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
  // Internal fulfillment readiness checklist. Dealer activation is confirmed
  // by sales correspondence, but no live supplier ordering is authorized here.
  router.get('/fulfillment-readiness',(_req,res)=>{
    res.set('Cache-Control','no-store');
    res.json({
      dealer_dropship_activation:'confirmed_by_sales_email_2026_10_21',
      api_credentials:'reported_issued_not_returned',
      supplier_order_submission:'disabled',
      supplier_product_publication:'disabled',
      customer_supplier_checkout:'disabled',
      fulfillment_requirements:{
        secure_feed_download:'http_only_confirmed_secure_alternative_needed',
        firearm_receiving_ffl_validation:'ffl_number_and_pdf_or_jpg_required',
        firearm_shipping_rules:'separate_firearms_from_non_ffl_and_handguns_from_long_guns',
        dropship_fees_and_restrictions:'fulfillment_agreement_received_2026_10_16_rates_subject_to_change',
        api_order_testing:'coordinate_with_sales_rep_before_real_test_order',
        supplier_ffl_lookup:'v6_read_only_lookup_implemented_document_upload_disabled',
        supplier_order_schema:'v6_documentation_received_order_submission_disabled',
        allocated_inventory:'requires_supplier_verification'
      },
      fulfillment_agreement:{
        effective_date:'2026-10-16',
        handgun_default_shipping_cents_per_30lb:1495,
        long_gun_default_shipping_cents_per_30lb:1395,
        accessory_ground_economy_cents_per_8lb:895,
        accessory_ground_premium_cents_per_30lb:1095,
        adult_signature_included_for_default_firearm_methods:true,
        insurance_cents_per_100_dollars:100,
        minimum_order_fee_cents:750,
        minimum_order_fee_threshold_cents:5000,
        restocking_fee_percent:15,
        rates_subject_to_change:true,
        ffl_document_formats:['pdf','jpg'],
        v6_ffl_upload_document_formats:['pdf','jpg','jpeg','png'],
        mixed_firearm_non_ffl_order_allowed:false,
        mixed_handgun_long_gun_order_allowed:false,
        same_day_eligibility_cutoff:'12:00 PM EST (not guaranteed)',
        source:'Signed CSSI fulfillment agreement dated 2026-10-16'
      },
      note:'Supplier authorization and contract terms confirmed. Automatic ordering, checkout and publication remain disabled pending implementation and testing.'
    });
  });
  // Export only non-sensitive review metadata. Never include wholesale costs,
  // signed image URLs, raw supplier records, or customer information.
  router.get('/review-export',async(req,res)=>{
    try{
      const exportFilters=["supplier='chattanooga'","status='draft'","category IN ('Firearms','Optics')"];const params=[];
      const review=typeof req.query.review==='string'?req.query.review:'';
      if(review){if(!['pending','approved','rejected'].includes(review))return res.status(400).json({error:'Invalid review status'});params.push(review);exportFilters.push('review_status=$'+params.length);}
      const {rows}=await pool.query("SELECT supplier_item_id,sku,upc,title,category,brand,status,review_status,map_cents,image_url,available_quantity,last_synced_at FROM distributor_catalog WHERE "+exportFilters.join(' AND ')+" ORDER BY category,title LIMIT 20000",params);
      if(rows.length>=20000){res.set('Cache-Control','no-store');return res.status(409).json({error:'Draft export exceeds the safe 20,000-row limit. Narrow the catalog before exporting; no partial file was generated.'});}
      const header=['Supplier ID','SKU','UPC','Title','Category','Brand','Review status','MAP provided','Photo URL present','Reported stock','Last refreshed'];
      const cell=v=>'"'+String(v??'').replace(/[\r\n]+/g,' ').replace(/^([=+@-])/,(m)=>"'"+m).replace(/"/g,'""')+'"';
      const lines=[header.map(cell).join(',')];
      for(const x of rows)lines.push([x.supplier_item_id,x.sku,x.upc,x.title,x.category,x.brand,x.review_status,x.map_cents!==null?'yes':'no',x.image_url?'yes':'no',x.available_quantity,x.last_synced_at?new Date(x.last_synced_at).toISOString():''].map(cell).join(','));
      res.set('Cache-Control','no-store');res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition','attachment; filename="chattanooga-draft-review.csv"');res.send('\uFEFF'+lines.join('\r\n')+'\r\n');
    }catch(e){fail(res,e);}
  });
  // Read-only inventory-review counts, including rejected drafts and records
  // that cannot yet be advertised. No supplier API requests are made.
  router.get('/review-summary',async(_req,res)=>{
    try{
      const {rows}=await pool.query(`SELECT
        count(*)::int AS draft_total,
        count(*) FILTER (WHERE review_status='pending')::int AS pending,
        count(*) FILTER (WHERE review_status='approved')::int AS approved,
        count(*) FILTER (WHERE review_status='rejected')::int AS rejected,
        count(*) FILTER (WHERE map_cents IS NULL OR map_cents<0)::int AS map_unverified,
        count(*) FILTER (WHERE image_url IS NULL OR image_url='')::int AS missing_image,
        count(*) FILTER (WHERE available_quantity IS NULL OR available_quantity<=0)::int AS no_reported_stock,
        count(*) FILTER (WHERE last_synced_at IS NULL OR last_synced_at<now()-interval '24 hours')::int AS stale_over_24h
        FROM distributor_catalog WHERE supplier='chattanooga' AND status='draft' AND category IN ('Firearms','Optics')`);
      res.set('Cache-Control','no-store');res.json({...rows[0],note:'Local snapshot counts; freshness does not guarantee available or allocated supplier stock.'});
    }catch(e){fail(res,e);}
  });
  // Contract-based fulfillment planning only: never transmits orders, FFLs,
  // customer addresses or license documents to the distributor.
  router.post('/fulfillment-preview',(req,res)=>{
    const kind=req.body?.kind;
    const weight=req.body?.weight_lb;
    const insured=req.body?.insured_value_usd??0;
    const fflNumberProvided=req.body?.ffl_number_provided===true;
    const fflDocumentProvided=req.body?.ffl_document_provided===true;
    const shippingRegion=req.body?.shipping_region??'contiguous_us';
    if(!['handgun','long_gun','optics'].includes(kind))return res.status(400).json({error:'Choose handgun, long_gun, or optics'});
    if(typeof weight!=='number'||!Number.isFinite(weight)||weight<=0||weight>300)return res.status(400).json({error:'Weight must be a number between 0 and 300 lb'});
    if(typeof insured!=='number'||!Number.isFinite(insured)||insured<0||insured>1000000)return res.status(400).json({error:'Insured value must be between $0 and $1,000,000'});
    if(shippingRegion!=='contiguous_us')return res.status(422).json({error:'Published flat-rate estimates apply only to the contiguous 48 states; obtain a supplier quote for other destinations'});
    const firearm=kind!=='optics';
    const shippingMethod=kind==='handgun'?'Second Day Air':kind==='long_gun'?'Ground Premium':'Ground Economy';
    const rateCents=kind==='handgun'?1495:kind==='long_gun'?1395:895;
    const bracketLb=kind==='optics'?8:30;
    const units=Math.ceil(weight/bracketLb);
    const baseShippingCents=units*rateCents;
    const insuranceCents=Math.ceil(insured/100)*100;
    const warnings=['Estimate only; CSSI may change rates and apply surcharges.','Does not verify stock allocation, MAP/UPP, legal eligibility, or destination FFL license validity.'];
    if(firearm&&!fflNumberProvided)warnings.push('Receiving dealer FFL number required.');
    if(firearm&&!fflDocumentProvided)warnings.push('Receiving dealer FFL PDF/JPG required.');
    if(firearm)warnings.push('Firearms must be separate from non-FFL goods; handguns and long guns require separate supplier orders.');
    res.set('Cache-Control','no-store');
    res.json({kind,shipping_method:shippingMethod,weight_lb:weight,rate_bracket_lb:bracketLb,rate_brackets:units,base_shipping_cents:baseShippingCents,optional_insurance_cents:insuranceCents,estimated_total_cents:baseShippingCents+insuranceCents,
      ffl_documents_reported_complete:!firearm||(fflNumberProvided&&fflDocumentProvided),
      order_submission_enabled:false,checkout_enabled:false,quote_binding:false,
      exclusions:'Minimum-order fees, address changes, restocking, surcharges, taxes, FFL dealer fees and non-contiguous shipping not included.',warnings});
  });
  // Contract-compliant order grouping preview. Never creates or transmits an order.
  router.post('/order-group-preview',(req,res)=>{
    const items=req.body?.items;
    if(!Array.isArray(items)||items.length===0||items.length>100)return res.status(400).json({error:'Provide 1 to 100 order line types'});
    const groups={handgun:[],long_gun:[],non_ffl:[]};
    for(let i=0;i<items.length;i++){
      const x=items[i];
      if(!x||!['handgun','long_gun','optics'].includes(x.kind)||!Number.isInteger(x.quantity)||x.quantity<1||x.quantity>100)
        return res.status(400).json({error:'Each line needs a valid kind and quantity from 1 to 100'});
      const key=x.kind==='optics'?'non_ffl':x.kind;
      groups[key].push({line:i+1,kind:x.kind,quantity:x.quantity});
    }
    const plan=Object.entries(groups).filter(([,lines])=>lines.length).map(([group,lines])=>({
      group,lines,receiving_ffl_required:group!=='non_ffl',ffl_number_required:group!=='non_ffl',
      ffl_pdf_or_jpg_required:group!=='non_ffl',supplier_order_created:false
    }));
    res.set('Cache-Control','no-store');
    res.json({planned_orders:plan,planned_order_count:plan.length,order_submission_enabled:false,
      warnings:['Firearms must be separate from non-FFL items; handguns and long guns cannot ship together.',
        'This plan does not check FFL validity, product restrictions, pricing, inventory, customer eligibility or shipping charges.',
        'Coordinate a test order with Chattanooga before any real supplier submission.']});
  });
  // Validate proposed fulfillment data without accepting or storing sensitive
  // license files, addresses, customer identities, or creating supplier orders.
  router.post('/order-validation-preview',(req,res)=>{
    const items=req.body?.items;
    if(!Array.isArray(items)||items.length<1||items.length>100)return res.status(400).json({error:'Provide 1 to 100 proposed order lines'});
    const errors=[],warnings=[],groups={handgun:0,long_gun:0,optics:0};
    const proposedKinds=new Set();
    for(let i=0;i<items.length;i++){
      const line=items[i];
      if(!line||!['handgun','long_gun','optics'].includes(line.kind)){errors.push('Line '+(i+1)+': unsupported product type');continue;}
      proposedKinds.add(line.kind);
      if(!Number.isInteger(line.quantity)||line.quantity<1||line.quantity>100)errors.push('Line '+(i+1)+': quantity must be a whole number from 1 to 100');
      else groups[line.kind]+=line.quantity;
      if(typeof line.sku!=='string'||!line.sku.trim()||line.sku.length>80)errors.push('Line '+(i+1)+': valid supplier SKU required');
    }
    const firearm=proposedKinds.has('handgun')||proposedKinds.has('long_gun');
    if(firearm&&req.body?.receiving_ffl_number_available!==true)errors.push('Receiving FFL number must be available for firearm groups');
    if(firearm&&req.body?.receiving_ffl_document_available!==true)errors.push('Receiving FFL PDF/JPG must be available for firearm groups');
    if(firearm)warnings.push('Receiving dealer license authenticity, current status and destination eligibility must be verified separately.');
    if(proposedKinds.has('handgun')&&proposedKinds.has('long_gun'))warnings.push('Handguns and long guns require separate supplier orders.');
    if(firearm&&proposedKinds.has('optics'))warnings.push('Firearms and non-FFL products require separate supplier orders.');
    warnings.push('Supplier inventory allocation, pricing/MAP, legal eligibility, tax, shipping charges and API schema are not verified.');
    res.set('Cache-Control','no-store');
    res.json({passes_local_structure_checks:errors.length===0,errors,warnings,
      proposed_groups:Object.entries(groups).filter(([,n])=>n>0).map(([kind,quantity])=>({kind,quantity})),
      supplier_api_payload_generated:false,supplier_order_created:false,checkout_enabled:false});
  });
  // Read-only local SKU check. This cannot verify real-time supplier allocation.
  router.get('/sku-readiness',async(req,res)=>{
    const sku=typeof req.query.sku==='string'?req.query.sku.trim():'';
    if(!sku||sku.length>80)return res.status(400).json({error:'A supplier SKU of up to 80 characters is required'});
    try{
      const {rows}=await pool.query(`SELECT sku,title,category,status,review_status,map_cents,
        image_url,available_quantity,last_synced_at
        FROM distributor_catalog WHERE supplier='chattanooga' AND sku=$1
          AND category IN ('Firearms','Optics') ORDER BY updated_at DESC LIMIT 2`,[sku]);
      if(!rows.length)return res.status(404).json({error:'SKU is not present in the local Chattanooga draft catalog'});
      if(rows.length>1)return res.status(409).json({error:'Duplicate supplier SKU in local catalog; manual review required'});
      const x=rows[0],issues=[];
      if(x.status!=='draft')issues.push('Not a draft');
      if(x.review_status!=='approved')issues.push('Not approved for internal review');
      if(x.map_cents===null||x.map_cents<0)issues.push('MAP unverified');
      if(!x.image_url)issues.push('Product image missing');
      if(x.available_quantity===null||x.available_quantity<=0)issues.push('No reported supplier stock');
      const refreshed=x.last_synced_at?new Date(x.last_synced_at).getTime():NaN;
      if(!Number.isFinite(refreshed)||Date.now()-refreshed>86400000||refreshed>Date.now()+300000)issues.push('Inventory snapshot stale or invalid');
      res.set('Cache-Control','no-store');
      res.json({sku:x.sku,title:x.title,category:x.category,review_status:x.review_status,
        reported_quantity:x.available_quantity,last_refreshed:x.last_synced_at,
        passes_local_data_checks:issues.length===0,issues,
        live_inventory_verified:false,allocation_verified:false,eligible_for_checkout:false,eligible_for_order_submission:false,
        note:'Local snapshot only. Passing checks does not authorize listing, checkout or supplier order.'});
    }catch(e){fail(res,e);}
  });
  // Bulk local catalog reconciliation for prospective order lines. Never a live stock check.
  router.post('/order-catalog-check',async(req,res)=>{
    const lines=req.body?.items;
    if(!Array.isArray(lines)||lines.length<1||lines.length>20)return res.status(400).json({error:'Provide 1 to 20 proposed SKU lines'});
    const skus=[];
    for(const [i,line] of lines.entries()){
      if(!line||typeof line.sku!=='string'||!line.sku.trim()||line.sku.length>80||
        !Number.isInteger(line.quantity)||line.quantity<1||line.quantity>100)
        return res.status(400).json({error:'Line '+(i+1)+' needs a supplier SKU and quantity 1–100'});
      skus.push(line.sku.trim());
    }
    const totalRequested=new Map();
    for(let i=0;i<lines.length;i++)totalRequested.set(skus[i],(totalRequested.get(skus[i])||0)+lines[i].quantity);
    try{
      const {rows}=await pool.query(`SELECT sku,category,status,review_status,map_cents,cost_cents,markup_percent,price_override_cents,image_url,
        available_quantity,last_synced_at FROM distributor_catalog
        WHERE supplier='chattanooga' AND sku=ANY($1::text[]) AND category IN ('Firearms','Optics')`,[skus]);
      const bySku=new Map();
      for(const x of rows){const a=bySku.get(x.sku)||[];a.push(x);bySku.set(x.sku,a);}
      const results=lines.map((line,i)=>{
        const sku=skus[i],matches=bySku.get(sku)||[],issues=[];
        if(matches.length===0)issues.push('Not found in local staged catalog');
        if(matches.length>1)issues.push('Duplicate local SKU');
        // An explicit proposed kind is optional, but when provided it must agree
        // with the supplier's broad catalog category. Handgun versus long gun
        // still requires a separate verified classification.
        if(line.kind===undefined&&matches.length===1&&matches[0].category==='Firearms')issues.push('Handgun versus long gun classification must be explicitly verified');
        if(line.kind!==undefined){
          if(!['handgun','long_gun','optics'].includes(line.kind))issues.push('Invalid proposed product type');
          else if(matches.length===1){
            const expected=line.kind==='optics'?'Optics':'Firearms';
            if(matches[0].category!==expected)issues.push('Proposed product type conflicts with local supplier category');
          }
        }
        if(matches.length===1){
          const x=matches[0];
          if(x.status!=='draft')issues.push('Not an unpublished draft');
          if(x.review_status!=='approved')issues.push('Draft not approved for review');
          if(x.map_cents===null||x.map_cents<0)issues.push('MAP unverified');
          if(!Number.isSafeInteger(Number(x.cost_cents))||Number(x.cost_cents)<=0)issues.push('Wholesale cost missing or invalid');
          try{
            const pricing=draftAdvertisedPrice({costCents:x.cost_cents,mapCents:x.map_cents,
              markupPercent:Number(x.markup_percent),overrideCents:x.price_override_cents});
            if(!Number.isSafeInteger(pricing.advertisedCents)||pricing.advertisedCents<=0)issues.push('Advertised price missing or invalid');
            if(pricing.belowMap)issues.push('Base proposed price is below MAP; displayed price requires MAP adjustment');
          }catch{issues.push('Pricing calculation failed; review wholesale cost and markup');}
          if(!x.image_url)issues.push('Image missing');
          if(x.available_quantity===null||x.available_quantity<totalRequested.get(sku))issues.push('Reported stock below combined requested quantity for this SKU');
          const timestamp=x.last_synced_at?new Date(x.last_synced_at).getTime():NaN;
          if(!Number.isFinite(timestamp)||Date.now()-timestamp>86400000||timestamp>Date.now()+300000)issues.push('Inventory snapshot stale or invalid');
        }
        return {line:i+1,sku,quantity:line.quantity,category:matches.length===1?matches[0].category:null,
          local_data_complete:issues.length===0,issues,live_allocation_verified:false};
      });
      res.set('Cache-Control','no-store');
      const firearmLines=results.filter(x=>x.category==='Firearms');
      res.json({results,all_local_data_complete:results.every(x=>x.local_data_complete),
        firearm_classification_required:firearmLines.length>0,
        supplier_order_created:false,order_submission_enabled:false,
        warning:'Local inventory snapshots cannot confirm current availability or reserved stock. Do not use as an order approval.'});
    }catch(e){fail(res,e);}
  });
  // Read-only operational checklist for a supplier-coordinated test. No test
  // shipment or supplier API request is ever initiated by this endpoint.
  router.get('/test-order-checklist',(_req,res)=>{
    res.set('Cache-Control','no-store');
    res.json({
      test_submission_enabled:false,
      prerequisites:[
        {key:'sales_rep_acknowledgment',label:'Text Chattanooga sales representative and obtain acknowledgment before submitting a test',complete:false},
        {key:'api_order_schema',label:'Verify exact V6 order creation fields, authentication, and supported test notation',complete:false},
        {key:'receiving_ffl',label:'For firearms, verify receiving FFL number and PDF/JPG license document',complete:false},
        {key:'supplier_ffl_lookup',label:'Use the documented Chattanooga FFL lookup to confirm dealer is on file; upload missing FFL only after reviewing exact API schema and license',complete:false},
        {key:'order_separation',label:'Separate handgun, long gun, and non-FFL items into distinct supplier orders',complete:false},
        {key:'availability',label:'Confirm supplier allocation and current stock before test',complete:false},
        {key:'costs',label:'Review freight, insurance, minimum order fees, tax and possible real charges',complete:false},
        {key:'test_label',label:'Mark supplier order note or PO as TEST if approved by representative',complete:false},
        {key:'explicit_approval',label:'Obtain explicit owner authorization for a specific coordinated test order',complete:false}
      ],
      warning:'The supplier has no sandbox. A TEST note alone does not guarantee no charge or shipment. No orders are sent from this integration.'
    });
  });
  // No live ordering: give managers a private, local-only checklist of
  // drafts that pass basic data checks. This is NOT a launch authorization.
  router.get('/candidate-summary',async(_req,res)=>{
    try{
      const {rows}=await pool.query(`SELECT category,
        count(*)::int AS drafts,
        count(*) FILTER (WHERE review_status='approved' AND map_cents IS NOT NULL AND map_cents>=0
          AND image_url IS NOT NULL AND image_url<>'' AND available_quantity>0
          AND last_synced_at>=now()-interval '24 hours')::int AS data_complete_candidates,
        count(*) FILTER (WHERE review_status='approved' AND (map_cents IS NULL OR map_cents<0))::int AS approved_missing_map,
        count(*) FILTER (WHERE review_status='approved' AND (image_url IS NULL OR image_url=''))::int AS approved_missing_photo
        FROM distributor_catalog WHERE supplier='chattanooga' AND status='draft'
          AND category IN ('Firearms','Optics') GROUP BY category ORDER BY category`);
      res.set('Cache-Control','no-store');
      res.json({categories:rows,can_publish:false,can_accept_orders:false,allocation_verified:false,
        note:'Data-complete candidates are not approved for publication or sale; fulfillment, restrictions, MAP interpretation and allocation remain gated.'});
    }catch(e){fail(res,e);}
  });
  router.get('/categories',async(_req,res)=>{try{const {rows}=await pool.query("SELECT category,count(*)::int AS total,count(*) FILTER (WHERE status='draft')::int AS drafts,count(*) FILTER (WHERE status='published')::int AS published FROM distributor_catalog WHERE supplier='chattanooga' AND category IN ('Firearms','Optics') GROUP BY category ORDER BY category");res.json(rows);}catch(e){fail(res,e);}});
  router.get('/products',async(req,res)=>{try{
    const where=["supplier='chattanooga'"],values=[];
    if(req.query.category){values.push(text(req.query.category,80));where.push(`category=$${values.length}`);}
    if(allowed.includes(req.query.status)){values.push(req.query.status);where.push(`status=$${values.length}`);}
    if(req.query.search){values.push('%'+text(req.query.search,100).replace(/[\\%_]/g,'\\$&')+'%');where.push(`(title ILIKE $${values.length} OR sku ILIKE $${values.length} OR brand ILIKE $${values.length} OR upc ILIKE $${values.length})`);}
    const attention=typeof req.query.attention==='string'?req.query.attention.slice(0,32):'';
    const attentionFilters={
      pending:"status='draft' AND review_status='pending'",
      missing_image:"status='draft' AND (image_url IS NULL OR image_url='')",
      map_unverified:"status='draft' AND (map_cents IS NULL OR map_cents<0)",
      zero_stock:"status='draft' AND (available_quantity IS NULL OR available_quantity<=0)",
      stale_stock:"status='draft' AND (last_synced_at IS NULL OR last_synced_at<now()-interval '24 hours')",
      approved:"status='draft' AND review_status='approved'",
      rejected:"status='draft' AND review_status='rejected'"
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
  // A rejected draft can be returned to the pending review queue without
  // approving or publishing it.
  router.post('/products/:id/reopen',async(req,res)=>{
    try{
      const {rows}=await pool.query(`UPDATE distributor_catalog SET review_status='pending',reviewed_at=NULL,updated_at=now()
        WHERE id=$1 AND supplier='chattanooga' AND status='draft' AND review_status='rejected'
        AND category IN ('Firearms','Optics') RETURNING id,review_status,status`,[req.params.id]);
      if(!rows.length)return res.status(409).json({error:'Only rejected firearm/optic drafts can be reopened'});
      res.set('Cache-Control','no-store');res.json({...rows[0],published:false});
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
