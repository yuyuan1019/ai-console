const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const KEY = crypto.createHash('sha256').update(process.env.MASTER_KEY || 'ai-console-dev-master-key-change-me').digest();
// ponytail (bug 18): __dirname 相对定位（与 seed.cjs 一致），去掉硬编码 D:/dev/ai-console/...
// 与 readOnly（文件缺失时无法创建、且会阻断 WAL sidecar 创建）。
const dbPath = path.join(__dirname, '..', 'data', 'ai-console.db');
const seedPath = path.join(__dirname, '..', '..', 'seed', 'cc-switch-import.json');
if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}\n  Run \`node console/db/seed.cjs\` first.`);
  process.exit(1);
}
if (!fs.existsSync(seedPath)) {
  console.error(`Seed JSON not found: ${seedPath}\n  (seed/ is gitignored — obtain cc-switch-import.json separately.)`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const dec = (ev, iv) => {
  const b = Buffer.from(ev, 'base64'); const tag = b.subarray(-16); const ct = b.subarray(0, -16);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64')); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
};
let ok = 0, fail = 0;
for (const r of seed.raw_presets) {
  if (!r.api_key) continue;
  const rows = db.prepare("SELECT encrypted_value, iv FROM provider_keys WHERE label=?").all(r.name);
  let matched = false;
  for (const row of rows) { if (dec(row.encrypted_value, row.iv) === r.api_key) { matched = true; break; } }
  if (matched) ok++; else { fail++; console.log('  no match:', r.name, r.base_url, `(rows=${rows.length})`); }
}
console.log(`decrypt round-trip: ${ok} ok, ${fail} fail`);
db.close();
