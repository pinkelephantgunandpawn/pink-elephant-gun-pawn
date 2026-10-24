// Local-file inspection only. No database, supplier client or network dependency.
const limits=Object.freeze({bytes:1024*1024,rows:200,columns:200,cell:65536});
export class CsvPreviewError extends Error {
  constructor(code){super('CSV preview rejected: '+code);this.name='CsvPreviewError';this.code=code;}
}
const reject=code=>{throw new CsvPreviewError(code);};

// Strict, bounded CSV for owner-provided small samples; never reads a full feed.
export function parseCsvSample(buffer){
  if(!(buffer instanceof Uint8Array)||buffer.byteLength>limits.bytes)reject('file_limit');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{reject('encoding');}
  if(text.includes('\0'))reject('encoding');
  text=text.replace(/^\uFEFF/,'');
  const rows=[];let row=[],cell='',state='start',ended=false;
  const addChar=c=>{cell+=c;if(cell.length>limits.cell)reject('cell_limit');};
  const field=()=>{row.push(cell);cell='';if(row.length>limits.columns)reject('column_limit');state='start';};
  const record=()=>{field();rows.push(row);row=[];if(rows.length>limits.rows+1)reject('row_limit');};
  for(let i=0;i<text.length;i++){
    const c=text[i];ended=false;
    if(state==='quoted'){
      if(c==='"'){if(text[i+1]==='"'){addChar('"');i++;}else state='closed';}
      else addChar(c);
      continue;
    }
    if(c===','){field();continue;}
    if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;record();ended=true;continue;}
    if(state==='closed')reject('quote_syntax');
    if(c==='"'){if(state!=='start')reject('quote_syntax');state='quoted';}
    else {state='unquoted';addChar(c);}
  }
  if(state==='quoted')reject('quote_syntax');
  if(text&&!ended)record();
  if(!rows.length)reject('empty_file');
  const headers=rows.shift().map(h=>h.trim());
  if(headers.some(h=>!h||h.length>128||/[\r\n\x00-\x1f]/.test(h))||new Set(headers).size!==headers.length)reject('headers');
  if(rows.some(r=>r.length!==headers.length))reject('row_width');
  return {headers,rows};
}

export function inspectImageUrl(value){
  const input=String(value??'');
  if(/[\x00-\x1f\x7f]/.test(input))return 'invalid';
  const raw=input.trim();
  if(!raw)return 'missing';
  if(raw.length>8192||/[\x00-\x20\x7f]/.test(raw))return 'invalid';
  try{
    const u=new URL(raw),h=u.hostname.toLowerCase();
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return 'rejected';
    // Syntactic validation only, not DNS resolution or permission to fetch.
    if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)||h==='localhost'||/\.(?:localhost|local|internal|test|invalid)$/.test(h))return 'rejected';
    return 'https_url_present';
  }catch{return 'invalid';}
}

export function previewCsvSample(buffer,{idColumn,imageColumns,referenceBuffer,referenceIdColumn}={}){
  const csv=parseCsvSample(buffer);
  if(typeof idColumn!=='string'||!csv.headers.includes(idColumn))reject('id_column');
  if(!Array.isArray(imageColumns)||!imageColumns.length||new Set(imageColumns).size!==imageColumns.length||imageColumns.some(c=>!csv.headers.includes(c)||c===idColumn))reject('image_columns');
  let references;
  if(referenceBuffer!==undefined){
    const ref=parseCsvSample(referenceBuffer);const index=ref.headers.indexOf(referenceIdColumn);
    if(index<0)reject('reference_id_column');
    references=new Map();for(const row of ref.rows){const id=row[index];if(!id.trim())reject('reference_id');references.set(id,(references.get(id)||0)+1);}
  }
  const idIndex=csv.headers.indexOf(idColumn),imageIndices=imageColumns.map(c=>csv.headers.indexOf(c));
  const counts=new Map();for(const row of csv.rows){const id=row[idIndex];if(id.trim())counts.set(id,(counts.get(id)||0)+1);}
  // Return row numbers and statuses only: no SKUs, signed URLs, prices or other cells.
  const sample=csv.rows.map((row,i)=>{
    const id=row[idIndex];
    const matching=!id.trim()?'missing_id':counts.get(id)>1?'duplicate_sample_id':!references?'not_checked':(references.get(id)||0)>1?'ambiguous_reference_id':references.has(id)?'exact_match':'no_exact_match';
    return {record:i+1,matching,images:imageIndices.map(index=>inspectImageUrl(row[index]))};
  });
  return {read_only:true,database_writes:0,network_requests:0,records:sample.length,column_count:csv.headers.length,
    matching_rule:'Exact case-sensitive strings; no coercion, trimming, UPC inference or fuzzy matching.',
    image_accessibility:'Not checked. HTTPS syntax alone does not prove the image is accessible.',sample};
}

export const CSV_SAMPLE_LIMITS=limits;
