import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {EventEmitter}from'node:events';
import {isNewRequest,parseFileSendRequest,findRequestedFiles}from'../lib/natural.js';
import {fileDeliveryRequested}from'../lib/files.js';import {Store}from'../lib/store.js';import {SessionController}from'../lib/sessions.js';
const route={peer:'owner',sender:'owner',context:'context'};
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-natural-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('natural file grammar covers user classifier phrasing and familiar word orders',()=>{
 const cases=[['发送一个xxxxx 文件给我','xxxxx'],['把报告.pdf发给我','报告.pdf'],['请把报告.pdf文件发给我','报告.pdf'],['给我发一下 测试报告.txt','测试报告.txt'],['发个README.md给我','README.md'],['发送一个报告.pdf给我确认一下','报告.pdf'],['帮我把报告.pdf发给我','报告.pdf'],['send me file report.pdf','report.pdf']];
 for(const [input,expected]of cases)assert.equal(parseFileSendRequest(input)?.selector,expected,input);
 assert(fileDeliveryRequested('发送一个xxxxx 文件给我'));assert(fileDeliveryRequested('把报告.pdf发给我'));
});
test('generation requests stay tasks and new一下 becomes actual new command',()=>{
 for(const text of ['生成报告.pdf再发给我','修改这个文件然后发给我','打包项目并发给我'])assert.equal(parseFileSendRequest(text),null);
 for(const text of ['new','new一下','new 一下','新建一个会话','请新建一个对话'])assert(isNewRequest(text));
 assert(!isNewRequest('讨论new关键字'));assert(!isNewRequest('new项目怎么设计'));
});
test('file matching favors exact workspace path, supports stems, and exposes ambiguity',t=>{
 const root=setup(t);fs.mkdirSync(path.join(root,'out'));fs.writeFileSync(path.join(root,'out','报告.pdf'),'x');
 assert.deepEqual(findRequestedFiles(root,'报告.pdf').matches,['out/报告.pdf']);assert.equal(findRequestedFiles(root,'报告').exact,true);
 fs.mkdirSync(path.join(root,'other'));fs.writeFileSync(path.join(root,'other','报告.docx'),'y');assert.equal(findRequestedFiles(root,'报告').matches.length,2);
 fs.writeFileSync(path.join(root,'报告.pdf'),'ROOT');assert.deepEqual(findRequestedFiles(root,'报告.pdf').matches,['报告.pdf']);
});
test('file lookup does not traverse outside or follow symlinks/hidden directories',t=>{
 const root=setup(t);assert.throws(()=>findRequestedFiles(root,'../outside.txt'),/工作目录/);assert.throws(()=>findRequestedFiles(root,'.env'),/隐藏/);
 fs.mkdirSync(path.join(root,'.private'));fs.writeFileSync(path.join(root,'.private','报告.pdf'),'hidden');
 fs.symlinkSync(path.join(root,'.private'),path.join(root,'visible-link'));assert.equal(findRequestedFiles(root,'报告.pdf').matches.length,0);
});
test('bounded search marks truncation rather than claiming uniqueness',t=>{
 const root=setup(t);for(let i=0;i<10;i++)fs.writeFileSync(path.join(root,`${i}-报告.pdf`),'x');
 const found=findRequestedFiles(root,'报告',{maxEntries:3});assert(found.truncated);
});
test('all natural file requests pass unchanged to Codex instead of channel-side filename guessing',async t=>{
 const root=setup(t);const c=new SessionController({store:new Store(path.join(root,'state')),config:{},backends:new Map()});t.after(()=>c.close());
 const received=[];c.submit=async(r,text)=>{received.push(text);return '';};
 for(const text of ['发送一个报告.pdf 文件给我','把报告发给我','发第一份 优化指南','生成报告然后发我']){assert.equal(await c.dispatch(text,route),'');assert.equal(received.at(-1),text);}
});
test('new persists default name and first task skips redundant resume of own subscription',async t=>{
 const root=setup(t);const client=new EventEmitter();let resumes=0;let runs=0;let named=false;
 client.request=async(method,p)=>{if(method==='thread/start')return{thread:{id:'empty',cwd:root,status:{type:'idle'}}};if(method==='thread/name/set'){named=true;return{};}if(method==='thread/loaded/list')return{data:['empty']};if(method==='thread/read')return{thread:{id:'empty',cwd:root,status:{type:'idle'}}};if(method==='thread/resume'){resumes++;throw new Error('no rollout');}throw new Error(method);};
 client.run=async(id,text,o)=>{runs++;o.onStarted('turn');return'OK';};
 const c=new SessionController({store:new Store(path.join(root,'state')),config:{workspace:root,sandbox:'read-only'},backends:new Map([['local',{client}]])});t.after(()=>c.close());
 await c.dispatch('new一下',route);assert(named);await c.dispatch('你好',route);await Promise.all([...c.background]);assert.equal(runs,1);assert.equal(resumes,0);
});
test('only explicitly selected loaded idle empty persistent threads may get rollout repair',async t=>{
 const root=setup(t);const client=new EventEmitter();let resumed=0;let named=0;
 client.request=async(method,p)=>{if(method==='thread/loaded/list')return{data:['empty']};if(method==='thread/read')return{thread:{id:'empty',cwd:root,originator:'codex-tui',name:null,preview:'',ephemeral:false,status:{type:'idle'}}};if(method==='thread/name/set'){named++;return{};}if(method==='thread/resume'){if(++resumed===1){const e=new Error('no rollout');e.rpcCategory='noRollout';throw e;}return{thread:{id:'empty',cwd:root,status:{type:'idle'}}};}throw new Error(method);};
 const c=new SessionController({store:new Store(path.join(root,'state')),config:{},backends:new Map([['local',{client}]])});t.after(()=>c.close());c.peer(route).selected={backend:'local',threadId:'empty',cwd:root,live:true};
 await c.attach(route);assert.equal(named,1);assert.equal(resumed,2);
});
