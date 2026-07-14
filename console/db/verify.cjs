const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const KEY = crypto.createHash('sha256').update(process.env.MASTER_KEY || 'ai-console-dev-master-key-change-me').digest();
const db = new DatabaseSync('D:/dev/ai-console/console/data/ai-console.db', { readOnly: true });
const seed = JSON.parse(fs.readFileSync('D:/dev/ai-console/seed/cc-switch-import.json', 'utf8'));
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
