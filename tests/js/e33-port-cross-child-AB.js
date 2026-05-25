// Item 2 FULL (e33): cross-child direct routing — B → A via origin.
// Parent spawns A and B. A creates channel, transfers port1 to parent.
// Parent re-transfers stub to B (recording __edgeForwardedTo=B).
// B does stub.postMessage('B-hi') — routes DIRECTLY to A via
// __edgePostMessageToWorker(A, ...) using originWorkerId carried in
// the wire-format PORT_REF.  A receives, port2.on('message') fires.
// A reports to parent via __edgePostMessageFromWorker.
require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }
if (!globalThis.__edgeSpawnNodeWorker || !globalThis.__edgeMakePortStub) {
  console.log('FAIL: prereq'); process.exit(1);
}

const H = `
globalThis.__edgePortSiblingMap=globalThis.__edgePortSiblingMap||new WeakMap();
globalThis.__edgePortsByGlobalId=globalThis.__edgePortsByGlobalId||new Map();
globalThis.__edgePortStubsByGlobalId=globalThis.__edgePortStubsByGlobalId||new Map();
globalThis.__edgePortIdNext=globalThis.__edgePortIdNext||1;
function N(p){if(p.__edgeNeutered)return;try{Object.defineProperty(p,'__edgeNeutered',{value:true})}catch(e){}var t=function(){throw new Error('x')};try{p.postMessage=t}catch(e){}}
function R(s,id){if(s.__edgeSiblingRewired)return;try{Object.defineProperty(s,'__edgeSiblingRewired',{value:true})}catch(e){}s.postMessage=function(p){var e={__edgePortMsg:true,targetPortId:id,payload:p};globalThis.__edgePostMessageFromWorker(globalThis.__edgePackPostMessage(e))}}
globalThis.__edgeAllocPortIdChild=function(p,d){if(p.__edgePortStub===true){var x=p.__edgeGlobalPortId;if(!p.__edgeNeutered)N(p);if(typeof d==='number')try{p.__edgeForwardedTo=d}catch(e){}return x}var id=globalThis.__edgePortIdNext++;globalThis.__edgePortsByGlobalId.set(id,{port:p,deliver:p.postMessage.bind(p)});N(p);var b=globalThis.__edgePortSiblingMap.get(p);if(b)R(b,id);return id};
globalThis.__edgeMakePortStubChild=function(id,ow){var L={message:[]};var s={on:function(e,c){(L[e]=L[e]||[]).push(c);return s},emit:function(e){var a=[].slice.call(arguments,1);var l=L[e]||[];for(var i=0;i<l.length;i++){try{l[i].apply(null,a)}catch(_){}}return l.length>0},postMessage:function(p){var e={__edgePortMsg:true,targetPortId:id,payload:p};var b=globalThis.__edgePackPostMessage(e);var our=globalThis.__edgeHostWorkerId;if(typeof ow==='number'&&ow!==0&&ow!==our&&typeof globalThis.__edgePostMessageToWorker==='function'){globalThis.__edgePostMessageToWorker(ow,b)}else{globalThis.__edgePostMessageFromWorker(b)}},start:function(){},close:function(){},ref:function(){return s},unref:function(){return s},hasRef:function(){return true}};Object.defineProperty(s,'__edgePortStub',{value:true});Object.defineProperty(s,'__edgeGlobalPortId',{value:id});if(ow!==undefined)try{Object.defineProperty(s,'__edgeOriginWorkerId',{value:ow})}catch(e){}globalThis.__edgePortStubsByGlobalId.set(id,s);return s};
var __wt=require('worker_threads');if(!__wt.MessageChannel.__edgeWrapped){var __M=__wt.MessageChannel;var __sm=globalThis.__edgePortSiblingMap;var __E=function(){var c=new __M();__sm.set(c.port1,c.port2);__sm.set(c.port2,c.port1);return c};__E.prototype=__M.prototype;Object.defineProperty(__E,'__edgeWrapped',{value:true});__wt.MessageChannel=__E}
globalThis.__edgeDispatchMessageToChild=function(b){var d=globalThis.__edgeUnpackPostMessage(b,function(p,o){var x=globalThis.__edgePortStubsByGlobalId.get(p);return x||globalThis.__edgeMakePortStubChild(p,o)});if(d&&d.__edgePortMsg===true){var en=globalThis.__edgePortsByGlobalId.get(d.targetPortId);if(en){try{en.deliver(d.payload)}catch(e){}return}var st=globalThis.__edgePortStubsByGlobalId.get(d.targetPortId);if(st&&typeof st.__edgeForwardedTo==='number'){var fb=globalThis.__edgePackPostMessage({__edgePortMsg:true,targetPortId:d.targetPortId,payload:d.payload});globalThis.__edgePostMessageToWorker(st.__edgeForwardedTo,fb);return}if(st)st.emit('message',d.payload);return}return d};
`;

