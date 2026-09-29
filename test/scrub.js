// สถานะ /bridge เปิดสาธารณะ: ห้ามมีโทเคนหลุด. Run: node test/scrub.js
process.env.DONATE_LISTEN_TOKEN='secretlisten1234567890abcdef';process.env.DONATE_CH='rzc_x';process.env.DONATE_WS='ws://127.0.0.1:1/ws';
const b=require('../bridge');let pass=0,fail=0;const ok=(c,l)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+l)};
const T=process.env.DONATE_LISTEN_TOKEN;
ok(!b._scrub('Invalid URL: wss://h/ws?ch=rzc_x&tok='+T).includes(T),'tok= query value removed');
ok(b._scrub('Invalid URL: wss://h/ws?tok='+T+'&ch=rzc_x').includes('ch=rzc_x'),'other params preserved');
ok(!b._scrub('failed with '+T+' in text').includes(T),'raw token anywhere in text removed');
ok(!b._scrub('[x](https://h/ws?ch=a&tok=abc123def)').includes('abc123def'),'any tok= value removed even if not the configured token');
ok(b._scrub('connect ECONNREFUSED 1.2.3.4:443')==='connect ECONNREFUSED 1.2.3.4:443','normal errors untouched');
ok(b._scrub(null)==='' && b._scrub(undefined)==='','null/undefined safe');
ok(b._scrub('x'.repeat(1000)).length===200,'length capped');
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
