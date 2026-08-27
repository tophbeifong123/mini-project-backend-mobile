#!/usr/bin/env node
/**
 * รวม docs/Codebase/Separate/*.md เป็นไฟล์เดียวใน All_in_one/
 * รันทุกครั้งที่แก้ไฟล์ใน Separate/ ไม่งั้นสองโฟลเดอร์จะไม่ตรงกัน
 *
 *   node scripts/build-all-in-one.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sep = path.join(root, 'docs/Codebase/Separate');
const out = path.join(root, 'docs/Codebase/All_in_one/codebase-guide.md');

/** ตัด H1 ออกแล้วลดระดับหัวข้อที่เหลือลง 1 ขั้น (## -> ###) */
const demote = (md) =>
  md.slice(md.indexOf('\n') + 1).replace(/^(#{2,5}) /gm, (_, h) => `#${h} `);

const primer = demote(fs.readFileSync(path.join(sep, '01-codebase-primer.md'), 'utf8'))
  // ลิงก์ข้ามไฟล์ใช้ไม่ได้ในไฟล์รวม (เลขหัวข้อชนกัน) -> อ้างเป็นข้อความแทน
  .replace(/\[Q&A ข้อ (\d+)\]\(02-design-review-qa\.md#[^)]*\)/g, '**ภาค 2 ข้อ $1**')
  .replace('[`02-design-review-qa.md`](02-design-review-qa.md)', '**ภาค 2** ของไฟล์นี้')
  .split('\n### 📎 อ่านต่อ')[0]
  .trimEnd();

const qa = demote(fs.readFileSync(path.join(sep, '02-design-review-qa.md'), 'utf8')).replace(
  '[`01-codebase-primer.md`](01-codebase-primer.md)',
  '**ภาค 1** ของไฟล์นี้',
);

fs.writeFileSync(
  out,
  `# 📘 Codebase Guide — \`flash-sale-backend\` (ฉบับรวมไฟล์เดียว)

> ⚠️ **ไฟล์นี้ถูก generate** ห้ามแก้ตรงนี้ — แก้ที่ \`Separate/\` แล้วรัน \`node scripts/build-all-in-one.mjs\`
>
> เนื้อหาเหมือน [\`Separate/01-codebase-primer.md\`](../Separate/01-codebase-primer.md) +
> [\`Separate/02-design-review-qa.md\`](../Separate/02-design-review-qa.md) ทุกตัวอักษร
>
> **ภาค 1** = โค้ดไฟล์ไหนเรียกไฟล์ไหน · **ภาค 2** = reviewer 3 คนถกดีไซน์อะไรกัน

---

# ภาค 1 — เดินโค้ดจากศูนย์
${primer}

---

# ภาค 2 — Design Review Q&A
${qa}`,
);

console.log(`[build-all-in-one] เขียน ${path.relative(root, out)} แล้ว`);