const childA = `${H}
var k=setInterval(function(){},100);
setTimeout(function(){
  var wt=require('worker_threads');
  var ch=new wt.MessageChannel();
  ch.port2.on('message',function(m){
    var rb=globalThis.__edgePackPostMessage({kind:'A-got',msg:m});
    globalThis.__edgePostMessageFromWorker(rb);
  });
  var id=globalThis.__edgeAllocPortIdChild(ch.port1);
  var aId=function(o){return o===ch.port1?{id:id,originWorkerId:globalThis.__edgeHostWorkerId}:null};
  var b=globalThis.__edgePackPostMessage({kind:'fromA',port:ch.port1},[ch.port1],aId);
  globalThis.__edgePostMessageFromWorker(b);
},200);
setTimeout(function(){clearInterval(k);process.exit(0)},5000);
`;

const childB = `${H}
var k=setInterval(function(){},100);
var orig=globalThis.__edgeDispatchMessageToChild;
globalThis.__edgeDispatchMessageToChild=function(b){
  var d=orig(b);
  if(d&&d.kind==='givePort'&&d.s){
    d.s.postMessage('B-hi');
    clearInterval(k);
    setTimeout(function(){process.exit(0)},800);
  }
};
setTimeout(function(){clearInterval(k);process.exit(1)},5000);
`;

const wA = globalThis.__edgeSpawnNodeWorker(childA);
const wB = globalThis.__edgeSpawnNodeWorker(childB);

let stubA = null, aGot = null, exitA = null, exitB = null;
globalThis.__edgeDispatchUserWorkerExit = (w, c) => {
  if (w === wA) exitA = c; else if (w === wB) exitB = c;
};

globalThis.__edgeDispatchMessageFromChild = (wid, bytes) => {
  void wid;
  const data = globalThis.__edgeUnpackPostMessage(bytes, (pid, owid) => {
    const ex = globalThis.__edgePortStubsByGlobalId.get(pid);
    return ex || globalThis.__edgeMakePortStub(pid, owid);
  });
  if (data && data.__edgePortMsg === true) {
    const entry = globalThis.__edgePortsByGlobalId.get(data.targetPortId);
    if (entry) { try { entry.deliver(data.payload); } catch (e) { void e; } return; }
    const stub = globalThis.__edgePortStubsByGlobalId.get(data.targetPortId);
    if (stub && typeof stub.__edgeForwardedTo === 'number') {
      const fb = globalThis.__edgePackPostMessage({
        __edgePortMsg: true, targetPortId: data.targetPortId, payload: data.payload,
      });
      globalThis.__edgePostMessageToWorker(stub.__edgeForwardedTo, fb);
      return;
    }
    if (stub) stub.emit('message', data.payload);
    return;
  }
  if (data && data.kind === 'fromA' && data.port) {
    stubA = data.port;
    setTimeout(() => {
      globalThis.__edgeAllocPortId(stubA, wB);
      const aId = (o) => o === stubA ? {
        id: stubA.__edgeGlobalPortId, originWorkerId: stubA.__edgeOriginWorkerId,
      } : null;
      const b = globalThis.__edgePackPostMessage(
        { kind: 'givePort', s: stubA }, [stubA], aId);
      globalThis.__edgePostMessageToWorker(wB, b);
    }, 100);
  }
  if (data && data.kind === 'A-got') aGot = data.msg;
};

const startMs = Date.now();
const poll = () => {
  if (aGot !== null && exitA !== null && exitB !== null) {
    ok('stub_to_parent', stubA !== null);
    ok('origin_is_A', stubA && stubA.__edgeOriginWorkerId === wA);
    ok('forwardedTo_B', stubA && stubA.__edgeForwardedTo === wB);
    ok('A_received_B_via_direct', aGot === 'B-hi');
    ok('A_exit_0', exitA === 0);
    ok('B_exit_0', exitB === 0);
    process.exit(0);
  } else if (Date.now() - startMs > 8000) {
    console.log('TIMEOUT stub=' + (stubA != null) + ' aGot=' + JSON.stringify(aGot) + ' eA=' + exitA + ' eB=' + exitB);
    process.exit(2);
  } else { setTimeout(poll, 100); }
};
setTimeout(poll, 1500);
