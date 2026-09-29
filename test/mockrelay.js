// relay จำลอง: พฤติกรรมเดียวกับของจริง (sanitize donation/resolved, broadcast ให้ peer อื่น, backlog replay)
const {WebSocketServer}=require('ws');const port=+process.argv[2]||9101;
const rooms=new Map();const backlog=[];let LISTEN=process.env.T_LISTEN||'';
const wss=new WebSocketServer({port,path:'/ws'});
wss.on('connection',(ws,req)=>{const u=new URL(req.url,'http://x');const ch=u.searchParams.get('ch');
 if(!rooms.has(ch))rooms.set(ch,new Set());rooms.get(ch).add(ws);ws._ch=ch;
 backlog.forEach(m=>ws.send(JSON.stringify(m)));            // replay backlog แบบของจริง
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}
  if(m.t==='donation'&&m.d&&m.d.rec)m={t:'donation',_at:Date.now(),d:{rec:{id:m.d.rec.id,name:m.d.rec.name,amount:m.d.rec.amount,q:m.d.rec.q,status:'pending'}}};
  else if(m.t==='resolved')m={t:'resolved',_at:Date.now(),d:{id:m.d.id,status:m.d.status,amount:m.d.amount,q:m.d.q}};
  else if(m.t==='alert')m={t:'alert',_at:Date.now(),d:m.d};else return;
  backlog.push(m);for(const c of rooms.get(ch))if(c!==ws&&c.readyState===1)c.send(JSON.stringify(m))});
 ws.on('close',()=>rooms.get(ch).delete(ws))});
console.log('mock relay',port);
