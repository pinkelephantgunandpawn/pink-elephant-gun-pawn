import multer from 'multer';
import csv from 'csv-parser';
import {Readable} from 'node:stream';

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1}});
const validId=s=>/^[A-Za-z0-9_-]{3,24}$/.test(s);
const allowed=new Set(['Firearms','Optics']);
const cols=['CSSI Item Number','Product Type','Supplier Category','Web Item Name','Manufacturer','UPC Code','Retail MAP'];
const money=s=>{
  const value=String(s??'').trim();
  if(!value||value==='-')return null;
  if(!/^\$?\d{1,7}(?:\.\d{1,2})?$/.test(value))return null;
  return Math.round(Number(value.replace('$',''))*100);
};
export function attachChattanoogaReferenceRoutes(router,pool){
  router.get('/reference/status',async(_req,res)=>{
    try{
      const {rows}=await pool.query("SELECT category,count(*)::int AS total FROM chattanooga_reference GROUP BY category ORDER BY category");
      res.set('Cache-Control','no-store');res.json({categories:rows,publication_enabled:false,reference_only:true});
    }catch{res.status(500).json({error:'Reference status unavailable'});}
  });
  router.post('/reference/upload',upload.single('file'),async(req,res)=>{
    if(!req.file)return res.status(400).json({error:'Upload the filtered firearms/optics CSV'});
    if(!/\.csv$/i.test(req.file.originalname))return res.status(400).json({error:'CSV only'});
    let count=0;
    const seen=new Set(),items=[];
    try{
      await new Promise((resolve,reject)=>{
        Readable.from(req.file.buffer).pipe(csv({strict:true,mapHeaders:({header})=>header.replace(/^\uFEFF/,'').trim()}))
          .on('headers',headers=>{if(cols.some(col=>!headers.includes(col)))reject(new Error('Expected filtered CSV columns'));})
          .on('data',row=>{
            const id=String(row['CSSI Item Number']??'').trim();
            const category=String(row['Product Type']??'').trim();
            if(!validId(id)||!allowed.has(category)||seen.has(id)){reject(new Error('Invalid, duplicate, or out-of-scope SKU'));return;}
            seen.add(id);
            const rawMap=String(row['Retail MAP']??'').trim();
            const map=money(rawMap);
            if(rawMap&&rawMap!=='-'&&map===null){reject(new Error('Invalid MAP value'));return;}
            items.push([id,category,String(row['Supplier Category']??'').slice(0,300),
              String(row['Web Item Name']??'').slice(0,240),String(row['Manufacturer']??'').slice(0,120),
              String(row['UPC Code']??'').slice(0,32),map]);
            count++;
            if(count>20000)reject(new Error('Too many records'));
          }).on('error',reject).on('end',resolve);
      });
      if(!items.length)return res.status(400).json({error:'Empty reference CSV'});
    }catch(e){return res.status(422).json({error:'Invalid reference CSV: '+e.message});}
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      // Replace the classification reference atomically; no catalog drafts or inventory modified.
      await db.query('DELETE FROM chattanooga_reference');
      for(let offset=0;offset<items.length;offset+=200){
        const chunk=items.slice(offset,offset+200);
        const values=chunk.flat();
        const placeholders=chunk.map((_,i)=>'('+Array.from({length:7},(_,j)=>'$'+(i*7+j+1)).join(',')+')').join(',');
        await db.query('INSERT INTO chattanooga_reference(supplier_item_id,category,supplier_category,reference_title,manufacturer,upc,map_cents) VALUES '+placeholders,values);
      }
      await db.query('COMMIT');
      res.set('Cache-Control','no-store');res.json({reference_rows:items.length,firearms:items.filter(x=>x[1]==='Firearms').length,optics:items.filter(x=>x[1]==='Optics').length,published:0,staged:0});
    }catch(e){await db.query('ROLLBACK');res.status(500).json({error:'Reference import failed; existing reference preserved'});}
    finally{db.release();}
  });
}
