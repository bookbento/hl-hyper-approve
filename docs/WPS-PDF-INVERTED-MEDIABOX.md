# PDF ที่ export จาก WPS แล้วลายเซ็นไม่ขึ้น (MediaBox กลับหัว)

บันทึกเมื่อ 2026-11-13 — เจอบน production (ตัวเก่า `HL-E-APPROVAL`) ยืนยันแล้วว่าลายเซ็นไม่ขึ้นจริง

## อาการ

- user สร้างเอกสารใน WPS แล้ว export เป็น PDF ไปอัปโหลด
- ตอนวางลายเซ็นบนหน้าเว็บดูปกติ (pdf.js / react-pdf จัดการ box ให้เอง)
- แต่ PDF ที่ได้หลัง approve **ไม่มีลายเซ็น วันที่ หรือ note ในหน้านั้นเลย** ตราประทับ CANCEL กับ "Approved with condition" ก็หายด้วย
- ตัวอย่างที่เจอ: `m6.11.pdf` (ฟอร์ม Vehicle Mileage Reimbursement) หน้า 1 เสีย หน้า 2–3 (แผนที่) ปกติ
  ส่วน `Muse6_11.pdf` เป็นฟอร์มเดียวกันแต่ export มาอีกทาง ใช้ได้ปกติ

## สาเหตุ

WPS เขียน MediaBox/CropBox กลับหัว เป็น `[0 792 612 0]` แทนที่จะเป็น `[0 0 612 792]`
pdf-lib จึงคืน `height = -792`

ใน `pdf.core.ts`:
- `getViewBox()` ปฏิเสธ box ที่ `h <= 0` แล้ว fallback ไปใช้ `page.getSize()` ซึ่งก็ได้ height ติดลบอยู่ดี
- `pctYTop()` = `b.y + b.height - (yPct/100)*b.height - objH` ได้ y ติดลบ ลายเซ็นจึงถูกวาดนอกหน้า
- จุดที่ใช้ `page.getSize()` ตรง ๆ (ตราประทับ CANCEL, ตราประทับ condition) ก็ผิดเหมือนกัน
- `isLandscape()` ได้ `612 > -792` เป็น true จึงเลือก font/nudge ของหน้าแนวนอนผิดไปด้วย

ตรวจไฟล์ได้ด้วย pdf-lib: `page.getMediaBox().height < 0` แปลว่าไฟล์เป็นแบบนี้

## วิธีแก้ในโค้ด (ยังไม่ได้ใส่ใน repo นี้)

ใส่ฟังก์ชันนี้ใน `apps/api/src/modules/memo-pdf/pdf.core.ts` แล้วเรียก **ก่อน** `flattenPageRotation(p, merged)` ใน loop `copyPages`
(ประมาณบรรทัด 480) ตัว `HL-E-APPROVAL` แก้แบบนี้ไว้แล้วใน working tree แต่ยังไม่ได้ commit/deploy

```ts
// บาง PDF (เช่น export จาก WPS) มี MediaBox/CropBox กลับด้าน เช่น [0 792 612 0]
// pdf-lib จะคืน height ติดลบ → getViewBox/getSize ผิด → ลายเซ็นถูกวาดที่ y ติดลบ (หลุดหน้า)
const normalizePageBoxes = (page: PDFPage): void => {
  const fix = (
    get: () => { x: number; y: number; width: number; height: number },
    set: (x: number, y: number, w: number, h: number) => void
  ) => {
    try {
      const b = get();
      if (b.width >= 0 && b.height >= 0) return;
      set(
        Math.min(b.x, b.x + b.width),
        Math.min(b.y, b.y + b.height),
        Math.abs(b.width),
        Math.abs(b.height)
      );
    } catch { /* box not present */ }
  };
  fix(() => page.getMediaBox(), (x, y, w, h) => page.setMediaBox(x, y, w, h));
  if (page.node.get(PDFName.of("CropBox"))) {
    fix(() => page.getCropBox(), (x, y, w, h) => page.setCropBox(x, y, w, h));
  }
};

// ใน loop:
pages.forEach((p) => {
  merged.addPage(p);
  normalizePageBoxes(p);          // ← เพิ่ม
  flattenPageRotation(p, merged);
});
```

