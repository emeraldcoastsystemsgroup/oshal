/** CHANGE LOG: 1 | maintainer@emeraldcoastsystemsgroup.com | Verify native desktop credential binding, heartbeat acknowledgment, refused transport and session separation using an owned HTTP fixture. */
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {NativeNodeClient,readNativeCredentials}=require('../dist/main/native-node-client');
const {randomUUID}=require('node:crypto');
const fixtureToken=randomUUID();
const id='22222222-2222-2222-2222-222222222222';
async function fixture(callback){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oshal-native-client-'));
 const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`,file=path.join(dir,'node.json');
 fs.writeFileSync(file,JSON.stringify({node_id:id,base_url:origin,token:fixtureToken}),{mode:0o600});
 try{await callback({server,origin,file,dir});}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
}
test('private native credential is origin-bound and never reused as a browser session',()=>fixture(async({server,origin,file})=>{
 let count=0;server.on('request',(req,res)=>{count++;assert.equal(req.url,`/nodes/${id}/heartbeat`);assert.equal(req.headers.authorization,'Bearer '+fixtureToken);res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',node:id}));});
 const events=[],client=new NativeNodeClient(file,origin,s=>events.push(s));
 await client.start();assert.equal(events.at(-1).connected,true);assert.equal(events.at(-1).clientId,id);
 await assert.rejects(client.sendChat('hello'),/portal/);assert.equal(count,1);
 await client.stop();assert.equal(events.at(-1).connected,false);
 assert.ok(!JSON.stringify(events).includes(fixtureToken));
}));
test('refused heartbeat never reports connected and never calls legacy registration',()=>fixture(async({server,origin,file})=>{
 server.on('request',(req,res)=>{assert.equal(req.url,`/nodes/${id}/heartbeat`);res.writeHead(401);res.end();});
 const events=[],client=new NativeNodeClient(file,origin,s=>events.push(s));
 await assert.rejects(client.start(),/heartbeat failed/);assert.ok(events.every(e=>!e.connected));await client.stop();
}));
test('wrong origin, public permissions and symlinks refuse before transmitting a credential',()=>fixture(async({origin,file,dir})=>{
 assert.throws(()=>readNativeCredentials(file,'https://different.example'),/match/);
 const link=path.join(dir,'link');fs.symlinkSync(file,link);assert.throws(()=>readNativeCredentials(link,origin),/private/);
 fs.chmodSync(file,0o644);assert.throws(()=>readNativeCredentials(file,origin),/private/);
}));
test('redirects cannot forward a device credential to another origin',()=>fixture(async({server,origin,file})=>{
 server.on('request',(_req,res)=>{res.writeHead(307,{Location:'http://127.0.0.1:9/should-never-receive'});res.end();});
 const client=new NativeNodeClient(file,origin,()=>{});await assert.rejects(client.start(),/heartbeat failed/);await client.stop();
}));
