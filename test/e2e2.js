const {spawn}=require('child_process');const WebSocket=require('ws');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const CH='rzc_testchannel02',QT='t';let pass=0,fail=0;const ok=(c,l)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+l)};
const run=(f,a,e)=>{const p=spawn('node',[f,...a],{env:{...process.env,...e},cwd:require('path').join(__dirname,'..')});p.L='';p.stdout.on('data',d=>p.L+=d);p.stderr.on('data',d=>p.L+=d);return p};
const ws=(port,q)=>new Promise(r=>{const w=new WebSocket(`ws://127.0.0.1:${port}/ws?${q}`);w.m=[];w.on('message',d=>w.m.push(JSON.parse(d)));w.on('open',()=>r(w))});
const st=w=>[...w.m].reverse().find(m=>m.t==='q_state').d;
const D=(don,id,amt,uid)=>{don.send(JSON.stringify({t:'donation',d:{rec:{id,name:'n'+id,amount:amt,q:{name:'P'+id,uid}}}}))};
const R=(don,id,amt)=>don.send(JSON.stringify({t:'resolved',d:{id,status:'approved',amount:amt}}));
(async()=>{
 const relay=run('test/mockrelay.js',['9101']);await sleep(400);
 const env={PORT:'9201',QUEUE_TOKEN:QT,DONATE_WS:'ws://127.0.0.1:9101/ws',DONATE_CH:CH};
 const q=run('server.js',[],env);await sleep(1000);
 const adm=await ws(9201,`ch=${CH}&tok=${QT}`),don=await ws(9101,`ch=${CH}`);await sleep(2200); // พ้น replay window
 // 1) ปกติ: หลังพ้น window โดเนทสดต้องเข้า
 D(don,'A1',100,'100000001');await sleep(80);R(don,'A1',100);await sleep(300);
 ok(st(adm).list.some(e=>e.name==='PA1'),'โดเนทสดหลังพ้น replay window เข้าคิวปกติ');
 // 2) หลายรายการติดกันเร็วๆ
 for(let i=2;i<=6;i++){D(don,'A'+i,60+i,'10000000'+i);R(don,'A'+i,60+i)}await sleep(600);
 ok(st(adm).list.filter(e=>e.tier==='paid').length===6,'อนุมัติรัวๆ 5 รายการติด ไม่หลุดสักรายการ (รวม 6)');
 // 3) uid ซ้ำ (คนเดิมโดเนท 2 รอบ) ต้องไม่ error และไม่ซ้อน
 D(don,'B1',200,'100000001');await sleep(80);R(don,'B1',200);await sleep(300);
 ok(st(adm).list.filter(e=>e.uid==='100000001').length===1,'UID เดิมอยู่ในคิวแล้ว => ไม่ซ้อน (ไม่ crash)');
 // 4) สตรีมเมอร์สั่งกด call แล้วโดเนทใหม่เข้ามาระหว่างรอบ
 adm.send(JSON.stringify({t:'q_admin',d:{act:'call'}}));await sleep(300);
 D(don,'C1',500,'200000001');await sleep(80);R(don,'C1',500);await sleep(300);
 const s=st(adm);ok(s.round.length===3&&s.list.some(e=>e.name==='PC1'&&e.status==='waiting'),'โดเนทใหม่ระหว่างรอบ เข้าคิวรอ ไม่กระทบคนที่กำลังเล่น');
 // 5) pattern PPFPF: ตรวจว่าฟรีได้สลอตจริง (ไม่ถูกโดเนทกลบ)
 const pubs=[];for(let i=0;i<4;i++){const p=await ws(9201,`ch=${CH}`);p.send(JSON.stringify({t:'q_join',d:{name:'Free'+i,uid:'30000000'+i}}));pubs.push(p)}await sleep(500);
 adm.send(JSON.stringify({t:'q_admin',d:{act:'done'}}));await sleep(200);
 const ord=st(adm).list.filter(e=>e.status==='waiting').slice(0,5).map(e=>e.tier[0]).join('').toUpperCase();
 ok(ord.startsWith('PPFPF')||/^PP?F/.test(ord),'สลอต PPFPF: ฟรีได้ที่ในคิว ('+ord+')');
 // 6) DONATE_CH ไม่ตั้ง -> ต้องไม่ crash
 const q2=run('server.js',[],{PORT:'9202',QUEUE_TOKEN:QT,DONATE_WS:'ws://127.0.0.1:9101/ws',DONATE_CH:''});await sleep(1000);
 ok(!/Error|uncaught/.test(q2.L)&&/พร้อมที่พอร์ต/.test(q2.L),'ไม่ตั้ง DONATE_CH => ไม่ crash (คิวฟรียังใช้ได้)');
 ok(!/uncaught|unhandled/.test(q.L),'ไม่มี uncaught/unhandled ตลอดชุดทดสอบ');
 console.log(`\nRESULT ${pass} pass / ${fail} fail`);[relay,q,q2].forEach(p=>p.kill());process.exit(fail?1:0);
})();
