# RZ CLAN Queue Service

บริการคิวเล่น Free Fire แยกอิสระจากระบบโดเนท (คิวล่ม = โดเนทไม่กระทบ)

- `bridge.js` ฟัง relay โดเนทแบบอ่านอย่างเดียว อนุมัติโดเนท + ติ๊กขอคิว => เข้าคิวโดเนทเอง
- ห้ามตามเก็บย้อนหลัง: ข้อความ replay ภายใน 1.5 วิหลังต่อ relay ไม่สร้างคิว (กันยัดซ้ำตอนรีสตาร์ท)
- คิวไม่ถูกล้างเมื่อไม่มีใครเปิดหน้า (ต่างจากแพ็กเดิมที่ dropRoom ตอนคนสุดท้ายออก)

## ENV (Render)
| ตัวแปร | ความหมาย |
|---|---|
| QUEUE_TOKEN | รหัสหน้าแอดมินคิว |
| DONATE_WS | wss://donate-backend-60hc.onrender.com/ws |
| DONATE_CH | ค่า ch ของหน้าโดเนท |
| DONATE_LISTEN_TOKEN | (ไม่บังคับ) ใส่เมื่อ relay บังคับ RELAY_TOKEN |
| QUEUE_CH | (ไม่บังคับ) ค่าเริ่มต้น = DONATE_CH |
| ALLOWED_ORIGINS | โดเมนหน้าโดเนท คั่นด้วย , |

## URL
- แอดมิน `/queue-admin.html?ch=CH` (ใส่ QUEUE_TOKEN ในหน้า)
- OBS แนวตั้ง `/queue-overlay.html?ch=CH` · แนวนอน `/queue-bar.html?ch=CH`
- ฝังหน้าโดเนท `/embed?ch=CH&parent=https://rz-clan-v4.vercel.app`
- เช็คสะพาน `/bridge` ต้องเห็น `"alive":true`

## ทดสอบ
`npm i && npm test` (34 เคส: รีสตาร์ทไม่ยัดซ้ำ, สิทธิ์แอดมิน, UID ไม่รั่ว, relay ล่ม ฯลฯ)