หน้าที่ box ปกติจะไม่ถูกแตะ ส่วนหน้าที่กลับหัวจะแสดงผลเหมือนเดิมในทุก viewer เพราะ box ครอบพื้นที่เดียวกัน

ทดสอบแล้วด้วยสคริปต์ที่ใช้สูตร `getViewBox`/`pctXCenter`/`pctYTop` ชุดเดียวกัน วางกล่อง 3 จุด (25/15, 50/50, 75/85)
แล้ว render เป็น PNG: ก่อนแก้ หน้า 1 ของ `m6.11.pdf` ไม่มีกล่องเลย หลังแก้ขึ้นครบทุกจุด
**ยังไม่ได้ทดสอบ flow approve จริงที่ต่อกับ DB**

## ทางเลี่ยงระหว่างที่ยัง deploy ไม่ได้

1. **ให้ user แก้ไฟล์เองก่อนอัปโหลด** (ยังไม่ได้ยืนยันกับไฟล์ WPS จริง ควรลองก่อน 1 รอบ)
   - เปิด PDF ใน Chrome/Edge → Ctrl+P → "Save as PDF" แล้วอัปโหลดไฟล์ใหม่ หรือ
   - ใน WPS ใช้ Print → เครื่องพิมพ์ "Microsoft Print to PDF" แทนเมนู Export to PDF
2. **แก้ไฟล์ด้วยสคริปต์** (ใช้แค่ `pdf-lib`) แก้เฉพาะ box ที่กลับหัว ไฟล์ที่ปกติจะไม่ถูกแตะ:

   ```js
   // fixbox.js — node fixbox.js in.pdf out.pdf
   const { PDFDocument, PDFName } = require("pdf-lib");
   const fs = require("fs");
   (async () => {
     const [inp, out] = process.argv.slice(2);
     const doc = await PDFDocument.load(fs.readFileSync(inp), { ignoreEncryption: true });
     doc.getPages().forEach((page, i) => {
       for (const [key, get, set] of [
         ["MediaBox", () => page.getMediaBox(), (...a) => page.setMediaBox(...a)],
         ["CropBox", () => page.getCropBox(), (...a) => page.setCropBox(...a)],
       ]) {
         if (key === "CropBox" && !page.node.get(PDFName.of("CropBox"))) continue;
         const b = get();
         if (b.width >= 0 && b.height >= 0) continue;
         set(Math.min(b.x, b.x + b.width), Math.min(b.y, b.y + b.height), Math.abs(b.width), Math.abs(b.height));
         console.log(`fixed p${i + 1} ${key}`);
       }
     });
     fs.writeFileSync(out, await doc.save());
   })();
   ```

3. **memo ที่อัปโหลดเข้า production ไปแล้ว** ใช้สคริปต์ข้อ 2 แก้ไฟล์ในโฟลเดอร์ uploads บน server ได้โดยไม่ต้อง deploy
   ต้อง **backup ไฟล์เดิมก่อน** และเซฟกลับด้วยชื่อ/path เดิม เพราะ DB อ้างอิงตาม `filePath`

## TODO

- [ ] ใส่ `normalizePageBoxes` ใน `apps/api/src/modules/memo-pdf/pdf.core.ts` ก่อน deploy ตัว Nest
- [ ] ทดสอบ approve จริงด้วยไฟล์จาก WPS (หน้าเดียวและหลายหน้าที่ปนกัน)
- [ ] (ถ้าจะทำ) เช็ค `getSize()` จุดอื่นที่อาจได้ค่าติดลบ ถ้ามีไฟล์ที่ไม่ผ่าน loop `copyPages`
