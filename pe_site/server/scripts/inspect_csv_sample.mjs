import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {previewCsvSample,CSV_SAMPLE_LIMITS} from '../offline_csv_preview.js';

// Explicit local paths only. No network requests, DB imports or application startup.
async function readSample(path){
  if(!path||/^[a-z][a-z0-9+.-]*:\/\//i.test(path))throw Error('local_file');
  const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.size>CSV_SAMPLE_LIMITS.bytes)throw Error('sample_limit');
    const buffer=Buffer.alloc(CSV_SAMPLE_LIMITS.bytes+1);let size=0;
    while(size<buffer.length){const r=await file.read(buffer,size,buffer.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
    if(size>CSV_SAMPLE_LIMITS.bytes)throw Error('sample_limit');return buffer.subarray(0,size);
  }finally{await file.close();}
}
try{
  const args=process.argv.slice(2),allowed=new Set(['--input','--id-column','--image-column','--reference','--reference-id-column']);
  const options={};
  for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!allowed.has(key)||!value||value.startsWith('--'))throw Error('arguments');
    if(key==='--image-column')(options[key]??=[]).push(value);else {if(options[key]!==undefined)throw Error('arguments');options[key]=value;}}
  if(!options['--input']||!options['--id-column']||!options['--image-column'])throw Error('arguments');
  if(Boolean(options['--reference'])!==Boolean(options['--reference-id-column']))throw Error('arguments');
  const report=previewCsvSample(await readSample(options['--input']),{idColumn:options['--id-column'],imageColumns:options['--image-column'],referenceBuffer:options['--reference']?await readSample(options['--reference']):undefined,referenceIdColumn:options['--reference-id-column']});
  console.log(JSON.stringify(report,null,2));
}catch{
  console.error('Local CSV inspection failed. Check sample limits, UTF-8 CSV structure and explicit column arguments. No file contents or paths are logged.');process.exitCode=1;
}
