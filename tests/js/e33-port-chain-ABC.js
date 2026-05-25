// Item 3 (e33): chain A→B→C.
// A allocs port, ships to parent.  Parent re-ships to B.  B re-ships
// to C.  C sends via stub → routes DIRECT to A (originWorkerId=A
// carried through wire format).
// Forward chain (A's reply → C) traverses parent→B→C via
// __edgeForwardedTo hops at each level.
require('worker_threads');
function ok(l, c) { console.log(l + ':' + (c ? 'PASS' : 'FAIL')); }
if (!globalThis.__edgeSpawnNodeWorker || !globalThis.__edgeMakePortStub) {
  console.log('FAIL: prereq'); process.exit(1);
}

// Maximum compaction — single-letter vars, shorthand globals.
const H = `
var G=globalThis;
G.__edgePortSiblingMap=G.__edgePortSiblingMap||new WeakMap();
G.__edgePortsByGlobalId=G.__edgePortsByGlobalId||new Map();
G.__edgePortStubsByGlobalId=G.__edgePortStubsByGlobalId||new Map();
G.__edgePortIdNext=G.__edgePortIdNext||1;
function N(p){if(p.__edgeNeutered)return;Object.defineProperty(p,'__edgeNeutered',{value:true});p.postMessage=function(){throw new Error('x')}}
function R(s,id){if(s.__edgeSiblingRewired)return;Object.defineProperty(s,'__edgeSiblingRewired',{value:true});s.postMessage=function(p){G.__edgePostMessageFromWorker(G.__edgePackPostMessage({__edgePortMsg:true,targetPortId:id,payload:p}))}}
G.__edgeAllocPortIdChild=function(p,d){if(p.__edgePortStub){var x=p.__edgeGlobalPortId;if(!p.__edgeNeutered)N(p);if(typeof d==='number')p.__edgeForwardedTo=d;return x}var id=G.__edgePortIdNext++;G.__edgePortsByGlobalId.set(id,{port:p,deliver:p.postMessage.bind(p)});N(p);var b=G.__edgePortSiblingMap.get(p);if(b)R(b,id);return id};
G.__edgeMakePortStubChild=function(id,ow){var L=[];var s={on:function(e,c){if(e==='message')L.push(c);return s},emit:function(e){if(e!=='message')return false;var a=[].slice.call(arguments,1);for(var i=0;i<L.length;i++)try{L[i].apply(null,a)}catch(_){}return L.length>0},postMessage:function(p){var b=G.__edgePackPostMessage({__edgePortMsg:true,targetPortId:id,payload:p});var ou=G.__edgeHostWorkerId;if(typeof ow==='number'&&ow!==0&&ow!==ou&&typeof G.__edgePostMessageToWorker==='function')G.__edgePostMessageToWorker(ow,b);else G.__edgePostMessageFromWorker(b)},start:function(){},close:function(){},ref:function(){return s},unref:function(){return s},hasRef:function(){return true}};Object.defineProperty(s,'__edgePortStub',{value:true});Object.defineProperty(s,'__edgeGlobalPortId',{value:id});if(ow!==undefined)Object.defineProperty(s,'__edgeOriginWorkerId',{value:ow});G.__edgePortStubsByGlobalId.set(id,s);return s};
var __wt=require('worker_threads');if(!__wt.MessageChannel.__edgeWrapped){var __M=__wt.MessageChannel;var __E=function(){var c=new __M();G.__edgePortSiblingMap.set(c.port1,c.port2);G.__edgePortSiblingMap.set(c.port2,c.port1);return c};__E.prototype=__M.prototype;Object.defineProperty(__E,'__edgeWrapped',{value:true});__wt.MessageChannel=__E}
G.__edgeDispatchMessageToChild=function(b){var d=G.__edgeUnpackPostMessage(b,function(p,o){return G.__edgePortStubsByGlobalId.get(p)||G.__edgeMakePortStubChild(p,o)});if(d&&d.__edgePortMsg){var en=G.__edgePortsByGlobalId.get(d.targetPortId);if(en){try{en.deliver(d.payload)}catch(_){}return}var st=G.__edgePortStubsByGlobalId.get(d.targetPortId);if(st&&typeof st.__edgeForwardedTo==='number'){var fb=G.__edgePackPostMessage({__edgePortMsg:true,targetPortId:d.targetPortId,payload:d.payload});if(typeof G.__edgePostMessageToWorker==='function')G.__edgePostMessageToWorker(st.__edgeForwardedTo,fb);return}if(st)st.emit('message',d.payload);return}return d};
`;

