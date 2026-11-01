import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createDecipheriv, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../lib/store.js';
import { FileSpool, readWorkspaceFile, fileDirectives, fileDeliveryRequested, MAX_FILE_BYTES } from '../lib/files.js';
import { WeixinClient, safeCdnUrl } from '../lib/weixin.js';
import { Bridge } from '../lib/bridge.js';
import { SessionController } from '../lib/sessions.js';

function setup(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-files-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 const store=new Store(path.join(root,'state'));
 return {root,workspace,store};
}
async function serve(t, handler) {
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return `http://127.0.0.1:${server.address().port}`;
}
const route={peer:'owner-peer',sender:'owner',context:'context'};

test('workspace exports support Unicode and spaces, and reject traversal, hidden files and credentials',t=>{
 const x=setup(t);fs.writeFileSync(path.join(x.workspace,'确认 文档.txt'),'content');
 assert.equal(readWorkspaceFile(x.workspace,'确认 文档.txt').data.toString(),'content');
 fs.writeFileSync(path.join(x.root,'outside.txt'),'secret');
 for(const file of ['../outside.txt','/etc/passwd','.env','sub/.git/config','auth.json','private.key','folder']){
  assert.throws(()=>readWorkspaceFile(x.workspace,file));
 }
});
test('exports reject symlinks, hard links, directories and oversized files',t=>{
 const x=setup(t);const original=path.join(x.workspace,'original.txt');fs.writeFileSync(original,'data');
 fs.symlinkSync(original,path.join(x.workspace,'link.txt'));assert.throws(()=>readWorkspaceFile(x.workspace,'link.txt'),/符号链接/);
 fs.linkSync(original,path.join(x.workspace,'hard.txt'));assert.throws(()=>readWorkspaceFile(x.workspace,'hard.txt'),/硬链接/);
 fs.mkdirSync(path.join(x.workspace,'folder'));assert.throws(()=>readWorkspaceFile(x.workspace,'folder'),/普通文件/);
 const big=path.join(x.workspace,'large.bin');fs.writeFileSync(big,'');fs.truncateSync(big,MAX_FILE_BYTES+1);assert.throws(()=>readWorkspaceFile(x.workspace,'large.bin'),/上限/);
});
test('private spool snapshots exact bytes and detects tampering instead of rereading original',t=>{
 const x=setup(t);const file=path.join(x.workspace,'result.txt');fs.writeFileSync(file,'version1');
 const spool=new FileSpool(x.store.root);const item=spool.snapshot(x.workspace,'result.txt');
 fs.writeFileSync(file,'version2');assert.equal(spool.read(item).toString(),'version1');
 assert.equal(fs.statSync(spool.file(item.spoolId)).mode&0o777,0o600);
 fs.writeFileSync(spool.file(item.spoolId),'tampered');assert.throws(()=>spool.read(item),/校验失败/);
 assert.throws(()=>spool.file('../outside'),/编号/);
});
test('attachment directives are bounded and do not silently grant delivery consent',()=>{
 const r=fileDirectives('完成\n[[weixin-file:报告.pdf]]\n[[weixin-file:报告.pdf]]');
 assert.equal(r.text,'完成');assert.deepEqual(r.files,['报告.pdf']);
 assert.equal(fileDeliveryRequested('生成文档，作为附件发给我确认'),true);
 assert.equal(fileDeliveryRequested('审查 file.json'),false);
 assert(fileDirectives(Array.from({length:20},(_,i)=>`[[weixin-file:${i}.txt]]`).join('\n')).files.length<=5);
});
test('CDN URL policy rejects credential leaks, plaintext external hosts and lookalikes',()=>{
 for(const bad of ['https://novac2c.cdn.weixin.qq.com.evil.test/upload','http://novac2c.cdn.weixin.qq.com/upload','https://user:secret@novac2c.cdn.weixin.qq.com/upload','https://evil.test/upload','not a url'])assert.throws(()=>safeCdnUrl(bad));
 assert.match(safeCdnUrl('https://novac2c.cdn.weixin.qq.com/c2c/upload?param=x'),/^https:/);
});
test('real upload encrypts AES128ECB/PKCS7, uses protocol lengths/MD5, and never forwards bot auth to CDN',async t=>{
 const data=Buffer.from('文件内容 😀');const keys={filekey:'a'.repeat(32),aeskey:'b'.repeat(32)};
 let grant;let encrypted;let message;let cdnAuthorization;
 const base=await serve(t,async(req,res)=>{
  const body=[];for await(const b of req)body.push(b);const raw=Buffer.concat(body);
  if(req.url.includes('getuploadurl')){grant=JSON.parse(raw);assert.equal(req.headers.authorization,'Bearer dummy');res.end(JSON.stringify({ret:0,upload_full_url:`${base}/cdn/upload`}));}
  else if(req.url==='/cdn/upload'){encrypted=raw;cdnAuthorization=req.headers.authorization;res.setHeader('x-encrypted-param','download-param');res.end('');}
  else {message=JSON.parse(raw);res.end('{"ret":0}');}
 });
 const client=new WeixinClient({baseUrl:base,token:'dummy',allowLocal:true});
 const media=await client.uploadFile('owner',data,keys);
 assert.equal(grant.media_type,3);assert.equal(grant.rawsize,data.length);assert.equal(grant.filesize,encrypted.length);assert.equal(grant.rawfilemd5,createHash('md5').update(data).digest('hex'));
 const decipher=createDecipheriv('aes-128-ecb',Buffer.from(keys.aeskey,'hex'),null);assert.deepEqual(Buffer.concat([decipher.update(encrypted),decipher.final()]),data);
 assert.equal(cdnAuthorization,undefined);assert.notDeepEqual(encrypted,data);assert.equal(Buffer.from(media.aes_key,'base64').toString(),keys.aeskey);
 await client.sendFile('owner','context',{fileName:'报告.txt',size:data.length,media},'stable-file-id');
 assert.equal(message.msg.item_list[0].type,4);assert.equal(message.msg.item_list[0].file_item.len,String(data.length));assert.equal(message.msg.client_id,'stable-file-id');assert.equal(message.msg.context_token,'context');
});
test('upload target validation occurs before fetching untrusted URL',async t=>{
 const base=await serve(t,async(req,res)=>{for await(const b of req){}res.end('{"upload_full_url":"https://evil.test/upload"}');});
 const client=new WeixinClient({baseUrl:base,allowLocal:true});
 await assert.rejects(client.uploadFile('owner',Buffer.from('data'),{filekey:'a'.repeat(32),aeskey:'b'.repeat(32)}),e=>e.permanent===true&&/Untrusted/.test(e.message));
});
test('file outbox reuses uploaded metadata/client_id after send failure, then clears snapshot',async t=>{
 const x=setup(t);fs.writeFileSync(path.join(x.workspace,'delivery.txt'),'ORIGINAL');let uploads=0;let sends=0;const ids=[];
 const base=await serve(t,async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);const raw=Buffer.concat(chunks);
  if(req.url.includes('getuploadurl')){uploads++;res.end(JSON.stringify({ret:0,upload_full_url:`${base}/cdn/upload`}));}
  else if(req.url==='/cdn/upload'){res.setHeader('x-encrypted-param','file-reference');res.end('');}
  else {const body=JSON.parse(raw);if(body.msg.item_list[0].type===4){ids.push(body.msg.client_id);if(++sends===1){res.writeHead(500);res.end('failure');return;}}res.end('{"ret":0}');}
 });
 const make=()=>new Bridge({store:x.store,config:{allowUsers:['owner']},account:{botId:'bot'},weixin:new WeixinClient({baseUrl:base,allowLocal:true})});
 const first=make();first.queueReply(route,{type:'file',cwd:x.workspace,path:'delivery.txt'});
 await assert.rejects(first.flushOutbox(),e=>e.status===500);
 fs.writeFileSync(path.join(x.workspace,'delivery.txt'),'MODIFIED AFTER QUEUING');
 const second=make();await second.flushOutbox();assert.equal(uploads,1);assert.equal(ids[0],ids[1]);
 assert.equal(fs.readdirSync(path.join(x.store.root,'outbox-files')).length,0);
 const persisted=JSON.stringify(x.store.read('state'));assert(!persisted.includes('aes_key'));assert(!persisted.includes('context'));
});
test('permanent file failure is reported once without blocking later messages',async t=>{
 const x=setup(t);fs.writeFileSync(path.join(x.workspace,'delivery.txt'),'content');const texts=[];
 const bridge=new Bridge({store:x.store,config:{},account:{botId:'bot'},weixin:{send:async(to,ctx,text)=>texts.push(text),uploadFile:async()=>{const error=new Error('bad grant');error.permanent=true;throw error;}}});
 bridge.queueReply(route,{type:'file',cwd:x.workspace,path:'delivery.txt'});bridge.queueReply(route,'NEXT_MESSAGE');await bridge.flushOutbox();
 assert(texts.some(x=>x.includes('未确认发送成功')));assert(texts.includes('NEXT_MESSAGE'));assert.equal(fs.readdirSync(bridge.spool.root).length,0);
});
test('slow attachment upload does not block inbound controller commands',async t=>{
 const x=setup(t);fs.writeFileSync(path.join(x.workspace,'delivery.txt'),'content');let finishUpload;
 const bridge=new Bridge({store:x.store,config:{allowUsers:['owner']},account:{botId:'bot'},controller:{dispatch:async()=> 'STATUS_ACK'},weixin:{
  send:async()=>{},sendFile:async()=>{},uploadFile:()=>new Promise(resolve=>{finishUpload=resolve;}),
  updates:async()=>({msgs:[{message_id:1,message_type:1,from_user_id:'owner',context_token:'context',item_list:[{type:1,text_item:{text:'/status'}}]}],get_updates_buf:'next'})
 }});
 bridge.queueReply(route,{type:'file',cwd:x.workspace,path:'delivery.txt'});const pending=bridge.flushOutbox();await delay(10);
 await Promise.race([bridge.pollOnce(),delay(200).then(()=>{throw new Error('inbound blocked by upload');})]);
 finishUpload({encrypt_query_param:'x',aes_key:'x',encrypt_type:1});await pending;await bridge.flushOutbox();
 assert.equal(x.store.read('state').cursor,'next');
});
test('new and /new immediately create independent sessions in configured Codex default workspace',async t=>{
 const x=setup(t);const calls=[];let next=0;const client=new EventEmitter();client.request=async(method,params)=>{calls.push({method,params});if(method==='thread/name/set')return{};if(method!=='thread/start')throw new Error(method);return {thread:{id:`fresh-${++next}`,cwd:params.cwd}};};
 const controller=new SessionController({store:x.store,config:{workspace:'/old/bridge',sandbox:'read-only',newSessionWorkspace:x.workspace},backends:new Map([['local',{client}]])});t.after(()=>controller.close());
 await controller.dispatch('new',route);const first=controller.peer(route).selected.threadId;
 await controller.dispatch('/new',route);const second=controller.peer(route).selected.threadId;
 assert.notEqual(first,second);assert.equal(calls.filter(c=>c.method==='thread/start').length,2);assert(calls.filter(c=>c.method==='thread/start').every(c=>c.params.cwd===x.workspace));assert.equal(calls.filter(c=>c.method==='thread/name/set').length,2);assert.equal(controller.peer(route).selected.backend,'local');
});
test('legacy attachment text markers never invoke transport; only actual tool calls may send',async t=>{
 const x=setup(t);const published=[];
 const client=new EventEmitter();client.request=async(method)=>method==='thread/loaded/list'?{data:['thread']}:{thread:{id:'thread',cwd:x.workspace,status:{type:'idle'}}};
 client.run=async(id,text,options)=>{options.onStarted('turn');return '完成\n[[weixin-file:报告.txt]]';};
 const controller=new SessionController({store:x.store,config:{workspace:x.workspace,sandbox:'read-only'},backends:new Map([['local',{client}]]),publish:async(r,text)=>{published.push(text);return {fileName:'报告.txt'};}});t.after(()=>controller.close());
 await controller.dispatch('/use local:thread',route);await controller.dispatch('生成文档并发给我确认',route);await Promise.all([...controller.background]);
 assert(!published.some(x=>x&&typeof x==='object'&&x.type==='file'));
 published.length=0;await controller.dispatch('只给建议',route);await Promise.all([...controller.background]);assert(!published.some(x=>typeof x==='object'));
});
test('remote backend paths are not interpreted as local files',async t=>{
 const x=setup(t);const client=new EventEmitter();client.endpoint='wss://remote.example';
 const controller=new SessionController({store:x.store,config:{},backends:new Map([['remote',{client}]])});t.after(()=>controller.close());
 controller.peer(route).selected={backend:'remote',threadId:'t',cwd:x.workspace};
 await assert.rejects(controller.dispatch('/send local.txt',route),/远端文件/);
});
