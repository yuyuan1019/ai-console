// AI Console seeder — builds ai-console.db from schema.sql + CC Switch seed JSON
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', 'data');
const SCHEMA = path.join(__dirname, 'schema.sql');
const MIGRATIONS = path.join(__dirname, 'migrations');
const SEED = path.join(__dirname, '..', '..', 'seed', 'cc-switch-import.json');
const OUT = path.join(DB_DIR, 'ai-console.db');

const passphrase = process.env.MASTER_KEY || 'ai-console-dev-master-key-change-me';
if (!process.env.MASTER_KEY) console.warn('⚠ MASTER_KEY 未设置，使用 dev 默认密钥（生产必改）');
const KEY = crypto.createHash('sha256').update(passphrase).digest(); // 32 bytes

const encrypt = (plain) => {
  if (!plain) return { encrypted_value: null, iv: null };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return { encrypted_value: Buffer.concat([ct, tag]).toString('base64'), iv: iv.toString('base64') };
};
const norm = (u) => (u || '').replace(/\/+$/, '').replace(/\/v1$/i, '').toLowerCase();
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const mask = (v) => (typeof v === 'string' && v.length > 12 ? v.slice(0, 6) + '***' + v.slice(-4) : v ? '***' : null);

fs.mkdirSync(DB_DIR, { recursive: true });
if (fs.existsSync(OUT)) fs.rmSync(OUT);
if (fs.existsSync(OUT + '-wal')) fs.rmSync(OUT + '-wal');
if (fs.existsSync(OUT + '-shm')) fs.rmSync(OUT + '-shm');

const db = new DatabaseSync(OUT);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');

// 走 migration 系统（seed 先删旧库，总是全新建库，正常执行所有 migration）
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
if (fs.existsSync(MIGRATIONS)) {
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const version = file.replace('.sql', '');
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(version, Date.now());
    console.log(`  migration: applied ${version}`);
  }
} else {
  // fallback: migrations 目录不存在时回退到 schema.sql
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  console.warn('⚠ migrations directory not found, fell back to schema.sql');
}
db.exec('BEGIN');

const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const normMap = {};

const pProv = db.prepare(`INSERT INTO providers(id,name,base_url,models_endpoint,preset,enabled,created_at)
  VALUES(?,?,?,'/v1/models','ccswitch',1,?)`);
for (const p of seed.providers) {
  const id = uid();
  normMap[norm(p.base_url)] = id;
  pProv.run(id, p.name, p.base_url, now());
}

const pKey = db.prepare(`INSERT INTO provider_keys(id,provider_id,label,group_name,family,encrypted_value,iv,api_format,auth_type,raw_config_json,enabled,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,1,?)`);
let keyCount = 0, oauthCount = 0;
for (const r of seed.raw_presets) {
  const pid = normMap[norm(r.base_url)];
  if (!pid) continue; // no provider match -> skip
  const enc = encrypt(r.api_key);
  pKey.run(uid(), pid, r.name, null, r.family, enc.encrypted_value, enc.iv, r.api_format || null, r.api_key ? 'apikey' : 'oauth', JSON.stringify(r.raw_settings_config), now());
  if (r.api_key) keyCount++; else oauthCount++;
}

const pModel = db.prepare(`INSERT INTO models(id,provider_id,key_id,model_id,family,enabled,fetched_at) VALUES(?,?,NULL,?,?,1,?)`);
let modelCount = 0;
for (const p of seed.providers) {
  const pid = normMap[norm(p.base_url)];
  for (const m of p.models) { pModel.run(uid(), pid, m, p.family, now()); modelCount++; }
}

const pEp = db.prepare(`INSERT INTO provider_endpoints(provider_id,url,added_at) VALUES(?,?,?)`);
const seenEp = new Set(); let epCount = 0;
for (const r of seed.raw_presets) {
  const pid = normMap[norm(r.base_url)];
  if (!pid) continue;
  for (const u of (r.endpoints || [])) {
    const k = pid + '|' + u;
    if (seenEp.has(k)) continue; seenEp.add(k);
    pEp.run(pid, u, now()); epCount++;
  }
}

const pPricing = db.prepare(`INSERT OR REPLACE INTO model_pricing(model_id,display_name,input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_creation_cost_per_million) VALUES(?,?,?,?,?,?)`);
let priceCount = 0;
for (const m of seed.model_pricing) {
  pPricing.run(m.model_id, m.display_name, m.input_cost_per_million, m.output_cost_per_million, m.cache_read_cost_per_million || '0', m.cache_creation_cost_per_million || '0');
  priceCount++;
}

const jobCounts = { providers: seed.providers.length, keys: keyCount, oauth: oauthCount, models: modelCount, pricing: priceCount };
db.prepare(`INSERT INTO import_jobs(id,source_type,source_path,status,counts_json,started_by,started_at,finished_at) VALUES(?, 'ccswitch-sql', ?, 'done', ?, 'seeder', ?, ?)`).run(uid(), seed.source, JSON.stringify(jobCounts), now(), now());

db.exec('COMMIT');

// verify + masked sample
const q = (sql) => db.prepare(sql).all();
console.log(`\n✓ seeded ${OUT}`);
console.log('counts:', {
  providers: q('SELECT COUNT(*) c FROM providers')[0].c,
  provider_keys: q('SELECT COUNT(*) c FROM provider_keys')[0].c,
  provider_endpoints: q('SELECT COUNT(*) c FROM provider_endpoints')[0].c,
  models: q('SELECT COUNT(*) c FROM models')[0].c,
  model_pricing: q('SELECT COUNT(*) c FROM model_pricing')[0].c,
  import_jobs: q('SELECT COUNT(*) c FROM import_jobs')[0].c,
});
console.log('\nsample keys (encrypted, re-derived mask):');
for (const row of q('SELECT k.label, k.family, k.auth_type, k.api_format, p.base_url FROM provider_keys k JOIN providers p ON p.id=k.provider_id ORDER BY k.family, k.label LIMIT 20')) {
  console.log(`  [${row.family}] ${row.label} | ${row.auth_type} | ${row.api_format || '-'} | ${row.base_url}`);
}
db.close();
