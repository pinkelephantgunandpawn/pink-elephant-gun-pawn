import http from 'node:http';
import { createChattanoogaClient } from './chattanooga_client.js';
// Standalone test service: NO store database, checkout, orders, or production website.
// Does not return supplier records or credentials to public callers.
let state={status:'starting',checked_at:null};
async function check(){
  if(!process.env.CHATTANOOGA_SID||!process.env.CHATTANOOGA_TOKEN){state={status:'credentials_missing',checked_at:new Date().toISOString()};return;}
  try{
    const data=await createChattanoogaClient().getItems({page:1,per_page:1});
    const rootKeys=Object.keys(data||{}).slice(0,20);
    const records=Array.isArray(data)?data:(Array.isArray(data?.items)?data.items:Array.isArray(data?.data)?data.data:[]);
    const itemKeys=records.length?Object.keys(records[0]).slice(0,50):[];
    const fieldTypes=records.length?Object.fromEntries(Object.entries(records[0]).map(([k,v])=>[k,Array.isArray(v)?'array':v===null?'null':typeof v])):{};
    const nestedKeys=records.length?Object.fromEntries(Object.entries(records[0]).filter(([k,v])=>v&&typeof v==='object'&&!Array.isArray(v)).map(([k,v])=>[k,Object.keys(v).slice(0,30)])):{};
    let feed={status:'unavailable'};
    try {
      const payload=await createChattanoogaClient().getProductFeed({page:1,per_page:1});
      const entries=Array.isArray(payload?.items)?payload.items:Array.isArray(payload?.product_feed)?payload.product_feed:Array.isArray(payload?.data)?payload.data:[];
      feed={status:'connected',rootKeys:Object.keys(payload||{}).slice(0,20),itemKeys:entries[0]?Object.keys(entries[0]).slice(0,70):[],fieldTypes:entries[0]?Object.fromEntries(Object.entries(entries[0]).map(([k,v])=>[k,Array.isArray(v)?'array':v===null?'null':typeof v])):{}};
    }catch(e){feed={status:'request_failed',httpStatus:e?.status||null,errorCode:e?.code||null};}
    // Output only field names, never prices, supplier IDs, or tokens.
    console.log('Chattanooga read-only probe OK',JSON.stringify({rootKeys,itemKeys,fieldTypes,nestedKeys,feed}));
    state={status:'connected',checked_at:new Date().toISOString(),rootKeys,itemKeys,fieldTypes,nestedKeys,feed};
  }catch(e){
    console.error('Chattanooga read-only probe failed',e?.status||'request_error',e?.code||'');
    state={status:'connection_failed',checked_at:new Date().toISOString()};
  }
}
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');if(req.url!=='/health'){res.writeHead(404);res.end('{}');return;}res.end(JSON.stringify({ok:true,service:'chattanooga-isolated-test',...state}));}).listen(Number(process.env.PORT||10000),'0.0.0.0',()=>{console.log('Isolated Chattanooga probe listening');check();});
