import {generateInventoryWorkspaceTemplate} from '../scripts/build_inventory_workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createInventoryWorkspaceRouter,buildInventoryWorkspace,blockInventoryWorkspaceTemplate} from '../inventory_workspace.js';
const index=readFileSync(new URL('../index.js',import.meta.url),'utf8');
const secret='test-only-local-secret-not-used-outside-tests';
const context=vm.createContext({jwt,process:{env:{JWT_SECRET:secret}}});
// Exercise the actual existing authentication/role middleware, not substitutes.
vm.runInContext(index.match(/function auth\(req,res,next\)\{[\s\S]*?\n\}/)[0]+"\nconst roles={viewer:1,manager:2,admin:3};"+index.match(/const requireRole=min =>[^\n]+/)[0]+'\nthis.auth=auth;this.requireRole=requireRole;',context);
async function withServer(account,fn){
 let queries=[];const pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:account?[account]:[]};}};
 const app=express();app.use('/api/admin/inventory-workspace',createInventoryWorkspaceRouter({pool,auth:context.auth,requireRole:context.requireRole}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const request=async(claims,opts={})=>{const headers=claims?{Authorization:'Bearer '+jwt.sign(claims,secret,{issuer:'pink-elephant-api',expiresIn:'8h',...opts})}:{};return fetch(`http://127.0.0.1:${server.address().port}/api/admin/inventory-workspace`,{headers});};
 try{await fn(request,queries);}finally{await new Promise(r=>server.close(r));}
}
test('unauthenticated request is denied before any database access',()=>withServer({active:true,role:'admin'},async(req,q)=>{const r=await req();assert.equal(r.status,401);assert.equal(q.length,0);assert.match(r.headers.get('cache-control'),/no-store/);}));
test('expired existing session is denied',()=>withServer({active:true,role:'admin'},async(req,q)=>{const r=await req({sub:1,role:'admin'},{expiresIn:-1});assert.equal(r.status,401);assert.equal(q.length,0);}));
test('viewer role cannot access CSV inspection',()=>withServer({active:true,role:'viewer'},async(req,q)=>{assert.equal((await req({sub:1,role:'viewer'})).status,403);assert.equal(q.length,0);}));
test('disabled, deleted and demoted accounts are denied despite signed sessions',async()=>{for(const account of [{active:false,role:'admin'},null,{active:true,role:'viewer'}])await withServer(account,async(req)=>assert.equal((await req({sub:1,role:'admin'})).status,403));});
test('active manager and admin can load a read-only workspace with only one SELECT',async()=>{for(const role of ['admin','manager'])await withServer({active:true,role},async(req,q)=>{const r=await req({sub:7,role});assert.equal(r.status,200);const data=await r.json();assert.equal(data.read_only,true);assert.ok(data.session_expires_at>Date.now());assert.match(data.html,/Inventory overview/);assert.equal(q.length,1);assert.equal(q[0].sql,'SELECT role,active FROM users WHERE id=$1');assert.deepEqual(q[0].args,[7]);});});
test('bundle is self-contained with no module imports or credentials and strict CSP',()=>{const html=buildInventoryWorkspace();assert.doesNotMatch(html,/^import |^export /m);assert.doesNotMatch(html,/localStorage|sessionStorage|XMLHttpRequest|\bfetch\s*\(/);assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);assert.match(html,/data:image\/svg\+xml;base64/);assert.match(html,/nonce-/);assert.doesNotMatch(html,/src="app.js"|href="styles.css"/);const js=html.match(/<script[^>]+>([\s\S]*)<\/script>/)[1];new vm.Script(js);});
test('admin integration preserves sandbox and drops private frame state on logout/navigation',()=>{const html=readFileSync(new URL('../../admin.html',import.meta.url),'utf8');assert.match(html,/sandbox="allow-scripts"/);assert.doesNotMatch(html,/sandbox="[^"]*allow-same-origin/);assert.match(html,/function logout\(\)\{clearInventoryWorkspace\(\)/);assert.match(html,/if\(id!=='inventory-workspace'\)clearInventoryWorkspace\(\)/);assert.match(html,/frame.removeAttribute\('srcdoc'\)/);assert.match(html,/generation!==workspaceGeneration/);assert.match(html,/id="workspaceNav"/);assert.match(html,/setTimeout\(clearInventoryWorkspace/);assert.match(html,/previous.replaceWith\(frame\)/);assert.match(html,/data.session_expires_at<=Date.now\(\)/);assert.match(index,/app.use\('\/api\/admin\/inventory-workspace',createInventoryWorkspaceRouter\(\{pool,auth,requireRole\}\)\)/);});
test('database errors return a sanitized failure without logging private details',async()=>{
 const app=express();app.use(createInventoryWorkspaceRouter({pool:{query:async()=>{throw Error('private database connection detail');}},auth:(req,_res,next)=>{req.user={sub:1};next();},requireRole:()=> (_req,_res,next)=>next()}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{const response=await fetch(`http://127.0.0.1:${server.address().port}/`);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private database/);}finally{await new Promise(r=>server.close(r));}
});

test('committed runtime bundle matches the reviewed parser and dashboard sources',()=>assert.equal(JSON.parse(readFileSync(new URL('../inventory_workspace_template.json',import.meta.url),'utf8')),generateInventoryWorkspaceTemplate()));

test('generated workspace document cannot be fetched through the public static alias',async()=>{const app=express();app.use(blockInventoryWorkspaceTemplate);app.use((_req,res)=>res.send('public asset'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{for(const p of ['/server/inventory_workspace_template.json','/server/%69nventory_workspace_template.json','/server%2Finventory_workspace_template.json'])assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${p}`)).status,404);assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/ordinary.css`)).status,200);}finally{await new Promise(r=>server.close(r));}});
