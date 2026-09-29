const {spawn}=require('child_process');const WebSocket=require('ws');const http=require('http');
const CH='rzc_testchannel01',QT='qtok_secret_123';let pass=0,fail=0;
const ok=(c,l)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+l)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=(p,port)=>new Promise(r=>http.get({port,path:p},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>r({s:res.statusCode,b,h:res.headers}))}).on('error',e=>r({s:0,b:String(e)})));
let procs=[];const run=(f,args,env)=>{const p=spawn('node',[f,...args],{env:{...process.env,...env},cwd:require('path').join(__dirname,'..')});let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);p.log=()=>log;procs.push(p);return p};
const ws=(port,q)=>new Promise((res,rej)=>{const w=new WebSocket(`ws://127.0.0.1:${port}/ws?${q}`);w.msgs=[];w.on('message',d=>w.msgs.push(JSON.parse(d)));w.on('open',()=>res(w));w.on('error',rej)});
const last=(w,t)=>[...w.msgs].reverse().find(m=>m.t===t);
const qenv=(o={})=>({PORT:'9201',QUEUE_TOKEN:QT,DONATE_WS:'ws://127.0.0.1:9101/ws',DONATE_CH:CH,...o});
(async()=>{
 const relay=run('test/mockrelay.js',['9101']);await sleep(500);
 let q=run('server.js',[],qenv());await sleep(1200);
 // --- bridge ---
 let b=JSON.parse((await get('/bridge',9201)).b);ok(b.alive===true,'/bridge alive:true');
 const h=await get('/health',9201);ok(h.s===200&&JSON.parse(h.b).ok,'/health ok');
 const adm=await ws(9201,`ch=${CH}&tok=${QT}`),pub=await ws(9201,`ch=${CH}`),don=await ws(9101,`ch=${CH}`);
 await sleep(300);
 ok(last(adm,'q_state').d.cfg.full!==undefined,'admin token => admin snapshot (cfg.full)');
 ok(last(pub,'q_state').d.cfg.full===undefined,'public ไม่เห็น cfg เต็ม');
 // --- โดเนท 60฿ + ขอคิว -> อนุมัติ -> เข้าคิว ---
 don.send(JSON.stringify({t:'donation',d:{rec:{id:'D1',name:'Somchai',amount:60,q:{name:'SomchaiFF',uid:'123456789482'}}}}));
 await sleep(150);
 const t0=Date.now();don.send(JSON.stringify({t:'resolved',d:{id:'D1',status:'approved',amount:60}}));
 await sleep(500);
 let st=last(adm,'q_state').d;
 ok(st.list.length===1&&st.list[0].tier==='paid'&&st.list[0].amount===60,'โดเนท 60฿ อนุมัติ -> คิวโดเนทเกิดเอง');
 ok(Date.now()-t0<2000,'เกิดภายใน 2 วินาที');
 ok(q.log().includes('[bridge] +คิวโดเนท'),'log มี "[bridge] +คิวโดเนท"');
 ok(st.list[0].uid==='123456789482','แอดมินเห็น UID เต็ม');
 ok(last(pub,'q_state').d.list[0].uid===undefined&&last(pub,'q_state').d.list[0].uidTail==='…482','public เห็นแค่ …482 ไม่เห็น UID เต็ม');
 // --- ไม่กรอก UID ---
 const n0=st.list.length;
 don.send(JSON.stringify({t:'donation',d:{rec:{id:'D2',name:'NoQ',amount:100}}}));await sleep(100);
 don.send(JSON.stringify({t:'resolved',d:{id:'D2',status:'approved',amount:100}}));await sleep(400);
 ok(last(adm,'q_state').d.list.length===n0,'โดเนทไม่มี UID => ไม่มีอะไรเข้าคิว');
 ok(!q.log().includes('Error')&&!q.log().includes('uncaught'),'ไม่มี error/uncaught');
 // --- อนุมัติซ้ำ (replay) ---
 don.send(JSON.stringify({t:'resolved',d:{id:'D1',status:'approved',amount:60}}));await sleep(300);
 ok(last(adm,'q_state').d.list.length===n0,'approved ซ้ำ (relay replay) => ไม่ยัดซ้ำ');
 // --- โดเนทต่ำกว่าขั้นต่ำ ---
 don.send(JSON.stringify({t:'donation',d:{rec:{id:'D3',name:'Low',amount:20,q:{name:'LowFF',uid:'987654321'}}}}));await sleep(100);
 don.send(JSON.stringify({t:'resolved',d:{id:'D3',status:'approved',amount:20}}));await sleep(400);
 st=last(adm,'q_state').d;const low=st.list.find(e=>e.name==='LowFF');
 ok(low&&low.tier==='free','โดเนท < 50฿ => เข้าเป็นคิวฟรี ไม่ใช่คิวโดเนท');
 // --- rejected ---
 don.send(JSON.stringify({t:'donation',d:{rec:{id:'D4',name:'Rej',amount:500,q:{name:'RejFF',uid:'555666777'}}}}));await sleep(100);
 don.send(JSON.stringify({t:'resolved',d:{id:'D4',status:'rejected'}}));await sleep(300);
 ok(!last(adm,'q_state').d.list.some(e=>e.name==='RejFF'),'rejected => ไม่เข้าคิว');
 // --- public ต่อคิวฟรี / ปลอม tier ไม่ได้ ---
 pub.send(JSON.stringify({t:'q_join',d:{name:'Hacker',uid:'111222333',tier:'paid',amount:99999}}));await sleep(300);
 const hk=last(adm,'q_state').d.list.find(e=>e.name==='Hacker');
 ok(hk&&hk.tier==='free'&&hk.amount===0,'public ปลอม tier/amount ไม่ได้ (ได้คิวฟรี)');
 pub.send(JSON.stringify({t:'q_admin',d:{act:'clear'}}));await sleep(300);
 ok(last(adm,'q_state').d.list.length>0,'public ส่ง q_admin ไม่ได้ผล');
 const pw=await ws(9201,`ch=${CH}&tok=wrong`);pw.send(JSON.stringify({t:'q_admin',d:{act:'clear'}}));await sleep(300);
 ok(last(adm,'q_state').d.list.length>0,'token ผิด สั่งแอดมินไม่ได้');
 // --- เรียกคิว ---
 adm.send(JSON.stringify({t:'q_admin',d:{act:'call'}}));await sleep(400);
 ok(last(adm,'q_called')&&last(adm,'q_called').d.names.length>0,'call => q_called broadcast');
 ok(last(adm,'q_state').d.round.length>0,'มีคนกำลังเล่น (round)');
 // --- ★ รีสตาร์ท queue-service ขณะมีโดเนทเก่า: ห้ามยัดกลับ ---
 q.kill();await sleep(600);
 q=run('server.js',[],qenv());await sleep(1500);
 const adm2=await ws(9201,`ch=${CH}&tok=${QT}`);await sleep(800);   // relay replay backlog ให้ bridge ใหม่
 const after=last(adm2,'q_state').d;
 console.log('   หลังรีสตาร์ท: list=',after.list.length,'joined(log)=',(q.log().match(/\+คิวโดเนท/g)||[]).length);
 ok(after.list.length===0,'★ รีสตาร์ทแล้วไม่มีใครถูกยัดกลับเข้าคิวจาก backlog เก่า');
 // --- ปิด relay: คิวฟรียังต่อได้ /bridge alive:false ---
 relay.kill();await sleep(1500);
 b=JSON.parse((await get('/bridge',9201)).b);ok(b.alive===false,'ปิด donate-backend => /bridge alive:false');
 const p2=await ws(9201,`ch=${CH}`);p2.send(JSON.stringify({t:'q_join',d:{name:'FreeGuy',uid:'444555666'}}));await sleep(300);
 ok(last(p2,'q_join_res')&&last(p2,'q_join_res').d.ok,'relay ล่ม แต่คิวฟรียังต่อได้');
 // --- bad ch / path traversal ---
 ok((await get('/q/state?ch=x',9201)).s===400,'ch ผิดรูปแบบ => 400');
 ok((await get('/..%2f..%2fserver.js',9201)).s!==200,'path traversal ถูกบล็อก');
 ok((await get('/../server.js',9201)).s!==200,'path traversal ถูกบล็อก (../)');
 ok((await get('/queue-admin.html',9201)).s===200,'เสิร์ฟ queue-admin.html ได้');
 ok((await get('/embed',9201)).s===200,'/embed เสิร์ฟ queue-embed ได้');
 console.log(`\nRESULT ${pass} pass / ${fail} fail`);procs.forEach(p=>{try{p.kill()}catch{}});process.exit(fail?1:0);
})().catch(e=>{console.error('CRASH',e);procs.forEach(p=>{try{p.kill()}catch{}});process.exit(2)});
