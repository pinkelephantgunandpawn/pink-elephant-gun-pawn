import {parseCsvSample,CSV_SAMPLE_LIMITS} from '../../pe_site/server/offline_csv_preview.js';
export const categories=['Music','Electronics','Cameras','Watches','Outdoor gear','Books'];
const items=[['Acoustic guitar','Music','guitar','Juniper'],['Studio headphones','Electronics','headphones','Northstar'],['Mirrorless camera','Cameras','camera','Frame & Co.'],['Everyday field watch','Watches','watch','Atlas'],['Weekend backpack','Outdoor gear','bag','Fieldnote'],['Portable speaker','Electronics','speaker','Northstar'],['Design bookshelf collection','Books','books','Paperhouse'],['Compact keyboard','Music','keyboard','Juniper'],['Over-ear headphones','Electronics','headphones','Northstar'],['Travel camera','Cameras','camera','Frame & Co.'],['Canvas daypack','Outdoor gear','bag','Fieldnote'],['Quartz wristwatch','Watches','watch','Atlas'],['Travel photography books','Books','books','Paperhouse'],['Bluetooth desk speaker','Electronics','speaker','Northstar'],['Travel acoustic guitar','Music','guitar','Juniper'],['Mechanical keyboard','Electronics','keyboard','Northstar'],['Digital compact camera','Cameras','camera','Frame & Co.'],['Classic watch','Watches','watch','Atlas'],['Trail backpack','Outdoor gear','bag','Fieldnote'],['Architecture book set','Books','books','Paperhouse'],['Practice keyboard','Music','keyboard','Juniper'],['Mini wireless speaker','Electronics','speaker','Northstar'],['Recording headphones','Music','headphones','Juniper'],['Daily carry bag','Outdoor gear','bag','Fieldnote']];
export const demoItems=items.map(([name,category,art,brand],i)=>({uid:'demo-'+i,name,category,brand,sku:i===11?'DEMO-011':i===22?'':'DEMO-'+String(i+1).padStart(3,'0'),quantity:i%6===0?0:(i*7%29)+1,images:i%5===0?[]:[`assets/${art}.svg`,...(i%3===1?[`assets/${art}-detail.svg`]:[])],description:'Synthetic demonstration merchandise for reviewing the inventory workspace. This record does not represent an item in the live store.',condition:['Good','Very good','Like new'][i%3],source:'Synthetic demonstration',location:['Display cabinet','Stockroom shelf','Front counter'][i%3]}));
export function qualityWarnings(item,all=demoItems){const warnings=[];if(!item.sku.trim())warnings.push('Identifier is missing');if(item.sku&&all.filter(x=>x.sku===item.sku).length>1)warnings.push('Identifier is repeated; records retained');if(!item.images.length)warnings.push('No image attached');if(!item.name.trim())warnings.push('Item name is missing');return warnings;}
export function selectItems(items,{query='',category='',stock='',image='',sort='name',direction=1,page=1,pageSize=8}={}){
 const q=query.trim().toLocaleLowerCase();const filtered=items.filter(x=>(!q||[x.name,x.sku,x.brand].some(v=>v.toLocaleLowerCase().includes(q)))&&(!category||x.category===category)&&(!stock||(stock==='in'?x.quantity>0:x.quantity===0))&&(!image||(image==='present'?x.images.length>0:x.images.length===0)));
 filtered.sort((a,b)=>direction*(typeof a[sort]==='number'?a[sort]-b[sort]:String(a[sort]).localeCompare(String(b[sort])))||a.uid.localeCompare(b.uid));
 const pages=Math.max(1,Math.ceil(filtered.length/pageSize)),current=Math.max(1,Math.min(page,pages));return {items:filtered.slice((current-1)*pageSize,current*pageSize),total:filtered.length,page:current,pages};
}
const approvedHosts=new Set(['images.unsplash.com','images.pexels.com']);
export function imageSource(value){
 if(!value)return {status:'missing'};
 if(/^assets\/[a-z-]+\.svg$/.test(value))return {status:'local',url:typeof workspaceAssets==='undefined'?value:workspaceAssets[value]};
 if(/[\x00-\x20\x7f]/.test(value))return {status:'invalid'};
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return {status:'invalid'};if(!approvedHosts.has(u.hostname))return {status:'host_review'};return {status:'external',url:u.href,host:u.hostname};}catch{return {status:'invalid'};}
}
export function decodeSample(bytes,encoding='utf-8'){
 if(bytes.byteLength>CSV_SAMPLE_LIMITS.bytes)throw Error('This file exceeds the 1 MiB preview limit. Choose a small, complete sample.');
 if(!['utf-8','windows-1252'].includes(encoding))throw Error('Choose a supported text encoding.');
 let text;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{throw Error('The file does not match the selected encoding. Try the exporter’s documented encoding.');}
 return parseCsvSample(new TextEncoder().encode(text));
}
export function validateMapped(csv,{idColumn,nameColumn,imageColumn=''}){
 const id=csv.headers.indexOf(idColumn),name=csv.headers.indexOf(nameColumn),image=csv.headers.indexOf(imageColumn);
 if(id<0||name<0||id===name)throw Error('Map separate identifier and name columns.');
 const counts=new Map();for(const r of csv.rows)if(r[id].trim())counts.set(r[id],(counts.get(r[id])||0)+1);
 const rows=csv.rows.map((r,i)=>({record:i+1,id:r[id],name:r[name],issues:[...(!r[id].trim()?['Missing identifier']:[]),...(!r[name].trim()?['Missing name']:[]),...(counts.get(r[id])>1?['Repeated identifier']:[]),...(image>=0&&!['local','external','missing'].includes(imageSource(r[image]).status)?['Image URL needs review']:[])],image:image<0?'not_mapped':imageSource(r[image]).status}));
 return {records:rows.length,repeatedGroups:[...counts.values()].filter(n=>n>1).length,missing:rows.filter(r=>r.issues.some(i=>i.startsWith('Missing'))).length,attention:rows.filter(r=>r.issues.length).length,rows};
}
