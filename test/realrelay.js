// E2E: REAL donate-backend/server.js  <->  REAL Queue-system bridge. (mockrelay.js is not used.)
// Needs ../donate-backend checked out next to this repo. Run: node test/realrelay.js
const {spawn}=require('child_process');const WebSocket=require('ws');const http=require('http');const path=require('path');
const CH='rzc_testchannel01',RT='relay_admin_tok',LT='listen_only_tok',QT='qtok_secret_123';
let pass=0,fail=0;const ok=(c,l)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+l)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const kids=[];process.on('exit',()=>kids.forEach(k=>{try{k.kill()}catch(e){}}));
const RELAY_DIR=process.env.RELAY_DIR||path.join(__dirname,'..','..','donate-backend');
function run(cwd,env){const p=spawn('node',['server.js'],{cwd,env:{...process.env,...env}});let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);p.log=()=>log;kids.push(p);return p}
const get=(p,port)=>new Promise(r=>http.get({port,path:p},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>r({s:res.statusCode,b}))}).on('error',e=>r({s:0,b:String(e)})));
const ws=(port,q)=>new Promise((res,rej)=>{const w=new WebSocket(`ws://127.0.0.1:${port}/ws?${q}`);w.msgs=[];w.on('message',d=>w.msgs.push(JSON.parse(d)));w.on('open',()=>res(w));w.on('error',rej)});
const last=(w,t)=>[...w.msgs].reverse().find(m=>m.t===t);
(async()=>{
 const relay=run(RELAY_DIR,{PORT:'9401',RELAY_TOKEN:RT,LISTEN_TOKEN:LT});await sleep(700);
 const q=run(path.join(__dirname,'..'),{PORT:'9402',QUEUE_TOKEN:QT,DONATE_WS:'ws://127.0.0.1:9401/ws',DONATE_CH:CH,DONATE_LISTEN_TOKEN:LT});await sleep(1500);
 ok(JSON.parse((await get('/bridge',9402)).b).alive===true,'bridge connects to REAL relay with listener token');
 const donor=await ws(9401,`ch=${CH}`);              // donor page: no token
 const admin=await ws(9401,`ch=${CH}&tok=${RT}`);    // donate admin
 const qadm=await ws(9402,`ch=${CH}&tok=${QT}`);await sleep(300);
 // donor pays 60 + asks for queue
 donor.send(JSON.stringify({t:'donation',d:{rec:{id:'R1',name:'Somchai',amount:60,message:'hi',q:{name:'SomchaiFF',uid:'123456789482'}},slip:null}}));await sleep(300);
 ok(last(qadm,'q_state').d.list.length===0,'pending donation does NOT enter queue before approval');
 const t0=Date.now();admin.send(JSON.stringify({t:'resolved',d:{id:'R1',status:'approved'}}));
 admin.send(JSON.stringify({t:'alert',d:{name:'Somchai',amount:60,message:'hi'}}));
 for(let i=0;i<20&&!(last(qadm,'q_state')&&last(qadm,'q_state').d.list.length);i++)await sleep(100);
 const st=last(qadm,'q_state').d;
 ok(st.list.length===1&&st.list[0].tier==='paid'&&st.list[0].amount===60,'REAL relay: approve 60฿ -> paid queue entry auto-created');
 ok(Date.now()-t0<2000,'within 2 seconds');
 ok(st.list[0].uid==='123456789482','UID carried through real relay');
 ok(q.log().includes('[bridge] +คิวโดเนท'),'log has "[bridge] +คิวโดเนท"');
 // donation without UID
 const n=st.list.length;
 donor.send(JSON.stringify({t:'donation',d:{rec:{id:'R2',name:'NoQ',amount:100}}}));await sleep(200);
 admin.send(JSON.stringify({t:'resolved',d:{id:'R2',status:'approved'}}));await sleep(500);
 ok(last(qadm,'q_state').d.list.length===n,'no UID => nothing queued, no error');
 // malformed UID must not block the donation itself
 donor.send(JSON.stringify({t:'donation',d:{rec:{id:'R3',name:'Bad',amount:100,q:{name:'x',uid:'12ab'}}}}));await sleep(200);
 ok(!!last(admin,'donation')&&admin.msgs.filter(m=>m.t==='donation').some(m=>m.d.rec.id==='R3'),'bad UID: donation STILL reaches admin (payment not blocked)');
 admin.send(JSON.stringify({t:'resolved',d:{id:'R3',status:'approved'}}));await sleep(400);
 ok(last(qadm,'q_state').d.list.length===n,'bad UID => not queued');
 // rejected
 donor.send(JSON.stringify({t:'donation',d:{rec:{id:'R4',name:'Rej',amount:100,q:{name:'r',uid:'987654321'}}}}));await sleep(200);
 admin.send(JSON.stringify({t:'resolved',d:{id:'R4',status:'rejected'}}));await sleep(400);
 ok(last(qadm,'q_state').d.list.length===n,'rejected => not queued');
 // client-claimed amount cannot inflate tier: donate 10, admin claims 500
 donor.send(JSON.stringify({t:'donation',d:{rec:{id:'R5',name:'Cheap',amount:10,q:{name:'c',uid:'555555555'}}}}));await sleep(200);
 admin.send(JSON.stringify({t:'resolved',d:{id:'R5',status:'approved',amount:500}}));await sleep(500);
 const e5=last(qadm,'q_state').d.list.find(e=>e.uid==='555555555');
 ok(!e5||e5.tier==='free','amount comes from stored donation (10), not from resolved message');
 // queue service restart must NOT re-queue old approvals
 q.kill();await sleep(400);
 const q2=run(path.join(__dirname,'..'),{PORT:'9402',QUEUE_TOKEN:QT,DONATE_WS:'ws://127.0.0.1:9401/ws',DONATE_CH:CH,DONATE_LISTEN_TOKEN:LT});await sleep(2500);
 const qa2=await ws(9402,`ch=${CH}&tok=${QT}`);await sleep(300);
 ok(last(qa2,'q_state').d.list.filter(e=>e.uid==='123456789482').length<=1,'restart: no duplicate entry from relay backlog replay');
 // queue dies: donate keeps working
 q2.kill();await sleep(300);
 donor.send(JSON.stringify({t:'donation',d:{rec:{id:'R6',name:'Alive',amount:100}}}));await sleep(200);
 ok(admin.msgs.some(m=>m.t==='donation'&&m.d.rec.id==='R6'),'queue DOWN: donation flow unaffected');
 ok(!/uncaught/i.test(relay.log()),'relay: no uncaught exceptions');
 console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})();
