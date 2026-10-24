import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {z} from 'zod';

const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('const roles ='),source.indexOf('\nfunction regulatedCategory'));
const secret='synthetic-test-only-session-signing-key';
const password='synthetic-test-only-password';
const hash=await bcrypt.hash(password,4);
function response(){return {statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};}
function harness(account){
  const routes=new Map(),queries=[];
  const context=vm.createContext({bcrypt,jwt,z,process:{env:{JWT_SECRET:secret}},loginLimit:()=>{},console,
    app:{get:(p,...f)=>routes.set('GET '+p,f.at(-1)),post:(p,...f)=>routes.set('POST '+p,f.at(-1))},
    pool:{query:async(sql,params)=>{queries.push({sql,params});if(sql.startsWith('SELECT id,email,password_hash'))return {rows:account?[account]:[]};if(sql.startsWith('INSERT INTO audit_log'))return {rows:[]};throw Error('Unexpected query');}}});
  vm.runInContext(block+'\nglobalThis.handlers={auth,requireRole,sign};',context);
  return {routes,queries,...context.handlers};
}
function user(extra={}){return {id:'synthetic-admin-id',email:'admin@example.invalid',password_hash:hash,role:'admin',active:true,...extra};}
async function login(h,body={email:'admin@example.invalid',password}){const res=response();await h.routes.get('POST /api/auth/login')({body,ip:'127.0.0.1'},res);return res;}
test('actual admin login preserves password and role, signs an eight-hour issuer-bound session and audits login',async()=>{
 const account=user(),before={...account},h=harness(account),res=await login(h);
 assert.equal(res.statusCode,200);const claims=jwt.verify(res.body.token,secret,{issuer:'pink-elephant-api'});
 assert.equal(claims.sub,account.id);assert.equal(claims.role,'admin');assert.equal(claims.exp-claims.iat,28800);
 assert.deepEqual(account,before);assert.equal(h.queries.length,2);assert.match(h.queries[1].sql,/^INSERT INTO audit_log/);
 assert.doesNotMatch(JSON.stringify(res.body),/password_hash/);
});
test('disabled account cannot create a new session and performs no audit write',async()=>{const h=harness(user({active:false})),res=await login(h);assert.equal(res.statusCode,401);assert.equal(h.queries.length,1);});
test('wrong password and absent account return identical sanitized errors',async()=>{const wrong=await login(harness(user()),{email:'admin@example.invalid',password:'synthetic-wrong-password'}),missing=await login(harness(null));assert.equal(wrong.statusCode,401);assert.equal(JSON.stringify(wrong.body),JSON.stringify(missing.body));});
test('invalid login input does not query the database',async()=>{const h=harness(user()),res=await login(h,{email:'invalid',password:'short'});assert.equal(res.statusCode,400);assert.equal(h.queries.length,0);});
test('existing manager role is preserved and cannot authorize an admin-only route',async()=>{const h=harness(user({role:'manager'})),res=await login(h);assert.equal(res.body.user.role,'manager');const denied=response();h.requireRole('admin')({user:res.body.user},denied,()=>assert.fail('role escalation'));assert.equal(denied.statusCode,403);});
test('actual session middleware accepts issued sessions and rejects expired, invalid-issuer and missing tokens',()=>{
 const h=harness(user());for(const [token,valid] of [[h.sign(user()),true],[jwt.sign({sub:'test'},secret,{issuer:'other'}),false],[jwt.sign({sub:'test'},secret,{issuer:'pink-elephant-api',expiresIn:-1}),false],[null,false]]){const res=response();let next=0;h.auth({get:()=>token?'Bearer '+token:undefined},res,()=>next++);assert.equal(next,valid?1:0);if(!valid)assert.equal(res.statusCode,401);}
});
test('existing session validation is stateless and does not re-read disabled-account status',()=>{const h=harness(user({active:false})),res=response();let next=0;h.auth({get:()=> 'Bearer '+h.sign(user())},res,()=>next++);assert.equal(next,1);assert.equal(h.queries.length,0);});
