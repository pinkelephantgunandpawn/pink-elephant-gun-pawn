import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function ensureBootstrapAdmin(){'),source.indexOf("if (!process.env.DATABASE_URL"));
async function bootstrap(existing){let row=existing?{...existing}:null;let calls=0;const context=vm.createContext({process:{env:{ADMIN_EMAIL:'test@example.invalid',ADMIN_PASSWORD:'synthetic-bootstrap-password'}},bcrypt:{hash:async()=> 'synthetic-new-hash'},pool:{query:async(sql)=>{calls++;if(/ON CONFLICT\(email\) DO UPDATE/i.test(sql)){row={password_hash:'synthetic-new-hash',role:'admin',active:true};}else if(!row)row={password_hash:'synthetic-new-hash',role:'admin',active:true};return {rows:[]};}}});await vm.runInContext(body+'\nensureBootstrapAdmin();',context);return {row,calls};}
test('startup preserves existing credentials, role and deactivated status',async()=>{const existing={password_hash:'synthetic-existing-hash',role:'manager',active:false};assert.deepEqual((await bootstrap(existing)).row,existing);});
test('bootstrap still creates an absent initial admin',async()=>{assert.deepEqual((await bootstrap(null)).row,{password_hash:'synthetic-new-hash',role:'admin',active:true});});