const childA = `${H}
var k=setInterval(function(){},100);
setTimeout(function(){
  var wt=require('worker_threads');
  var ch=new wt.MessageChannel();
  ch.port2.on('message',function(m){
    globalThis.__edgePostMessageFromWorker(globalThis.__edgePackPostMessage({kind:'A-got',msg:m}));
  });
  var id=globalThis.__edgeAllocPortIdChild(ch.port1);
  var aId=function(o){return o===ch.port1?{id:id,originWorkerId:globalThis.__edgeHostWorkerId}:null};
  globalThis.__edgePostMessageFromWorker(globalThis.__edgePackPostMessage({kind:'fromA',port:ch.port1},[ch.port1],aId));
},200);
setTimeout(function(){clearInterval(k);process.exit(0)},6000);
`;

const childBC = `${H}
var k=setInterval(function(){},100);
var orig=globalThis.__edgeDispatchMessageToChild;
globalThis.__edgeDispatchMessageToChild=function(b){
  var d=orig(b);
  if(d&&d.kind==='hereStub'&&d.s){
    if(d.fwdTo){
      // I am B: re-transfer to C (workerId=d.fwdTo)
      globalThis.__edgeAllocPortIdChild(d.s,d.fwdTo);
      var aId=function(o){return o===d.s?{id:d.s.__edgeGlobalPortId,originWorkerId:d.s.__edgeOriginWorkerId}:null};
      globalThis.__edgePostMessageToWorker(d.fwdTo,globalThis.__edgePackPostMessage({kind:'hereStub',s:d.s},[d.s],aId));
      clearInterval(k);
      setTimeout(function(){process.exit(0)},800);
    } else {
      // I am C: use the stub
      d.s.postMessage('C-hi');
      clearInterval(k);
      setTimeout(function(){process.exit(0)},800);
    }
  }
};
setTimeout(function(){clearInterval(k);process.exit(1)},6000);
`;

const wA = globalThis.__edgeSpawnNodeWorker(childA);
const wC = globalThis.__edgeSpawnNodeWorker(childBC);
const wB = globalThis.__edgeSpawnNodeWorker(childBC);

let stubAtParent = null, aGot = null, exits = { [wA]: null, [wB]: null, [wC]: null };
globalThis.__edgeDispatchUserWorkerExit = (w, c) => { exits[w] = c; };

globalThis.__edgeDispatchMessageFromChild = (wid, bytes) => {
  void wid;
  const data = globalThis.__edgeUnpackPostMessage(bytes, (pid, owid) => {
    return globalThis.__edgePortStubsByGlobalId.get(pid) || globalThis.__edgeMakePortStub(pid, owid);
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
    stubAtParent = data.port;
    setTimeout(() => {
      // Parent → B: tell B to re-transfer to C (B's bootstrap re-transfers if fwdTo set)
      globalThis.__edgeAllocPortId(stubAtParent, wB);
      const aId = (o) => o === stubAtParent ? {
        id: stubAtParent.__edgeGlobalPortId, originWorkerId: stubAtParent.__edgeOriginWorkerId,
      } : null;
      const b = globalThis.__edgePackPostMessage(
        { kind: 'hereStub', s: stubAtParent, fwdTo: wC }, [stubAtParent], aId);
      globalThis.__edgePostMessageToWorker(wB, b);
    }, 100);
  }
  if (data && data.kind === 'A-got') aGot = data.msg;
};

const startMs = Date.now();
const poll = () => {
  if (aGot !== null && exits[wA] !== null && exits[wB] !== null && exits[wC] !== null) {
    ok('stub_at_parent', stubAtParent !== null);
    ok('origin_is_A', stubAtParent && stubAtParent.__edgeOriginWorkerId === wA);
    ok('parent_forwardedTo_B', stubAtParent && stubAtParent.__edgeForwardedTo === wB);
    ok('A_received_C_via_chain', aGot === 'C-hi');
    ok('A_exit_0', exits[wA] === 0);
    ok('B_exit_0', exits[wB] === 0);
    ok('C_exit_0', exits[wC] === 0);
    process.exit(0);
  } else if (Date.now() - startMs > 10000) {
    console.log('TIMEOUT aGot=' + JSON.stringify(aGot) + ' exits=' + JSON.stringify(exits));
    process.exit(2);
  } else { setTimeout(poll, 100); }
};
setTimeout(poll, 2000);
