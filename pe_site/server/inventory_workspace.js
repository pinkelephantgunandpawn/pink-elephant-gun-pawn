import path from 'node:path';
import express from 'express';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';

// Fixed repository files only. No uploaded contents, URLs, or request input are read here.
export function buildInventoryWorkspace(){
  const template=JSON.parse(readFileSync(new URL('./inventory_workspace_template.json',import.meta.url),'utf8'));
  return template.replaceAll('PE_WORKSPACE_NONCE_PLACEHOLDER',randomBytes(18).toString('base64'));
}

export function createInventoryWorkspaceRouter({pool,auth,requireRole}){
  const router=express.Router();
  router.use((_req,res,next)=>{res.set({'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff'});next();});
  router.use(auth,requireRole('manager'));
  router.get('/',async(req,res)=>{
    try{
      // Confirm the existing signed session still belongs to an active privileged account.
      const {rows}=await pool.query('SELECT role,active FROM users WHERE id=$1',[req.user.sub]);
      if(!rows[0]?.active||!['manager','admin'].includes(rows[0].role))return res.status(403).json({error:'Inventory workspace access denied'});
      res.json({html:buildInventoryWorkspace(),read_only:true,session_expires_at:Number(req.user.exp)*1000});
    }catch{return res.status(503).json({error:'Inventory workspace unavailable. Please try again later.'});}
  });
  return router;
}

// Keep the generated document out of the existing public static file tree.
export function blockInventoryWorkspaceTemplate(req,res,next){
  let pathname;try{pathname=decodeURIComponent(req.path);}catch{return next();}
  if(path.posix.normalize('/'+pathname.replaceAll('\\','/')).toLowerCase()==='/server/inventory_workspace_template.json')return res.sendStatus(404);
  next();
}
