import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as engine from '../src/engine/target-registry.ts';
const target = {user:'root',host:'203.0.113.10',port:22};
const old = {machineIdHash:'a'.repeat(64),machineIdMtime:'2026-09-01T00:00:00.000Z'};
const fresh = {machineIdHash:'b'.repeat(64),machineIdMtime:'2026-09-08T00:00:01.000Z'};
async function fixture(t) {
 const home=await mkdtemp(join(tmpdir(),'registry-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const path=engine.stackOwnershipRegistryPath(target,home);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify({n8n:'previous',extra:'other'}));
 await mkdir(join(home,'carlos'));await writeFile(join(home,'carlos','secrets.json'),'private-control');
 const request={schemaVersion:1,cycleId:'cycle-1',entornoId:'env-1',instanceId:'123',target};
 let observation={...old,ip:target.host,services:[],containers:[],volumes:[],dockerPresent:false,dataDirectoriesAbsent:true};
 const options={home,observe:async()=>observation};
 const snapshot=await engine.snapshotTarget(request,options);
 observation={...observation,...fresh};
 const receipt={...request,...fresh,reinstalledAt:'2026-09-08T00:00:00.000Z'};
 return {home,path,request,snapshot,receipt,options,set:v=>Object.assign(observation,v),input:()=>({...request,snapshot,receipt})};
}
test('archive exact complete registry and preserve secrets; replay stable',async t=>{const f=await fixture(t);const before=await readFile(f.path);const r=await engine.reconcileTarget(f.input(),f.options);assert.equal(r.sourceHash,r.archiveHash);assert.deepEqual(await readFile(join(dirname(f.path),'cycles','cycle-1','archive.json')),before);await assert.rejects(access(f.path));assert.equal(await readFile(join(f.home,'carlos','secrets.json'),'utf8'),'private-control');assert.deepEqual(await engine.reconcileTarget(f.input(),f.options),r);});
for(const [name,change] of Object.entries({sameGeneration:f=>f.set(old),ip:f=>f.set({ip:'203.0.113.11'}),services:f=>f.set({services:['s']}),containers:f=>f.set({containers:['c']}),volumes:f=>f.set({volumes:['v']}),data:f=>f.set({dataDirectoriesAbsent:false}),instance:f=>f.receipt.instanceId='456',cycle:f=>f.receipt.cycleId='other',time:f=>f.receipt.reinstalledAt=fresh.machineIdMtime}))test(`reject ${name} without touching registry`,async t=>{const f=await fixture(t);const before=await readFile(f.path);change(f);await assert.rejects(engine.reconcileTarget(f.input(),f.options));assert.deepEqual(await readFile(f.path),before);});
test('CAS rejects changed registry',async t=>{const f=await fixture(t);await writeFile(f.path,'{"n8n":"new"}');await assert.rejects(engine.reconcileTarget(f.input(),f.options),/CAS/);assert.equal(await readFile(f.path,'utf8'),'{"n8n":"new"}');});
for(const mode of ['corrupt','symlink'])test(`snapshot rejects ${mode}`,async t=>{const f=await fixture(t);if(mode==='corrupt')await writeFile(f.path,'{');else{await rm(f.path);await symlink(join(f.home,'carlos','secrets.json'),f.path);}await assert.rejects(engine.snapshotTarget({...f.request,cycleId:'cycle-2'},f.options));});
test('replay refuses newly registered owner',async t=>{const f=await fixture(t);await engine.reconcileTarget(f.input(),f.options);await writeFile(f.path,'{"n8n":"new"}');await assert.rejects(engine.reconcileTarget(f.input(),f.options));assert.equal(await readFile(f.path,'utf8'),'{"n8n":"new"}');});
test('shared lock excludes apply while observation is suspended',async t=>{const f=await fixture(t);let release;let entered;const gate=new Promise(r=>release=r);const ready=new Promise(r=>entered=r);const running=engine.reconcileTarget(f.input(),{...f.options,observe:async()=>{entered();await gate;return {...fresh,ip:target.host,services:[],containers:[],volumes:[],dockerPresent:false,dataDirectoriesAbsent:true};}});await ready;await assert.rejects(engine.withTargetLock(target,async()=>assert.fail('loser ran'),f.home),/lock/);release();await running;});
test('journal recovers crash after archive rename',async t=>{const f=await fixture(t);await assert.rejects(engine.reconcileTarget(f.input(),{...f.options,afterArchive:()=>{throw Error('crash');}}),/crash/);const r=await engine.reconcileTarget(f.input(),f.options);assert.equal(r.sourceHash,r.archiveHash);});
