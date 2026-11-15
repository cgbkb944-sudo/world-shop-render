'use strict';
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const { DATABASE_URL, BOT_TOKEN } = process.env;
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID || '8127900151';
const WITHDRAWAL_GROUP_ID = '-1004497861005';
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!OWNER_TELEGRAM_ID || !/^\d+$/.test(OWNER_TELEGRAM_ID)) throw new Error('OWNER_TELEGRAM_ID must be numeric');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
});
pool.on('error', e => console.error('PostgreSQL pool error:', e.message));

async function migrateDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', ['world-shop-v2']);
  if (!applied.rowCount) {
  const schemaPath = path.join(__dirname, 'database', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8')
    .replace(/^\s*BEGIN\s*;?/i, '')
    .replace(/COMMIT\s*;?\s*$/i, '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One-time reset of this project's legacy tables, explicitly authorized by the owner.
    await client.query(`
      DROP TABLE IF EXISTS transactions CASCADE;
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS activation_keys CASCADE;
      DROP TABLE IF EXISTS products CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
    await client.query(schema);
    await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', ['world-shop-v2']);
    await client.query('COMMIT');
    console.log('Database reset and migrated to world-shop-v2');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  } else {
    console.log('Database schema world-shop-v2 already applied');
  }
  await pool.query("ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check");
  await pool.query("ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('cryptobot','sbp','card','ton_usdt','telegram_stars'))");
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_reason TEXT;
    ALTER TABLE products ALTER COLUMN status SET DEFAULT 'pending';
    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
    ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('pending','active','rejected','paused','frozen','deleted','sold'));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('paid','delivered','completed','disputed','refunded'));
    ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
    ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('topup','purchase','sale','commission','refund','admin_adjustment','transfer_in','transfer_out'));
    CREATE TABLE IF NOT EXISTS balance_transfer_codes (
      id BIGSERIAL PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      sender_id BIGINT NOT NULL REFERENCES users(telegram_id),
      amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','redeemed','expired','cancelled')),
      recipient_id BIGINT REFERENCES users(telegram_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      redeemed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS balance_transfer_sender_idx ON balance_transfer_codes(sender_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS balance_transfer_recipient_idx ON balance_transfer_codes(recipient_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS balance_topup_codes (
      id BIGSERIAL PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
      created_by BIGINT NOT NULL REFERENCES users(telegram_id),
      used_by BIGINT REFERENCES users(telegram_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS balance_topup_codes_created_idx ON balance_topup_codes(created_at DESC);
    CREATE TABLE IF NOT EXISTS moderation_requests (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('ban','product','product_delete')),
      requested_by BIGINT NOT NULL REFERENCES users(telegram_id),
      target_user_id BIGINT REFERENCES users(telegram_id),
      product_id BIGINT REFERENCES products(id),
      reason TEXT NOT NULL DEFAULT '',
      duration_hours INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      decided_by BIGINT REFERENCES users(telegram_id),
      decision_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    );
    ALTER TABLE moderation_requests DROP CONSTRAINT IF EXISTS moderation_requests_kind_check;
    ALTER TABLE moderation_requests ADD CONSTRAINT moderation_requests_kind_check CHECK (kind IN ('ban','product','product_delete'));
    ALTER TABLE activation_keys ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(telegram_id);
    CREATE INDEX IF NOT EXISTS moderation_pending_idx ON moderation_requests(status,created_at DESC);
    CREATE TABLE IF NOT EXISTS order_refunds (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id),
      refunded_by BIGINT NOT NULL REFERENCES users(telegram_id),
      amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS seller_balance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (seller_balance >= 0);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'standard';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS private_data JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_type_check;
    ALTER TABLE products ADD CONSTRAINT products_product_type_check CHECK (product_type IN ('standard','channel_customization','telegram_stars','subscription','loyalty_points','robux','roblox_account'));
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_details JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS shop_wallet (
      id SMALLINT PRIMARY KEY CHECK (id=1),
      balance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO shop_wallet(id,balance) VALUES (1,0) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS shop_ledger (
      id BIGSERIAL PRIMARY KEY,
      amount NUMERIC(18,2) NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('commission','refund')),
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL REFERENCES users(telegram_id),
      amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL CHECK (method IN ('stars','rub','crypto')),
      payout_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      decided_by BIGINT REFERENCES users(telegram_id),
      decision_note TEXT
    );
    CREATE INDEX IF NOT EXISTS withdrawal_requests_status_idx ON withdrawal_requests(status,created_at DESC);
  `);
}

app.disable('x-powered-by');
app.post('/webhooks/cryptobot/:secret', express.raw({ type: 'application/json', limit: '64kb' }), async (req,res) => {
  try { await handleCryptoPayWebhook(req,res); }
  catch (e) { console.error('Crypto Pay webhook:', e.message); res.sendStatus(500); }
});
app.post('/webhooks/rollypay', express.raw({ type: 'application/json', limit: '64kb' }), async (req,res) => {
  try { await handleRollyPayWebhook(req,res); }
  catch (e) { console.error('RollyPay webhook:', e.message); res.sendStatus(500); }
});
app.post('/webhooks/telegram', express.json({ limit: '64kb' }), async (req,res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (!secret || !safeEqual(req.get('x-telegram-bot-api-secret-token') || '', secret)) return res.sendStatus(403);
  try {
    const update = req.body || {};
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      const match = /^wts_stars_(\d+)_([a-f0-9]+)$/.exec(String(q.invoice_payload || ''));
      let valid = false;
      if (match && q.currency === 'XTR' && Number.isSafeInteger(Number(q.from?.id))) {
        const p = await pool.query("SELECT id,telegram_id,amount,status,expires_at,provider_payload FROM payments WHERE id=$1 AND provider='telegram_stars'", [Number(match[1])]);
        if (p.rowCount) {
          const row = p.rows[0];
          valid = row.status === 'pending' &&
            String(row.telegram_id) === String(q.from.id) &&
            Number(row.amount) === Number(q.total_amount) &&
            row.provider_payload?.invoice_payload === q.invoice_payload &&
            (!row.expires_at || new Date(row.expires_at).getTime() > Date.now());
        }
      }
      await telegramRequest('answerPreCheckoutQuery', {
        pre_checkout_query_id: q.id,
        ok: valid,
        ...(valid ? {} : { error_message: 'Счёт недействителен или истёк. Создайте новый платёж.' })
      });
    }
    const payment = update.message?.successful_payment;
    if (payment) {
      const match = /^wts_stars_(\d+)_([a-f0-9]+)$/.exec(String(payment.invoice_payload || ''));
      if (!match || payment.currency !== 'XTR' || !payment.telegram_payment_charge_id) return res.sendStatus(400);
      const p = await pool.query("SELECT id,telegram_id,amount,status,provider_payload FROM payments WHERE id=$1 AND provider='telegram_stars'", [Number(match[1])]);
      if (!p.rowCount) return res.sendStatus(404);
      const row = p.rows[0];
      if (String(row.telegram_id) !== String(update.message.from?.id) ||
          Number(row.amount) !== Number(payment.total_amount) ||
          row.provider_payload?.invoice_payload !== payment.invoice_payload) return res.sendStatus(409);
      await finalizePayment(row.id, 'telegram_stars', String(payment.telegram_payment_charge_id));
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Telegram webhook:', e.message);
    res.sendStatus(500);
  }
});
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.static(path.join(__dirname), { index: false }));

function verifyInitData(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 4096) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  const authDate = Number(p.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate) ||
      Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(calculated, 'hex'), b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return null;
  try {
    const u = JSON.parse(p.get('user') || '{}');
    if (!u.id || !/^\d+$/.test(String(u.id))) return null;
    return { id: String(u.id), username: String(u.username || '').slice(0,64) };
  } catch { return null; }
}
async function auth(req,res,next) {
  const u = verifyInitData(req.get('x-telegram-init-data'));
  if (!u) return res.status(401).json({error:'Откройте магазин через Telegram.'});
  try {
    const role = u.id === OWNER_TELEGRAM_ID ? 'owner' : 'user';
    const r = await pool.query(
      "INSERT INTO users (telegram_id,username,role) VALUES ($1,$2,$3) " +
      "ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username, " +
      "role=CASE WHEN users.telegram_id=$4 THEN 'owner' ELSE users.role END, updated_at=NOW() " +
      "RETURNING telegram_id,username,role,balance,seller_balance,is_banned,banned_until,banned_reason",
      [u.id,u.username,role,OWNER_TELEGRAM_ID]);
    req.user = r.rows[0];
    if (req.user.is_banned && req.user.banned_until && new Date(req.user.banned_until) <= new Date()) {
      await pool.query('UPDATE users SET is_banned=FALSE,banned_until=NULL,banned_reason=NULL,updated_at=NOW() WHERE telegram_id=$1',[u.id]);
      req.user.is_banned=false;
    }
    if (req.user.is_banned) return res.status(403).json({error:'Ваш аккаунт заблокирован. '+(req.user.banned_reason||'Обратитесь в поддержку.')});
    next();
  } catch(e) { console.error('Auth error:',e.message); res.status(503).json({error:'Сервис временно недоступен.'}); }
}
const roles = (...allowed) => (req,res,next) => allowed.includes(req.user.role) ? next() : res.status(403).json({error:'Недостаточно прав.'});
const money = v => { const n=Number(v); return Number.isFinite(n)&&n>0&&n<=1e7&&Math.round(n*100)/100===n?n:null; };
const hashKey = v => crypto.createHash('sha256').update(String(v).trim().toUpperCase()).digest('hex');
function privateDataKey() {
  return crypto.createHash('sha256').update(String(process.env.ACCOUNT_DATA_ENCRYPTION_KEY || BOT_TOKEN) + '|world-shop-private-delivery-v1').digest();
}
function encryptPrivateData(value) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',privateDataKey(),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return {v:1,alg:'A256GCM',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')};
}
function decryptPrivateData(envelope) {
  if(!envelope||!envelope.data)return {};
  if(envelope.v!==1||envelope.alg!=='A256GCM')throw new Error('Unsupported private delivery data format');
  const decipher=crypto.createDecipheriv('aes-256-gcm',privateDataKey(),Buffer.from(envelope.iv,'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
}

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:'connected'});}catch{res.status(503).json({ok:false,database:'unavailable'});}});
app.get('/health/payments',async(req,res)=>{
  const has=k=>Boolean(String(process.env[k]||'').trim());
  let ownerTransfer=false;
  try{const owner=await pool.query('SELECT username FROM users WHERE telegram_id=$1 LIMIT 1',[OWNER_TELEGRAM_ID]);ownerTransfer=/^[A-Za-z0-9_]{5,32}$/.test(String(process.env.OWNER_TELEGRAM_USERNAME||owner.rows[0]?.username||''));}catch(e){console.warn('Owner transfer readiness:',e.message);}
  const missing={
    cryptobot:['CRYPTO_PAY_API_TOKEN'].filter(k=>!has(k)),
    owner_transfer:ownerTransfer?[]:['OWNER_TELEGRAM_USERNAME (или username владельца в профиле Telegram)'],
    direct_transfer:[...(has('CRYPTO_PAY_API_TOKEN')?[]:['CRYPTO_PAY_API_TOKEN']),...((tonAddress&&normalizeTonAddress(tonAddress))?[]:['TON_WALLET_ADDRESS'])],
    telegram_stars:[...(!has('BOT_TOKEN')?['BOT_TOKEN']:[]),...(!has('TELEGRAM_WEBHOOK_SECRET')?['TELEGRAM_WEBHOOK_SECRET']:[]),...(!appOrigin?['APP_ORIGIN']:[])]
  };
  res.json({
    cryptobot:missing.cryptobot.length===0,
    owner_transfer:ownerTransfer,
    direct_transfer:missing.direct_transfer.length===0,
    telegram_stars:missing.telegram_stars.length===0,
    missing,
    webhookWarnings:{
      cryptobot:has('CRYPTO_PAY_WEBHOOK_SECRET')?[]:['CRYPTO_PAY_WEBHOOK_SECRET (резервный опрос статуса будет работать без webhook)'],
      owner_transfer:[]
    }
  });
});
app.get('/api/products',async(req,res)=>{
  try { const r=await pool.query("SELECT p.id,p.title,p.description,p.price,p.price_from,p.max_price,p.category,p.subcategory,p.product_type,COALESCE(u.display_name,u.username,'Продавец') AS seller_name FROM products p JOIN users u ON u.telegram_id=p.seller_id WHERE p.status='active' ORDER BY p.created_at DESC LIMIT 200"); res.json(r.rows); }
  catch(e){console.error(e.message);res.status(503).json({error:'Не удалось загрузить товары.'});}
});
app.use('/api',auth);
app.post('/api/user',async(req,res)=>{
  try{
    const q=await pool.query('SELECT telegram_id,username,role,balance,seller_balance,is_banned,display_name,avatar_url,banned_until FROM users WHERE telegram_id=$1',[req.user.telegram_id]);
    res.json(q.rows[0]||req.user);
  }catch(e){res.status(503).json({error:'Не удалось загрузить профиль.'});}
});
app.put('/api/profile',async(req,res)=>{
  const name=String(req.body?.display_name||'').trim().slice(0,40);
  const avatar=String(req.body?.avatar_url||'').trim();
  if(avatar && (!/^https:\/\//i.test(avatar)||avatar.length>1000))return res.status(400).json({error:'Ссылка на аватар должна начинаться с https://.'});
  try{
    const q=await pool.query('UPDATE users SET display_name=$1,avatar_url=$2,updated_at=NOW() WHERE telegram_id=$3 RETURNING display_name,avatar_url',[name||null,avatar||null,req.user.telegram_id]);
    res.json({success:true,...q.rows[0]});
  }catch(e){res.status(503).json({error:'Не удалось сохранить настройки профиля.'});}
});
app.get('/api/history',async(req,res)=>{try{const r=await pool.query('SELECT amount,type,description,created_at FROM transactions WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.telegram_id]);res.json(r.rows);}catch(e){console.error(e.message);res.status(503).json({error:'Не удалось загрузить историю.'});}});
app.get('/api/my/activity',async(req,res)=>{
  try{
    const [purchases,sales,transfers]=await Promise.all([
      pool.query(`SELECT o.id,o.amount,o.status,o.created_at,p.title,COALESCE(s.display_name,s.username,'Продавец') AS store_name FROM orders o JOIN products p ON p.id=o.product_id JOIN users s ON s.telegram_id=o.seller_id WHERE o.buyer_id=$1 ORDER BY o.created_at DESC LIMIT 100`,[req.user.telegram_id]),
      pool.query('SELECT o.id,o.amount,o.status,o.created_at,o.buyer_details,p.title,p.product_type FROM orders o JOIN products p ON p.id=o.product_id WHERE o.seller_id=$1 ORDER BY o.created_at DESC LIMIT 100',[req.user.telegram_id]),
      pool.query('SELECT id,amount,status,created_at,recipient_id,sender_id,CASE WHEN sender_id=$1 THEN \'sent\' ELSE \'received\' END direction FROM balance_transfer_codes WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.telegram_id])
    ]);
    res.json({purchases:purchases.rows,sales:sales.rows,transfers:transfers.rows});
  }catch(e){res.status(503).json({error:'Не удалось загрузить активность.'});}
});
app.get('/api/payment/methods',async(req,res)=>{
  let ownerTransfer=false;
  try{const owner=await pool.query('SELECT username FROM users WHERE telegram_id=$1 LIMIT 1',[OWNER_TELEGRAM_ID]);ownerTransfer=/^[A-Za-z0-9_]{5,32}$/.test(String(process.env.OWNER_TELEGRAM_USERNAME||owner.rows[0]?.username||''));}catch{}
  res.json({
  cryptobot:!!process.env.CRYPTO_PAY_API_TOKEN,
  owner_transfer:ownerTransfer,
  direct_transfer:!!(tonAddress&&normalizeTonAddress(tonAddress)&&process.env.CRYPTO_PAY_API_TOKEN),
  telegram_stars:!!(process.env.TELEGRAM_WEBHOOK_SECRET&&appOrigin)
  });
});

async function expireTransferCodes(){
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const q=await db.query("SELECT * FROM balance_transfer_codes WHERE status='pending' AND expires_at<=NOW() LIMIT 100 FOR UPDATE SKIP LOCKED");
    for(const t of q.rows){
      await db.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2',[t.amount,t.sender_id]);
      await db.query("UPDATE balance_transfer_codes SET status='expired' WHERE id=$1",[t.id]);
      await db.query("INSERT INTO transactions(telegram_id,amount,type,reference,description) VALUES ($1,$2,'refund',$3,'Возврат неиспользованного перевода по истечении срока')",
        [t.sender_id,t.amount,'transfer_'+t.id+'_expired_refund']);
    }
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');console.error('Expire transfer codes:',e.message);}
  finally{db.release();}
}
app.post('/api/transfers/create',async(req,res)=>{
  await expireTransferCodes();
  const amount=money(req.body?.amount);
  if(!amount)return res.status(400).json({error:'Введите положительную сумму перевода.'});
  const code='WTS-'+crypto.randomBytes(5).toString('hex').toUpperCase();
  const hash=hashKey(code),db=await pool.connect();
  try{
    await db.query('BEGIN');
    const debit=await db.query('UPDATE users SET balance=balance-$1,updated_at=NOW() WHERE telegram_id=$2 AND balance >= $1 RETURNING telegram_id',[amount,req.user.telegram_id]);
    if(!debit.rowCount){await db.query('ROLLBACK');return res.status(400).json({error:'Недостаточно средств. Баланс не может стать отрицательным.'});}
    const inserted=await db.query('INSERT INTO balance_transfer_codes(code_hash,sender_id,amount,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL \'24 hours\') RETURNING id',[hash,req.user.telegram_id,amount]);
    await db.query("INSERT INTO transactions(telegram_id,amount,type,reference,description) VALUES ($1,$2,'transfer_out',$3,'Резерв средств для перевода по коду')",[req.user.telegram_id,-amount,'transfer_'+inserted.rows[0].id+'_out']);
    await db.query('COMMIT');
    res.json({success:true,code,amount,expiresInHours:24});
  }catch(e){await db.query('ROLLBACK');console.error('Transfer create:',e.message);res.status(503).json({error:'Не удалось создать код перевода.'});}
  finally{db.release();}
});
app.post('/api/transfers/redeem',async(req,res)=>{
  await expireTransferCodes();
  const code=String(req.body?.code||'').trim().toUpperCase();
  if(!/^WTS-[A-F0-9]{10}$/.test(code))return res.status(400).json({error:'Проверьте код перевода.'});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const q=await db.query('SELECT * FROM balance_transfer_codes WHERE code_hash=$1 FOR UPDATE',[hashKey(code)]);
    if(!q.rowCount||q.rows[0].status!=='pending'||new Date(q.rows[0].expires_at)<=new Date()){await db.query('ROLLBACK');return res.status(400).json({error:'Код недействителен, уже использован или истёк.'});}
    const t=q.rows[0];
    if(String(t.sender_id)===String(req.user.telegram_id)){await db.query('ROLLBACK');return res.status(400).json({error:'Нельзя активировать собственный код.'});}
    await db.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2',[t.amount,req.user.telegram_id]);
    await db.query('UPDATE balance_transfer_codes SET status=\'redeemed\',recipient_id=$1,redeemed_at=NOW() WHERE id=$2',[req.user.telegram_id,t.id]);
    await db.query("INSERT INTO transactions(telegram_id,amount,type,reference,description) VALUES ($1,$2,'transfer_in',$3,$4)",
      [req.user.telegram_id,t.amount,'transfer_'+t.id+'_in','Получение средств по коду']);
    await db.query('COMMIT');
    res.json({success:true,amount:Number(t.amount),message:'Баланс успешно пополнен.'});
  }catch(e){await db.query('ROLLBACK');console.error('Transfer redeem:',e.message);res.status(503).json({error:'Не удалось активировать код.'});}
  finally{db.release();}
});
app.get('/api/transfers/history',async(req,res)=>{
  try{
    const q=await pool.query(`SELECT id,amount,status,created_at,expires_at,recipient_id,
      CASE WHEN sender_id=$1 THEN 'sent' ELSE 'received' END AS direction
      FROM balance_transfer_codes WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.telegram_id]);
    res.json(q.rows);
  }catch(e){res.status(503).json({error:'Не удалось загрузить историю переводов.'});}
});

app.get('/api/products/manage',roles('seller','support','owner'),async(req,res)=>{
  try{
    const own=req.user.role==='seller';
    const q=await pool.query(`SELECT p.id,p.title,p.price,p.status,p.created_at,COALESCE(u.display_name,u.username,'Продавец') AS seller_name
      FROM products p JOIN users u ON u.telegram_id=p.seller_id ${own?'WHERE p.seller_id=$1':''}
      ORDER BY p.created_at DESC LIMIT 200`,own?[req.user.telegram_id]:[]);
    res.json(q.rows);
  }catch(e){console.error('Manage products:',e.message);res.status(503).json({error:'Не удалось загрузить товары.'});}
});
app.post('/api/products/:id/delete',roles('seller','owner'),async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Неверный товар.'});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const q=await db.query('SELECT id,seller_id,status FROM products WHERE id=$1 FOR UPDATE',[id]);
    if(!q.rowCount){await db.query('ROLLBACK');return res.status(404).json({error:'Товар не найден.'});}
    const p=q.rows[0];
    if(req.user.role==='seller'&&String(p.seller_id)!==String(req.user.telegram_id)){await db.query('ROLLBACK');return res.status(403).json({error:'Вы можете удалять только собственные товары.'});}
    if(p.status==='deleted'){await db.query('ROLLBACK');return res.status(400).json({error:'Товар уже удалён.'});}
    await db.query("UPDATE products SET status='deleted' WHERE id=$1",[id]);
    await db.query("UPDATE moderation_requests SET status='rejected',decision_note='Товар удалён продавцом или владельцем до решения',decided_by=$1,decided_at=NOW() WHERE product_id=$2 AND kind IN ('product','product_delete') AND status='pending'",[req.user.telegram_id,id]);
    await db.query('COMMIT');
    res.json({success:true,message:'Товар удалён из каталога.'});
  }catch(e){await db.query('ROLLBACK');console.error('Product delete:',e.message);res.status(503).json({error:'Не удалось удалить товар.'});}
  finally{db.release();}
});
app.post('/api/products/delete-request',roles('support'),async(req,res)=>{
  const id=Number(req.body?.product_id),reason=String(req.body?.reason||'').trim().slice(0,500);
  if(!Number.isSafeInteger(id)||id<1||reason.length<5)return res.status(400).json({error:'Укажите товар и причину удаления (не менее 5 символов).'});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const q=await db.query("SELECT id,title,status FROM products WHERE id=$1 FOR UPDATE",[id]);
    if(!q.rowCount){await db.query('ROLLBACK');return res.status(404).json({error:'Товар не найден.'});}
    const p=q.rows[0];
    if(p.status!=='active'){await db.query('ROLLBACK');return res.status(409).json({error:'Запросить удаление можно только для активного товара.'});}
    const existing=await db.query("SELECT id FROM moderation_requests WHERE product_id=$1 AND kind='product_delete' AND status='pending'",[id]);
    if(existing.rowCount){await db.query('ROLLBACK');return res.status(409).json({error:'Для этого товара уже ожидается решение владельца.'});}
    await db.query("UPDATE products SET status='frozen' WHERE id=$1",[id]);
    const m=await db.query("INSERT INTO moderation_requests(kind,requested_by,product_id,reason) VALUES ('product_delete',$1,$2,$3) RETURNING id",[req.user.telegram_id,id,reason]);
    await db.query('COMMIT');
    await notifyOwner('Запрос на удаление товара #'+id+' «'+p.title+'». Заявка #'+m.rows[0].id+'. Причина: '+reason);
    res.json({success:true,request_id:m.rows[0].id,message:'Товар заморожен. Запрос отправлен владельцу на рассмотрение.'});
  }catch(e){await db.query('ROLLBACK');console.error('Product delete request:',e.message);res.status(503).json({error:'Не удалось отправить запрос на удаление.'});}
  finally{db.release();}
});
app.post('/api/products/add',roles('seller','admin','owner'),async(req,res)=>{
  const b=req.body||{},price=money(b.price),max=b.price_from?money(b.max_price):null,productType=String(b.product_type||'standard');
  const special=['telegram_stars','robux','roblox_account'].includes(productType);
  const allowed=['standard','channel_customization','telegram_stars','subscription','loyalty_points','robux','roblox_account'];
  let privateData={};
  if(productType==='roblox_account'){
    const d=b.private_data&&typeof b.private_data==='object'?b.private_data:{};
    const username=String(d.roblox_username||'').trim(),email=String(d.account_email||'').trim();
    const password=String(d.account_password||''),emailPassword=String(d.email_password||'');
    if(!/^[A-Za-z0-9_]{3,20}$/.test(username)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length>256||!emailPassword||emailPassword.length>256)
      return res.status(400).json({error:'Для аккаунта Roblox укажите корректный username, почту, пароль аккаунта и пароль от почты.'});
    privateData={roblox_username:username,account_email:email,account_password:password,email_password:emailPassword};
  }
  if(typeof b.title!=='string'||!b.title.trim()||b.title.length>160||typeof b.category!=='string'||!b.category||b.category.length>80||
     typeof (b.subcategory||'')!=='string'||(b.subcategory||'').length>100||typeof (b.description||'')!=='string'||b.description.length>5000||
     !price||!allowed.includes(productType)||(b.price_from&&(!max||max<price))||(special&&b.price_from))
    return res.status(400).json({error:'Проверьте название, тип объявления, категорию и цену. Для Robux указывается цена за 1 Robux.'});
  try{
    const encrypted=productType==='roblox_account'?encryptPrivateData(privateData):{};
    const r=await pool.query("INSERT INTO products (title,description,price,price_from,max_price,category,subcategory,seller_id,status,product_type,private_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10) RETURNING id",
      [b.title.trim(),b.description||'',price,Boolean(b.price_from),max,b.category,b.subcategory||'',req.user.telegram_id,productType,JSON.stringify(encrypted)]);
    const m=await pool.query("INSERT INTO moderation_requests(kind,requested_by,product_id,reason) VALUES ('product',$1,$2,'Проверка нового товара') RETURNING id",[req.user.telegram_id,r.rows[0].id]);
    await notifyModerators('Новый товар ожидает проверки. Заявка #'+m.rows[0].id+', товар #'+r.rows[0].id+'. Откройте панель управления.');
    res.json({success:true,pending:true,product_id:r.rows[0].id,request_id:m.rows[0].id});
  }catch(e){console.error('Product create:',e.message);res.status(503).json({error:'Не удалось сохранить товар.'});}
});

app.post('/api/key/activate',async(req,res)=>{
  const key=req.body?.key;
  if(typeof key!=='string'||key.trim().length<8||key.trim().length>128)return res.status(400).json({error:'Введите корректный ключ или код пополнения.'});
  const keyHash=hashKey(key.trim()),c=await pool.connect();
  try{
    await c.query('BEGIN');
    const topup=await c.query(
      'SELECT id,amount FROM balance_topup_codes WHERE code_hash=$1 AND used_by IS NULL AND expires_at>NOW() FOR UPDATE',
      [keyHash]
    );
    if(topup.rowCount){
      const code=topup.rows[0];
      const updated=await c.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2 RETURNING balance',[code.amount,req.user.telegram_id]);
      await c.query('UPDATE balance_topup_codes SET used_by=$1,used_at=NOW() WHERE id=$2',[req.user.telegram_id,code.id]);
      await c.query("INSERT INTO transactions(telegram_id,amount,type,reference,description) VALUES ($1,$2,'topup',$3,$4)",
        [req.user.telegram_id,code.amount,'topup_code_'+code.id,'Пополнение баланса по одноразовому коду']);
      await c.query('COMMIT');
      return res.json({success:true,type:'topup',amount:Number(code.amount),balance:Number(updated.rows[0].balance)});
    }
    const k=await c.query('SELECT key_hash,role FROM activation_keys WHERE key_hash=$1 AND used_by IS NULL FOR UPDATE',[keyHash]);
    if(!k.rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'Неверный, использованный или просроченный ключ/код.'});}
    if(req.user.role==='owner'){await c.query('ROLLBACK');return res.status(400).json({error:'У владельца уже есть максимальные права.'});}
    await c.query('UPDATE activation_keys SET used_by=$1,used_at=NOW() WHERE key_hash=$2',[req.user.telegram_id,k.rows[0].key_hash]);
    await c.query('UPDATE users SET role=$1,updated_at=NOW() WHERE telegram_id=$2',[k.rows[0].role,req.user.telegram_id]);
    await c.query('COMMIT');
    return res.json({success:true,type:'role',role:k.rows[0].role});
  }catch(e){await c.query('ROLLBACK');console.error('Key/top-up activation:',e.message);res.status(500).json({error:'Не удалось активировать код.'});}
  finally{c.release();}
});
app.get('/api/owner/keys',roles('owner'),async(req,res)=>{
  try{
    const q=await pool.query(`SELECT k.role,k.used_by,k.used_at,k.created_at,u.username AS used_username
      FROM activation_keys k LEFT JOIN users u ON u.telegram_id=k.used_by
      ORDER BY k.created_at DESC LIMIT 200`);
    res.json(q.rows);
  }catch(e){res.status(503).json({error:'Не удалось загрузить историю ключей.'});}
});
app.post('/api/key/generate',roles('owner'),async(req,res)=>{
  const role=req.body?.role;if(!['admin','seller','support'].includes(role))return res.status(400).json({error:'Недопустимая роль.'});
  const key='WTS-'+role.toUpperCase()+'-'+crypto.randomBytes(9).toString('hex').toUpperCase();
  try{await pool.query('INSERT INTO activation_keys (key_hash,role,created_by) VALUES ($1,$2,$3)',[hashKey(key),role,req.user.telegram_id]);res.json({success:true,key});}
  catch(e){console.error(e.message);res.status(500).json({error:'Не удалось создать ключ.'});}
});

app.post('/api/key/generate-topup',roles('owner'),async(req,res)=>{
  const amount=money(req.body?.amount);
  if(!amount||amount<10)return res.status(400).json({error:'Сумма кода должна быть не меньше 10 ₽.'});
  const code='WTS-TOPUP-'+crypto.randomBytes(10).toString('hex').toUpperCase();
  const expiresDays=30;
  try{
    const q=await pool.query(
      'INSERT INTO balance_topup_codes(code_hash,amount,created_by,expires_at) VALUES ($1,$2,$3,NOW()+($4 * INTERVAL \'1 day\')) RETURNING expires_at',
      [hashKey(code),amount,req.user.telegram_id,expiresDays]
    );
    res.json({success:true,code,amount,expiresAt:q.rows[0].expires_at,expiresInDays:expiresDays});
  }catch(e){console.error('Top-up code generation:',e.message);res.status(500).json({error:'Не удалось создать код пополнения.'});}
});

app.get('/api/seller/wallet',roles('seller','admin','owner'),async(req,res)=>{
  try{
    const [u,w]=await Promise.all([
      pool.query('SELECT seller_balance FROM users WHERE telegram_id=$1',[req.user.telegram_id]),
      pool.query('SELECT id,amount,method,payout_details,status,created_at,decided_at,decision_note FROM withdrawal_requests WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.telegram_id])
    ]);
    res.json({balance:Number(u.rows[0]?.seller_balance||0),withdrawals:w.rows});
  }catch(e){console.error('Seller wallet:',e.message);res.status(503).json({error:'Не удалось загрузить баланс продавца.'});}
});
app.post('/api/withdrawals',roles('seller','admin','owner'),async(req,res)=>{
  const amount=money(req.body?.amount),method=String(req.body?.method||'');
  const details=req.body?.details&&typeof req.body.details==='object'?req.body.details:{};
  if(!amount)return res.status(400).json({error:'Введите корректную сумму вывода.'});
  if(method==='stars'&&!Number.isInteger(amount))return res.status(400).json({error:'Для вывода в Telegram Stars укажите целое количество рублей/звёзд.'});
  if(!['stars','rub','crypto'].includes(method))return res.status(400).json({error:'Выберите способ вывода.'});
  let payout={};
  if(method==='stars') payout={currency:'XTR',stars:amount,rate:'1 звезда = 1 ₽'};
  if(method==='rub'){
    const channel=String(details.channel||'');
    const value=String(details.value||'').trim().slice(0,250);
    if(!['phone','ewallet'].includes(channel)||value.length<5)return res.status(400).json({error:'Укажите номер телефона или реквизиты электронного кошелька.'});
    payout={channel,value,bank:String(details.bank||'').trim().slice(0,100)};
  }
  if(method==='crypto'){
    const asset=String(details.asset||''),network=String(details.network||''),address=String(details.address||'').trim().slice(0,250);
    if(!['TON','USDT'].includes(asset)||!['TON','TRC20','ERC20','BEP20'].includes(network)||address.length<12)return res.status(400).json({error:'Укажите криптовалюту, сеть и корректный адрес кошелька.'});
    if(asset==='TON'&&network!=='TON')return res.status(400).json({error:'Для TON доступна только сеть TON.'});
    payout={asset,network,address,settlement:'Эквивалент в криптовалюте рассчитывает владелец при выплате'};
  }
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const debit=await db.query('UPDATE users SET seller_balance=seller_balance-$1,updated_at=NOW() WHERE telegram_id=$2 AND seller_balance >= $1 RETURNING seller_balance',[amount,req.user.telegram_id]);
    if(!debit.rowCount){await db.query('ROLLBACK');return res.status(400).json({error:'Недостаточно средств на балансе продавца.'});}
    const q=await db.query('INSERT INTO withdrawal_requests(seller_id,amount,method,payout_details) VALUES($1,$2,$3,$4) RETURNING id,created_at',[req.user.telegram_id,amount,method,payout]);
    await db.query('COMMIT');
    const id=q.rows[0].id;
    const methodName=method==='stars'?'Telegram Stars':method==='rub'?'Рубли':'Криптовалюта';
    const detailText=method==='stars'?`Количество: ${amount} ⭐ (1 ⭐ = 1 ₽)`:method==='rub'?`Канал: ${payout.channel==='phone'?'по номеру телефона':'электронный кошелёк'}\nРеквизиты: ${payout.value}\nБанк/сервис: ${payout.bank||'не указан'}`:`Актив: ${payout.asset}\nСеть: ${payout.network}\nАдрес: ${payout.address}\nСумма указана в рублях; криптоэквивалент рассчитывает владелец.`;
    const msg=`💸 Заявка на вывод средств #${id}\nПродавец: ${req.user.username?'@'+req.user.username:'без username'}\nTelegram ID: ${req.user.telegram_id}\nСумма: ${amount.toFixed(2)} ₽\nСпособ: ${methodName}\n${detailText}\nСтатус: ожидает решения`;
    await notifyOwner(msg);
    let groupNotified=true;
    try{await telegramRequest('sendMessage',{chat_id:WITHDRAWAL_GROUP_ID,text:msg,disable_web_page_preview:true});}
    catch(e){groupNotified=false;console.error('Withdrawal group notification failed:',e.message);}
    res.json({success:true,request_id:id,balance:Number(debit.rows[0].seller_balance),groupNotified,message:groupNotified?'Заявка отправлена владельцу и в группу.':'Заявка создана и отправлена владельцу, но сообщение в группу не доставлено. Проверьте, что бот добавлен в группу и может отправлять сообщения.'});
  }catch(e){await db.query('ROLLBACK');console.error('Withdrawal request:',e.message);res.status(503).json({error:'Не удалось создать заявку на вывод.'});}
  finally{db.release();}
});
app.get('/api/owner/withdrawals',roles('owner'),async(req,res)=>{
  try{
    const q=await pool.query(`SELECT w.*,u.username FROM withdrawal_requests w JOIN users u ON u.telegram_id=w.seller_id ORDER BY CASE WHEN w.status='pending' THEN 0 ELSE 1 END,w.created_at DESC LIMIT 100`);
    res.json(q.rows);
  }catch(e){res.status(503).json({error:'Не удалось загрузить заявки на вывод.'});}
});
app.post('/api/owner/withdrawals/:id/decision',roles('owner'),async(req,res)=>{
  const id=Number(req.params.id),decision=String(req.body?.decision||''),note=String(req.body?.note||'').trim().slice(0,500);
  if(!Number.isSafeInteger(id)||id<1||!['paid','rejected'].includes(decision))return res.status(400).json({error:'Некорректное решение по заявке.'});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const q=await db.query("SELECT * FROM withdrawal_requests WHERE id=$1 AND status='pending' FOR UPDATE",[id]);
    if(!q.rowCount){await db.query('ROLLBACK');return res.status(404).json({error:'Заявка уже обработана или не найдена.'});}
    const w=q.rows[0];
    if(decision==='rejected')await db.query('UPDATE users SET seller_balance=seller_balance+$1,updated_at=NOW() WHERE telegram_id=$2',[w.amount,w.seller_id]);
    await db.query('UPDATE withdrawal_requests SET status=$1,decided_at=NOW(),decided_by=$2,decision_note=$3 WHERE id=$4',[decision,req.user.telegram_id,note||null,id]);
    await db.query('COMMIT');
    const message=decision==='paid'?`Заявка на вывод #${id} отмечена как выплаченная.`:`Заявка на вывод #${id} отклонена. ${w.amount} ₽ возвращены на баланс продавца.${note?' Причина: '+note:''}`;
    await telegramRequest('sendMessage',{chat_id:String(w.seller_id),text:message}).catch(e=>console.error('Notify seller withdrawal:',e.message));
    res.json({success:true,status:decision});
  }catch(e){await db.query('ROLLBACK');console.error('Withdrawal decision:',e.message);res.status(503).json({error:'Не удалось обработать заявку.'});}
  finally{db.release();}
});

app.post('/api/buy',async(req,res)=>{
  const id=Number(req.body?.product_id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Неверный товар.'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const p=await c.query("SELECT id,seller_id,price,product_type,title,status,private_data FROM products WHERE id=$1 FOR UPDATE",[id]);
    if(!p.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Товар не найден.'});}
    const product=p.rows[0];
    if(product.status==='frozen'){await c.query('ROLLBACK');return res.status(409).json({error:'Товар временно заморожен и недоступен для покупки. Ожидается решение владельца.'});}
    if(product.status!=='active'){await c.query('ROLLBACK');return res.status(404).json({error:'Товар больше недоступен для покупки.'});}
    if(String(product.seller_id)===String(req.user.telegram_id)){await c.query('ROLLBACK');return res.status(400).json({error:'Нельзя купить собственный товар.'});}
    const type=product.product_type||'standard',quantity=['telegram_stars','robux'].includes(type)?Number(req.body?.quantity):1;
    if(type==='telegram_stars'&&(!Number.isInteger(quantity)||quantity<50||quantity>1000)){await c.query('ROLLBACK');return res.status(400).json({error:'Количество Telegram Stars должно быть от 50 до 1 000.'});}
    if(type==='robux'&&(!Number.isInteger(quantity)||quantity<10||quantity>100000)){await c.query('ROLLBACK');return res.status(400).json({error:'Количество Robux должно быть от 10 до 100 000.'});}
    const details=req.body?.details&&typeof req.body.details==='object'&&!Array.isArray(req.body.details)?req.body.details:{},clean={};
    if(type==='robux'||type==='roblox_account'){
      const telegram=String(details.telegram_username||'').trim().replace(/^@/,'');
      if(!/^[A-Za-z0-9_]{5,32}$/.test(telegram)){await c.query('ROLLBACK');return res.status(400).json({error:'Укажите свой Telegram username.'});}
      clean.telegram_username='@'+telegram;
    }
    if(type==='robux'){
      const username=String(details.roblox_username||'').trim();
      if(!/^[A-Za-z0-9_]{3,20}$/.test(username)){await c.query('ROLLBACK');return res.status(400).json({error:'Укажите корректный username аккаунта Roblox.'});}
      clean.roblox_username=username;clean.robux_quantity=quantity;
    }else if(type==='roblox_account'){
      if(!product.private_data?.data){await c.query('ROLLBACK');return res.status(409).json({error:'Продавец ещё не добавил данные аккаунта.'});}
    }else if(type==='channel_customization'){
      const owner=String(details.owner_username||'').trim().replace(/^@/,''),channel=String(details.channel_url||'').trim();
      if(!/^[A-Za-z0-9_]{5,32}$/.test(owner)||!/^https:\/\/(t\.me|telegram\.me)\//i.test(channel)||channel.length>300){
        await c.query('ROLLBACK');return res.status(400).json({error:'Укажите корректный Telegram username владельца и ссылку на канал.'});
      }
      clean.owner_username='@'+owner;clean.channel_url=channel;
    }else if(type==='telegram_stars'){
      const recipient=String(details.recipient_username||'').trim().replace(/^@/,'');
      if(!/^[A-Za-z0-9_]{5,32}$/.test(recipient)){await c.query('ROLLBACK');return res.status(400).json({error:'Укажите Telegram username получателя звёзд.'});}
      clean.recipient_username='@'+recipient;clean.quantity=quantity;
    }else if(type==='subscription'||type==='loyalty_points'){
      const account=String(details.account||'').trim().slice(0,120);
      if(account.length<3){await c.query('ROLLBACK');return res.status(400).json({error:'Укажите аккаунт, номер телефона или идентификатор для зачисления.'});}
      clean.account=account;
    }
    const amount=Math.round(Number(product.price)*quantity*100)/100;
    if(!Number.isFinite(amount)||amount<=0||amount>1e7){await c.query('ROLLBACK');return res.status(400).json({error:'Итоговая стоимость заказа превышает допустимое значение.'});}
    const fee=Math.round(amount*3)/100,sellerAmount=Math.round((amount-fee)*100)/100;
    const debit=await c.query('UPDATE users SET balance=balance-$1,updated_at=NOW() WHERE telegram_id=$2 AND balance >= $1 RETURNING telegram_id',[amount,req.user.telegram_id]);
    if(!debit.rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'Недостаточно средств на балансе.'});}
    await c.query('UPDATE users SET seller_balance=seller_balance+$1,updated_at=NOW() WHERE telegram_id=$2',[sellerAmount,product.seller_id]);
    await c.query('UPDATE shop_wallet SET balance=balance+$1,updated_at=NOW() WHERE id=1',[fee]);
    const order=await c.query("INSERT INTO orders (buyer_id,seller_id,product_id,amount,commission,status,buyer_details) VALUES ($1,$2,$3,$4,$5,'paid',$6) RETURNING id",
      [req.user.telegram_id,product.seller_id,id,amount,fee,clean]);
    await c.query('INSERT INTO shop_ledger(amount,kind,reference,description) VALUES($1,\'commission\',$2,$3)',[fee,'order_'+order.rows[0].id+'_fee','Комиссия 3% по заказу #'+order.rows[0].id]);
    const ref='order_'+order.rows[0].id;
    await c.query("INSERT INTO transactions (telegram_id,amount,type,reference,description) VALUES ($1,$2,'purchase',$3,$4),($5,$6,'sale',$7,$8)",
      [req.user.telegram_id,-amount,ref,'Покупка товара #'+order.rows[0].id,product.seller_id,sellerAmount,ref+'_seller','Продажа товара #'+order.rows[0].id]);
    if(type==='roblox_account')await c.query("UPDATE products SET status='sold' WHERE id=$1",[id]);
    await c.query('COMMIT');
    const info=Object.entries(clean).map(([k,v])=>k+': '+v).join('\n');
    const sellerMessage='🛒 Новый оплаченный заказ #'+order.rows[0].id+'\nТовар: '+product.title+'\nСумма: '+amount.toFixed(2)+' ₽\nПокупатель: '+(req.user.username?'@'+req.user.username:'без username')+(info?'\nДанные покупателя:\n'+info:'');
    telegramRequest('sendMessage',{chat_id:String(product.seller_id),text:sellerMessage.slice(0,3500)}).catch(e=>console.error('Seller order notification:',e.message));
    res.json({success:true,message:'Покупка успешно совершена!',order_id:order.rows[0].id,total:amount,quantity});
  }catch(e){await c.query('ROLLBACK');console.error('Purchase:',e.message);res.status(503).json({error:'Не удалось оформить заказ.'});}
  finally{c.release();}
});
app.get('/api/orders/:id/delivery',async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Неверный номер заказа.'});
  try{
    const q=await pool.query("SELECT o.id,o.buyer_id,o.status,p.product_type,p.private_data FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=$1 AND o.buyer_id=$2",[id,req.user.telegram_id]);
    if(!q.rowCount)return res.status(404).json({error:'Заказ не найден.'});
    const row=q.rows[0];if(!['paid','delivered','completed'].includes(row.status))return res.status(409).json({error:'Данные заказа пока недоступны.'});
    if(row.product_type!=='roblox_account')return res.json({success:true,delivery:null});
    const d=decryptPrivateData(row.private_data);
    res.json({success:true,delivery:{roblox_username:d.roblox_username,account_email:d.account_email,account_password:d.account_password,email_password:d.email_password}});
  }catch(e){console.error('Order delivery:',e.message);res.status(503).json({error:'Не удалось получить данные покупки. Обратитесь в поддержку.'});}
});


const USDT_TON_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const tonAddress = process.env.TON_WALLET_ADDRESS || '';
const appOrigin = process.env.APP_ORIGIN || '';
function safeEqual(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length===y.length && crypto.timingSafeEqual(x,y);
}
function cents(value) { return Math.round(Number(value) * 100); }
function decimalToUnits(value, decimals) {
  const s=String(value), parts=s.split('.');
  return BigInt(parts[0]||'0')*(10n**BigInt(decimals))+BigInt(((parts[1]||'')+'0'.repeat(decimals)).slice(0,decimals)||'0');
}
function unitsToDecimal(value, decimals) {
  const n=BigInt(value), base=10n**BigInt(decimals);
  return (n/base).toString()+'.'+(n%base).toString().padStart(decimals,'0');
}
function normalizeTonAddress(value) {
  if (!value || typeof value !== 'string') return '';
  if (/^-?\d+:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const b=Buffer.from(value.replace(/-/g,'+').replace(/_/g,'/'),'base64');
    if (b.length!==36) return '';
    return b.readInt8(1)+':'+b.subarray(2,34).toString('hex');
  } catch { return ''; }
}
function decodedTonComment(value, depth=0) {
  if (!value || depth>6) return '';
  if (Array.isArray(value)) {
    for (const item of value) { const found=decodedTonComment(item,depth+1); if(found) return found; }
    return '';
  }
  if (typeof value !== 'object') return '';
  if (typeof value.comment === 'string') return value.comment;
  if ((value.type==='text_comment'||value.type==='text') && typeof value.text==='string') return value.text;
  for (const key of ['forward_payload','decoded','message_content','payload']) {
    const found=decodedTonComment(value[key],depth+1);
    if(found) return found;
  }
  return '';
}
async function notifyOwner(text) {
  try { await telegramRequest('sendMessage',{chat_id:OWNER_TELEGRAM_ID,text:String(text).slice(0,3500)}); }
  catch(e) { console.error('Owner notification failed:',e.message); }
}
async function notifyModerators(text) {
  await notifyOwner(text);
  try {
    const q=await pool.query("SELECT telegram_id FROM users WHERE role='support' AND is_banned=FALSE");
    await Promise.all(q.rows.map(u=>telegramRequest('sendMessage',{chat_id:String(u.telegram_id),text:String(text).slice(0,3500)}).catch(e=>console.error('Support notification:',e.message))));
  } catch(e) { console.error('Moderator notification failed:',e.message); }
}
async function telegramRequest(method, params={}) {
  const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params), signal: AbortSignal.timeout(12000)
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error('Telegram Bot API ' + method + ' failed: ' + (data.description || r.status));
  return data.result;
}
async function registerTelegramWebhook() {
  if (!appOrigin || !process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.warn('Telegram webhook not registered: APP_ORIGIN or TELEGRAM_WEBHOOK_SECRET is missing');
    return;
  }
  const url = new URL('/webhooks/telegram', appOrigin).toString();
  await telegramRequest('setWebhook', {
    url, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'pre_checkout_query'], drop_pending_updates: false
  });
  await telegramRequest('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Открыть магазин', web_app: { url: appOrigin } }
  });
  console.log('Telegram Mini App menu and payment webhook configured');
}
async function cryptoPay(method, params={}) {
  if (!process.env.CRYPTO_PAY_API_TOKEN) throw new Error('Crypto Pay API token is not configured');
  const r=await fetch('https://pay.crypt.bot/api/'+method,{
    method:'POST',headers:{'Content-Type':'application/json','Crypto-Pay-API-Token':process.env.CRYPTO_PAY_API_TOKEN},
    body:JSON.stringify(params),signal:AbortSignal.timeout(12000)
  });
  const data=await r.json();
  if(!r.ok||!data.ok) throw new Error('Crypto Pay API request failed: '+(data.error||r.status));
  return data.result;
}
async function rollyRequest(method,path,body) {
  if(!process.env.ROLLYPAY_API_KEY) throw new Error('RollyPay API key is not configured');
  const headers={'X-API-Key':process.env.ROLLYPAY_API_KEY,'X-Nonce':crypto.randomUUID()};
  const options={method,headers,signal:AbortSignal.timeout(12000)};
  if(body){headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  const r=await fetch('https://rollypay.io/api/v1'+path,options),data=await r.json();
  if(!r.ok) throw new Error('RollyPay API request failed: '+(data.error||r.status));
  return data;
}
async function tonApi(path,params={}) {
  const url=new URL('https://toncenter.com/api/v3'+path);
  for(const [k,v] of Object.entries(params)) if(v!==undefined&&v!==null&&v!=='') url.searchParams.set(k,String(v));
  const headers={};if(process.env.TONCENTER_API_KEY)headers['X-API-Key']=process.env.TONCENTER_API_KEY;
  const r=await fetch(url,{headers,signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error('TON indexer request failed: '+r.status);
  return r.json();
}
async function getTonRate(asset) {
  const rates=await cryptoPay('getExchangeRates');
  const row=rates.find(x=>x.source===asset&&x.target==='RUB'&&x.is_valid===true);
  const rate=Number(row?.rate);
  if(!Number.isFinite(rate)||rate<=0)throw new Error('Актуальный курс '+asset+'/RUB временно недоступен.');
  return rate;
}
async function finalizePayment(paymentId,provider,txHash=null) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const q=await c.query('SELECT * FROM payments WHERE id=$1 AND provider=$2 FOR UPDATE',[paymentId,provider]);
    if(!q.rowCount){await c.query('ROLLBACK');return false;}
    const p=q.rows[0];
    if(p.status==='paid'){await c.query('ROLLBACK');return true;}
    if(p.status!=='pending'){await c.query('ROLLBACK');return false;}
    if(txHash){
      const duplicate=await c.query('SELECT id FROM payments WHERE tx_hash=$1 AND id<>$2',[txHash,paymentId]);
      if(duplicate.rowCount){await c.query('ROLLBACK');return false;}
    }
    await c.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2',[p.amount,p.telegram_id]);
    await c.query("INSERT INTO transactions (telegram_id,amount,type,reference,description) VALUES ($1,$2,'topup',$3,$4)",
      [p.telegram_id,p.amount,'topup_pay_'+p.id,'Пополнение через '+provider+(p.asset?' ('+p.asset+')':'')]);
    await c.query("UPDATE payments SET status='paid',paid_at=NOW(),tx_hash=COALESCE($1,tx_hash) WHERE id=$2",[txHash,paymentId]);
    await c.query('COMMIT');return true;
  } catch(e){await c.query('ROLLBACK');throw e;}
  finally{c.release();}
}
async function handleCryptoPayWebhook(req,res) {
  const secret=process.env.CRYPTO_PAY_WEBHOOK_SECRET,token=process.env.CRYPTO_PAY_API_TOKEN;
  if(!secret||!token||!safeEqual(req.params.secret,secret))return res.sendStatus(404);
  if(!Buffer.isBuffer(req.body))return res.sendStatus(400);
  const signature=req.get('crypto-pay-api-signature')||'';
  const key=crypto.createHash('sha256').update(token).digest();
  const expected=crypto.createHmac('sha256',key).update(req.body).digest('hex');
  if(!safeEqual(signature,expected))return res.sendStatus(403);
  const update=JSON.parse(req.body.toString('utf8'));
  if(update.update_type!=='invoice_paid')return res.sendStatus(200);
  const invoice=update.payload||{},payload=JSON.parse(invoice.payload||'{}'),paymentId=Number(payload.payment_id);
  if(!Number.isSafeInteger(paymentId)||paymentId<1||!invoice.invoice_id)return res.sendStatus(400);
  const local=await pool.query("SELECT * FROM payments WHERE id=$1 AND provider='cryptobot'",[paymentId]);
  if(!local.rowCount)return res.sendStatus(404);
  const p=local.rows[0];
  if(String(p.provider_payment_id)!==String(invoice.invoice_id)||String(payload.user_id)!==String(p.telegram_id)||invoice.status!=='paid'||
    invoice.currency_type!=='fiat'||invoice.fiat!=='RUB'||!['TON','USDT'].includes(invoice.paid_asset)||cents(invoice.amount)!==cents(p.amount))return res.sendStatus(409);
  const verified=await cryptoPay('getInvoices',{invoice_ids:String(invoice.invoice_id)});
  const remote=Array.isArray(verified)?verified.find(x=>String(x.invoice_id)===String(invoice.invoice_id)):null;
  if(!remote||remote.status!=='paid'||remote.currency_type!=='fiat'||remote.fiat!=='RUB'||!['TON','USDT'].includes(remote.paid_asset)||cents(remote.amount)!==cents(p.amount))return res.sendStatus(409);
  await finalizePayment(paymentId,'cryptobot');res.sendStatus(200);
}
async function handleRollyPayWebhook(req,res) {
  const secret=process.env.ROLLYPAY_WEBHOOK_SECRET;
  if(!secret||!Buffer.isBuffer(req.body))return res.sendStatus(404);
  const signature=req.get('x-signature')||'',timestamp=req.get('x-timestamp')||'',ts=Number(timestamp);
  if(!/^\d{10}$/.test(timestamp)||!Number.isFinite(ts))return res.sendStatus(403);
  if(Math.abs(Date.now()/1000-ts)>300)return res.sendStatus(403);
  const expected=crypto.createHmac('sha256',secret).update(timestamp+'.').update(req.body).digest('hex');
  if(!safeEqual(signature,expected))return res.sendStatus(403);
  const event=JSON.parse(req.body.toString('utf8'));
  if(event.event_type!=='payment.paid'||event.status!=='paid')return res.sendStatus(200);
  const match=/^wts_(\d+)$/.exec(String(event.order_id||''));
  if(!match||!event.payment_id)return res.sendStatus(400);
  const paymentId=Number(match[1]);
  const local=await pool.query('SELECT * FROM payments WHERE id=$1 AND provider IN ($2,$3)',[paymentId,'sbp','card']);
  if(!local.rowCount)return res.sendStatus(404);
  const p=local.rows[0];
  if(String(p.provider_payment_id)!==String(event.payment_id)||cents(event.amount)!==cents(p.amount))return res.sendStatus(409);
  const remote=await rollyRequest('GET','/payments/'+encodeURIComponent(event.payment_id));
  if(remote.status!=='paid'||String(remote.order_id)!==String(event.order_id)||cents(remote.amount)!==cents(p.amount)||
    (remote.payment_currency||'RUB')!=='RUB')return res.sendStatus(409);
  await finalizePayment(paymentId,p.provider);res.sendStatus(200);
}
async function createPayment(req,res) {
  let pendingPaymentId=null;
  const amount=money(req.body?.amount),method=String(req.body?.method||'');
  if(!amount||amount<10)return res.status(400).json({error:'Минимальная сумма пополнения — 10 ₽.'});
  if(!['cryptobot','direct_transfer','telegram_stars'].includes(method))return res.status(400).json({error:'Этот способ оплаты отключён или неизвестен.'});
  try {
    if(method==='telegram_stars'){
      if(!Number.isInteger(amount))return res.status(400).json({error:'Для оплаты Stars укажите целую сумму в рублях.'});
      if(!process.env.TELEGRAM_WEBHOOK_SECRET||!appOrigin)return res.status(503).json({error:'Оплата Telegram Stars ещё не настроена.'});
      const row=await pool.query("INSERT INTO payments(provider,telegram_id,amount,currency,status,idempotency_key,expires_at) VALUES ('telegram_stars',$1,$2,'XTR','pending',$3,NOW()+INTERVAL '15 minutes') RETURNING id",
        [req.user.telegram_id,amount,crypto.randomUUID()]);
      pendingPaymentId=row.rows[0].id;
      const invoicePayload='wts_stars_'+row.rows[0].id+'_'+crypto.randomBytes(8).toString('hex');
      await pool.query('UPDATE payments SET provider_payload=$1 WHERE id=$2',
        [JSON.stringify({invoice_payload:invoicePayload,stars:amount}),row.rows[0].id]);
      const invoiceLink=await telegramRequest('createInvoiceLink',{
        title:'Пополнение баланса',
        description:'Пополнение баланса WORLD TG SHOP на '+amount+' ₽',
        payload:invoicePayload,
        currency:'XTR',
        prices:[{label:'Пополнение баланса ('+amount+' ₽)',amount}],
      });
      return res.json({invoiceLink,paymentId:row.rows[0].id,stars:amount});
    }
    if(method==='cryptobot'){
      if(!process.env.CRYPTO_PAY_API_TOKEN)return res.status(503).json({error:'Не задан CRYPTO_PAY_API_TOKEN в настройках сервера.'});
      const row=await pool.query("INSERT INTO payments(provider,telegram_id,amount,currency,status,idempotency_key,expires_at) VALUES ('cryptobot',$1,$2,'RUB','pending',$3,NOW()+INTERVAL '15 minutes') RETURNING id",
        [req.user.telegram_id,amount,crypto.randomUUID()]);
      pendingPaymentId=row.rows[0].id;
      const invoice=await cryptoPay('createInvoice',{
        currency_type:'fiat',fiat:'RUB',amount:amount.toFixed(2),accepted_assets:'USDT,TON',
        description:'Пополнение баланса WORLD TG SHOP',
        payload:JSON.stringify({payment_id:row.rows[0].id,user_id:String(req.user.telegram_id)}),
        allow_comments:false,allow_anonymous:false,expires_in:900
      });
      await pool.query('UPDATE payments SET provider_payment_id=$1,provider_payload=$2 WHERE id=$3',
        [String(invoice.invoice_id),JSON.stringify({bot_invoice_url:invoice.bot_invoice_url}),row.rows[0].id]);
      return res.json({paymentUrl:invoice.bot_invoice_url,paymentId:row.rows[0].id});
    }
    if(method==='sbp'||method==='card'){
      if(!process.env.ROLLYPAY_API_KEY)return res.status(503).json({error:'Не задан ROLLYPAY_API_KEY в настройках сервера.'});
      const row=await pool.query("INSERT INTO payments(provider,telegram_id,amount,currency,status,idempotency_key,expires_at) VALUES ($1,$2,$3,'RUB','pending',$4,NOW()+INTERVAL '30 minutes') RETURNING id",
        [method,req.user.telegram_id,amount,crypto.randomUUID()]);
      pendingPaymentId=row.rows[0].id;
      const body={amount:amount.toFixed(2),payment_currency:'RUB',payment_method:method,
        order_id:'wts_'+row.rows[0].id,description:'Пополнение баланса WORLD TG SHOP',customer_id:String(req.user.telegram_id)};
      if(appOrigin){const returnUrl=new URL(appOrigin);returnUrl.searchParams.set('payment_id',String(row.rows[0].id));body.success_redirect_url=returnUrl.toString();body.fail_redirect_url=returnUrl.toString();}
      const result=await rollyRequest('POST','/payments',body);
      if(!result.payment_id||!result.pay_url)throw new Error('RollyPay не вернул ссылку на оплату.');
      await pool.query('UPDATE payments SET provider_payment_id=$1,provider_payload=$2 WHERE id=$3',
        [String(result.payment_id),JSON.stringify({pay_url:result.pay_url}),row.rows[0].id]);
      return res.json({paymentUrl:result.pay_url,paymentId:row.rows[0].id});
    }
    const asset=String(req.body?.asset||'').toUpperCase();
    if(!['TON','USDT'].includes(asset))return res.status(400).json({error:'Выберите TON или USDT.'});
    if(!process.env.CRYPTO_PAY_API_TOKEN)return res.status(503).json({error:'Курс TON/USDT временно недоступен.'});
    if(!tonAddress||!normalizeTonAddress(tonAddress))return res.status(503).json({error:'TON-кошелёк магазина не настроен.'});
    const rate=await getTonRate(asset),decimals=asset==='TON'?9:6;
    const rawBase=BigInt(Math.ceil((amount/rate)*Number(10n**BigInt(decimals))));
    if(rawBase<=0n)throw new Error('Не удалось рассчитать сумму в криптовалюте.');
    const row=await pool.query("INSERT INTO payments(provider,telegram_id,amount,currency,status,idempotency_key,asset,wallet_address,expires_at) VALUES ('ton_usdt',$1,$2,'RUB','pending',$3,$4,$5,NOW()+INTERVAL '20 minutes') RETURNING id",
      [req.user.telegram_id,amount,crypto.randomUUID(),asset,tonAddress]);
    pendingPaymentId=row.rows[0].id;
    const paymentComment='WTS-'+row.rows[0].id+'-'+crypto.randomBytes(4).toString('hex').toUpperCase();
    let cryptoAmount, saved=false;
    for(let attempt=0;attempt<12&&!saved;attempt++){
      const rawAmount=rawBase+BigInt(crypto.randomInt(1,1000));
      cryptoAmount=unitsToDecimal(rawAmount,decimals);
      try{
        await pool.query('UPDATE payments SET expected_crypto=$1,provider_payload=$2 WHERE id=$3',
          [cryptoAmount,JSON.stringify({rate,decimals,comment:paymentComment}),row.rows[0].id]);
        saved=true;
      }catch(e){if(e.code!=='23505')throw e;}
    }
    if(!saved){
      await pool.query("UPDATE payments SET status='failed' WHERE id=$1",[row.rows[0].id]);
      throw new Error('Could not reserve a unique crypto amount for this invoice');
    }
    const transferParams=new URLSearchParams({
      amount:decimalToUnits(cryptoAmount,decimals).toString(),
      text:paymentComment
    });
    if(asset==='USDT')transferParams.set('jetton',USDT_TON_MASTER);
    const transferUri='ton://transfer/'+encodeURIComponent(tonAddress)+'?'+transferParams.toString();
    return res.json({directTransfer:true,paymentId:row.rows[0].id,asset,cryptoAmount,walletAddress:tonAddress,
      comment:paymentComment,transferUri,jettonMaster:USDT_TON_MASTER,
      expiresAt:new Date(Date.now()+20*60*1000).toISOString(),rate});
  } catch(e){
    if(pendingPaymentId)await pool.query("UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'",[pendingPaymentId]).catch(()=>{});
    console.error('Payment create ('+method+'):',e.message);
    return res.status(503).json({error:'Провайдер отклонил создание платежа: '+String(e.message||'ошибка сервера').slice(0,180)});
  }
}
async function paymentStatus(req,res) {
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Неверный номер платежа.'});
  try {
    const r=await pool.query('SELECT id,status,provider,provider_payment_id,provider_payload,telegram_id,amount,currency,asset,expected_crypto,expires_at FROM payments WHERE id=$1 AND telegram_id=$2',[id,req.user.telegram_id]);
    if(!r.rowCount)return res.status(404).json({error:'Платёж не найден.'});
    let p=r.rows[0];
    // Вебхук может задержаться или быть не настроен. Подтверждаем оплату напрямую у провайдера.
    if(p.status==='pending'&&p.provider_payment_id){
      try{
        if(p.provider==='cryptobot'&&process.env.CRYPTO_PAY_API_TOKEN){
          const list=await cryptoPay('getInvoices',{invoice_ids:String(p.provider_payment_id)});
          const remote=Array.isArray(list)?list.find(x=>String(x.invoice_id)===String(p.provider_payment_id)):null;
          const payload=remote?.payload?JSON.parse(remote.payload):{};
          if(remote?.status==='paid'&&remote.currency_type==='fiat'&&remote.fiat==='RUB'&&
             ['TON','USDT'].includes(remote.paid_asset)&&cents(remote.amount)===cents(p.amount)&&
             String(payload.user_id)===String(p.telegram_id)&&Number(payload.payment_id)===Number(p.id)){
            await finalizePayment(p.id,'cryptobot');
          }
        }else if(['sbp','card'].includes(p.provider)&&process.env.ROLLYPAY_API_KEY){
          const remote=await rollyRequest('GET','/payments/'+encodeURIComponent(p.provider_payment_id));
          if(remote.status==='paid'&&String(remote.order_id)==='wts_'+p.id&&
             cents(remote.amount)===cents(p.amount)&&(remote.payment_currency||'RUB')==='RUB'){
            await finalizePayment(p.id,p.provider);
          }
        }
      }catch(providerError){console.warn('Payment status reconciliation ('+p.provider+'): '+providerError.message);}
      const refreshed=await pool.query('SELECT status FROM payments WHERE id=$1',[id]);
      if(refreshed.rowCount)p.status=refreshed.rows[0].status;
    }
    if(p.status==='pending'&&p.expires_at&&new Date(p.expires_at).getTime()+5*60*1000<Date.now()) {
      await pool.query("UPDATE payments SET status='expired' WHERE id=$1 AND status='pending'",[id]);
      p.status='expired';
    }
    res.json({paymentId:p.id,status:p.status,amount:p.amount,currency:p.currency,asset:p.asset,cryptoAmount:p.expected_crypto,expiresAt:p.expires_at});
  } catch(e) { console.error('Payment status:',e.message); res.status(503).json({error:'Не удалось проверить статус платежа.'}); }
}
let tonPollBusy=false;
async function pollTonPayments() {
  if(tonPollBusy||!tonAddress||!process.env.CRYPTO_PAY_API_TOKEN)return;
  tonPollBusy=true;
  try {
    await pool.query("UPDATE payments SET status='expired' WHERE provider='ton_usdt' AND status='pending' AND expires_at<NOW()-INTERVAL '5 minutes'");
    const pending=await pool.query("SELECT id,asset,amount,expected_crypto,wallet_address,provider_payload,created_at,expires_at FROM payments WHERE provider='ton_usdt' AND status='pending' AND expires_at>NOW()-INTERVAL '5 minutes' ORDER BY created_at ASC LIMIT 500");
    if(!pending.rowCount)return;
    const byAsset={TON:[],USDT:[]};
    for(const p of pending.rows)if(byAsset[p.asset])byAsset[p.asset].push(p);
    for(const asset of ['TON','USDT']){
      const list=byAsset[asset];if(!list.length)continue;
      const start=Math.max(0,Math.floor(new Date(list[0].created_at).getTime()/1000)-60);
      let candidates=[];
      if(asset==='TON'){
        const data=await tonApi('/transactions',{account:tonAddress,start_utime:start,limit:1000,sort:'desc'});
        const expectedRaw=new Set(list.map(p=>decimalToUnits(p.expected_crypto,9).toString()));
        candidates=(data.transactions||[]).filter(tx=>{
          const msg=tx.in_msg||{};
          return expectedRaw.has(String(msg.value||'0'))&&Number(tx.mc_block_seqno)>0&&msg.destination&&normalizeTonAddress(msg.destination)===normalizeTonAddress(tonAddress)&&
            BigInt(msg.value||'0')>0n&&tx.description?.aborted!==true;
        }).map(tx=>({raw:BigInt(tx.in_msg.value),hash:String(tx.hash),utime:Number(tx.now||tx.utime||0),
          comment:decodedTonComment(tx.in_msg?.message_content?.decoded)||decodedTonComment(tx.in_msg?.message_content)}));
      }else{
        const data=await tonApi('/jetton/transfers',{owner_address:tonAddress,jetton_master:USDT_TON_MASTER,direction:'in',start_utime:start,limit:1000,sort:'desc'});
        const expectedRaw=new Set(list.map(p=>decimalToUnits(p.expected_crypto,6).toString()));
        for(const t of data.jetton_transfers||[]){
          if(!expectedRaw.has(String(t.amount))||t.transaction_aborted===true||normalizeTonAddress(t.destination)!==normalizeTonAddress(tonAddress)||
            normalizeTonAddress(t.jetton_master)!==normalizeTonAddress(USDT_TON_MASTER))continue;
          const txData=await tonApi('/transactions',{hash:t.transaction_hash,limit:1}),tx=(txData.transactions||[])[0];
          if(!tx||Number(tx.mc_block_seqno)<=0||tx.description?.aborted===true)continue;
          const comment=decodedTonComment(t.decoded_forward_payload)||decodedTonComment(tx.in_msg?.message_content?.decoded)||
            decodedTonComment(tx.in_msg?.message_content)||(typeof t.comment==='string'?t.comment:'');
          candidates.push({raw:BigInt(t.amount),hash:String(t.transaction_hash),utime:Number(t.transaction_now||tx.now||0),comment});
        }
      }
      for(const p of list){
        const expected=decimalToUnits(p.expected_crypto,asset==='TON'?9:6);
        const requiredComment=p.provider_payload?.comment;
        const match=candidates.find(t=>t.raw===expected&&t.utime>=Math.floor(new Date(p.created_at).getTime()/1000)-60&&
          t.utime<=Math.floor(new Date(p.expires_at).getTime()/1000)+300&&(!requiredComment||t.comment===requiredComment));
        if(match)await finalizePayment(p.id,'ton_usdt',match.hash);
      }
    }
  }catch(e){console.error('TON monitor:',e.message);}
  finally{tonPollBusy=false;}
}
app.post('/api/payment/manual-transfer',async(req,res)=>{
  const amount=money(req.body?.amount);
  if(!amount||amount<10)return res.status(400).json({error:'Минимальная сумма пополнения — 10 ₽.'});
  try{
    const owner=await pool.query('SELECT username FROM users WHERE telegram_id=$1 LIMIT 1',[OWNER_TELEGRAM_ID]);
    const username=String(process.env.OWNER_TELEGRAM_USERNAME||owner.rows[0]?.username||'').replace(/^@/,'');
    if(!/^[A-Za-z0-9_]{5,32}$/.test(username))return res.status(503).json({error:'Не настроен Telegram username владельца.'});
    const message='Здравствуйте! Хочу пополнить баланс WORLD TG SHOP переводом на карту. Сумма: '+amount.toFixed(2)+' ₽.';
    const url='https://t.me/'+username+'?text='+encodeURIComponent(message);
    res.json({url,username:'@'+username,message});
  }catch(e){console.error('Manual transfer link:',e.message);res.status(503).json({error:'Не удалось открыть чат владельца. Попробуйте позже.'});}
});
app.post('/api/payment/create',createPayment);
app.get('/api/payment/status/:id',paymentStatus);

app.post('/api/orders/:id/refund',roles('owner','support'),async(req,res)=>{
  const orderId=Number(req.params.id),reason=String(req.body?.reason||'Возврат по обращению покупателя').slice(0,500);
  if(!Number.isSafeInteger(orderId)||orderId<1)return res.status(400).json({error:'Неверный номер заказа.'});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const q=await db.query("SELECT o.*,p.title,p.seller_id AS product_seller,p.status AS product_status FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=$1 FOR UPDATE OF o,p",[orderId]);
    if(!q.rowCount){await db.query('ROLLBACK');return res.status(404).json({error:'Заказ не найден.'});}
    const o=q.rows[0];
    if(o.status==='refunded'){await db.query('ROLLBACK');return res.status(400).json({error:'Этот заказ уже возвращён.'});}
    if(!['paid','delivered','completed','disputed'].includes(o.status)){await db.query('ROLLBACK');return res.status(400).json({error:'Текущий статус заказа не позволяет оформить возврат.'});}
    const sellerShare=Number(o.amount)-Number(o.commission);
    const sellerDebit=await db.query('UPDATE users SET seller_balance=seller_balance-$1,updated_at=NOW() WHERE telegram_id=$2 AND seller_balance >= $1 RETURNING telegram_id',[sellerShare,o.seller_id]);
    if(!sellerDebit.rowCount){await db.query('ROLLBACK');return res.status(409).json({error:'У продавца недостаточно средств для возврата. Требуется ручное решение владельца.'});}
    if(Number(o.commission)>0){
      const feeDebit=await db.query('UPDATE shop_wallet SET balance=balance-$1,updated_at=NOW() WHERE id=1 AND balance >= $1 RETURNING id',[o.commission]);
      if(!feeDebit.rowCount){await db.query('ROLLBACK');return res.status(409).json({error:'В отдельном балансе магазина недостаточно средств для возврата комиссии. Требуется решение владельца.'});}
    }
    await db.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2',[o.amount,o.buyer_id]);
    await db.query("UPDATE orders SET status='refunded' WHERE id=$1",[orderId]);
    await db.query("UPDATE products SET status=CASE WHEN status IN ('deleted','frozen') THEN status ELSE 'active' END WHERE id=$1",[o.product_id]);
    const rf=await db.query('INSERT INTO order_refunds(order_id,refunded_by,amount,reason) VALUES ($1,$2,$3,$4) RETURNING id',[orderId,req.user.telegram_id,o.amount,reason]);
    const ref='refund_'+rf.rows[0].id;
    await db.query("INSERT INTO transactions(telegram_id,amount,type,reference,description) VALUES ($1,$2,'refund',$3,$4),($5,$6,'admin_adjustment',$7,$8)",
      [o.buyer_id,o.amount,ref+'_buyer','Возврат за заказ #'+orderId+' — '+o.title,o.seller_id,-sellerShare,ref+'_seller','Списание средств с баланса продавца при возврате заказа #'+orderId]);
    if(Number(o.commission)>0)await db.query("INSERT INTO shop_ledger(amount,kind,reference,description) VALUES($1,'refund',$2,$3)",[Number(o.commission),'refund_'+rf.rows[0].id+'_fee','Возврат комиссии по заказу #'+orderId]);
    await db.query('COMMIT');
    res.json({success:true,refund_id:rf.rows[0].id,amount:Number(o.amount),message:'Возврат зачислен покупателю, товар возвращён продавцу.'});
  }catch(e){await db.query('ROLLBACK');console.error('Refund:',e.message);res.status(503).json({error:'Не удалось оформить возврат.'});}
  finally{db.release();}
});

app.get('/api/support/user/:id',roles('owner','support','admin'),async(req,res)=>{
  const id=String(req.params.id||'');if(!/^\d{1,20}$/.test(id))return res.status(400).json({error:'Некорректный Telegram ID.'});
  try{
    const [u,ledger,purchases,sales,transfers]=await Promise.all([
      pool.query('SELECT telegram_id,username,role,balance,is_banned,banned_until,banned_reason,created_at FROM users WHERE telegram_id=$1',[id]),
      pool.query('SELECT amount,type,description,created_at FROM transactions WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 200',[id]),
      pool.query(`SELECT o.id,o.amount,o.status,o.created_at,p.title,COALESCE(s.display_name,s.username,'Продавец') AS store_name FROM orders o JOIN products p ON p.id=o.product_id JOIN users s ON s.telegram_id=o.seller_id WHERE o.buyer_id=$1 ORDER BY o.created_at DESC LIMIT 100`,[id]),
      pool.query(`SELECT o.id,o.amount,o.status,o.created_at,p.title,COALESCE(b.display_name,b.username,'Покупатель') AS buyer_name FROM orders o JOIN products p ON p.id=o.product_id JOIN users b ON b.telegram_id=o.buyer_id WHERE o.seller_id=$1 ORDER BY o.created_at DESC LIMIT 100`,[id]),
      pool.query('SELECT id,amount,status,created_at,recipient_id,sender_id FROM balance_transfer_codes WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at DESC LIMIT 100',[id])
    ]);
    if(!u.rowCount)return res.status(404).json({error:'Пользователь не найден.'});
    res.json({user:u.rows[0],transactions:ledger.rows,purchases:purchases.rows,sales:sales.rows,transfers:transfers.rows});
  }catch(e){console.error('User stats:',e.message);res.status(503).json({error:'Не удалось загрузить статистику пользователя.'});}
});
app.get('/api/moderation/pending',roles('owner','support'),async(req,res)=>{
  try{
    const q=await pool.query(`SELECT m.*,u.username AS requester_name,p.title AS product_title
      FROM moderation_requests m LEFT JOIN users u ON u.telegram_id=m.requested_by LEFT JOIN products p ON p.id=m.product_id
      WHERE m.status='pending' ORDER BY m.created_at ASC LIMIT 100`);
    res.json(q.rows);
  }catch(e){res.status(503).json({error:'Не удалось загрузить заявки.'});}
});
app.post('/api/moderation/decision',roles('owner','support'),async(req,res)=>{
  const id=Number(req.body?.request_id),decision=String(req.body?.decision||''),note=String(req.body?.note||'').slice(0,500);
  if(!Number.isSafeInteger(id)||id<1||!['approve','reject'].includes(decision))return res.status(400).json({error:'Проверьте заявку и решение.'});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const q=await db.query("SELECT * FROM moderation_requests WHERE id=$1 AND status='pending' FOR UPDATE",[id]);
    if(!q.rowCount){await db.query('ROLLBACK');return res.status(404).json({error:'Заявка уже обработана или не найдена.'});}
    const m=q.rows[0],approved=decision==='approve';
    if(m.kind==='ban'&&req.user.role!=='owner'){await db.query('ROLLBACK');return res.status(403).json({error:'Запросы на блокировку подтверждает только владелец.'});}
    if(m.kind==='product_delete'&&req.user.role!=='owner'){await db.query('ROLLBACK');return res.status(403).json({error:'Запросы на удаление товаров подтверждает только владелец.'});}
    if(m.kind==='product'){
      await db.query('UPDATE products SET status=$1 WHERE id=$2 AND status=\'pending\'',[approved?'active':'rejected',m.product_id]);
    }else if(m.kind==='product_delete'){
      const changed=await db.query("UPDATE products SET status=$1 WHERE id=$2 AND status='frozen' RETURNING id",[approved?'deleted':'active',m.product_id]);
      if(!changed.rowCount){await db.query('ROLLBACK');return res.status(409).json({error:'Товар уже изменил статус. Обновите список заявок.'});}
    }else if(m.kind==='ban'&&approved){
      const until=m.duration_hours?new Date(Date.now()+m.duration_hours*3600000):null;
      await db.query('UPDATE users SET is_banned=TRUE,banned_until=$1,banned_reason=$2,updated_at=NOW() WHERE telegram_id=$3',[until,m.reason,m.target_user_id]);
    }
    await db.query('UPDATE moderation_requests SET status=$1,decided_by=$2,decision_note=$3,decided_at=NOW() WHERE id=$4',[approved?'approved':'rejected',req.user.telegram_id,note,id]);
    await db.query('COMMIT');
    const target=m.requested_by;
    const msg=m.kind==='product_delete'?(approved?'Запрос на удаление товара одобрен. Товар удалён из каталога.':'Запрос на удаление товара отклонён. Товар снова доступен в каталоге.'):
      m.kind==='product'?(approved?'Ваш товар одобрен и опубликован.':'Ваш товар отклонён.'):(approved?'Запрос на блокировку одобрен.':'Запрос на блокировку отклонён.');
    await telegramRequest('sendMessage',{chat_id:String(target),text:msg+' Заявка #'+id+(note?' Причина: '+note:'')}).catch(e=>console.error('Notify requester:',e.message));
    if(m.kind==='ban'&&approved){
      const duration=m.duration_hours?' на '+m.duration_hours+' ч.':' навсегда';
      await telegramRequest('sendMessage',{chat_id:String(m.target_user_id),text:'Ваш аккаунт WORLD TG SHOP заблокирован'+duration+'. Причина: '+m.reason}).catch(e=>console.error('Notify banned user:',e.message));
    }
    res.json({success:true,status:approved?'approved':'rejected'});
  }catch(e){await db.query('ROLLBACK');console.error('Moderation decision:',e.message);res.status(503).json({error:'Не удалось обработать заявку.'});}
  finally{db.release();}
});
app.post('/api/support/ban-request',roles('owner','support'),async(req,res)=>{
  const id=String(req.body?.telegram_id||''),reason=String(req.body?.reason||'').trim().slice(0,500),hours=req.body?.duration_hours===null?null:Number(req.body?.duration_hours);
  if(!/^\d{1,20}$/.test(id)||!reason||(hours!==null&&(!Number.isInteger(hours)||hours<1||hours>8760)))return res.status(400).json({error:'Укажите Telegram ID, причину и корректный срок (в часах) либо оставьте срок пустым для постоянной блокировки.'});
  try{
    const u=await pool.query('SELECT telegram_id FROM users WHERE telegram_id=$1',[id]);if(!u.rowCount)return res.status(404).json({error:'Пользователь не найден.'});
    const q=await pool.query("INSERT INTO moderation_requests(kind,requested_by,target_user_id,reason,duration_hours) VALUES ('ban',$1,$2,$3,$4) RETURNING id",[req.user.telegram_id,id,reason,hours]);
    await notifyOwner('Запрос на блокировку пользователя. Заявка #'+q.rows[0].id+'; Telegram ID '+id+'; срок '+(hours===null?'навсегда':hours+' ч.')+'; причина: '+reason);
    res.json({success:true,request_id:q.rows[0].id,message:'Запрос отправлен владельцу. Ожидайте решения.'});
  }catch(e){res.status(503).json({error:'Не удалось отправить запрос.'});}
});
app.post('/api/profile', (req,res)=>res.status(405).json({error:'Используйте PUT /api/profile.'}));

app.post('/api/admin/action',roles('owner','support','admin'),async(req,res)=>{
  const {action,target_id,amount,duration_hours,reason}=req.body||{};
  try{
    if(action==='stats'&&req.user.role==='owner'){
      const r=await pool.query('SELECT (SELECT COUNT(*) FROM users) total_users,(SELECT COALESCE(SUM(balance),0) FROM users) total_balance');
      return res.json({totalUsers:Number(r.rows[0].total_users),totalBalance:Number(r.rows[0].total_balance)});
    }
    if(!['owner','support','admin'].includes(req.user.role))return res.status(403).json({error:'Недостаточно прав.'});
    if(!target_id||!/^\d+$/.test(String(target_id)))return res.status(400).json({error:'Неверный Telegram ID.'});
    if(action==='balance'){
      const delta=Number(amount);if(!Number.isFinite(delta)||Math.abs(delta)>1e6)return res.status(400).json({error:'Неверная сумма.'});
      const c=await pool.connect();
      try{await c.query('BEGIN');
        const r=await c.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2 AND balance+$1>=0 RETURNING telegram_id',[delta,target_id]);
        if(!r.rowCount)throw new Error('Пользователь не найден или недостаточно средств.');
        await c.query("INSERT INTO transactions (telegram_id,amount,type,reference,description) VALUES ($1,$2,'admin_adjustment',$3,'Изменение баланса владельцем')",[target_id,delta,'admin_'+crypto.randomUUID()]);
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    }else if(action==='ban'||action==='unban'){
      if(req.user.role==='support'&&action==='ban')return res.status(403).json({error:'Поддержка отправляет запрос владельцу через форму блокировки.'});
      const hours=duration_hours===null||duration_hours===undefined||duration_hours===''?null:Number(duration_hours);
      if(action==='ban'&&(hours!==null&&(!Number.isInteger(hours)||hours<1||hours>8760)))return res.status(400).json({error:'Срок блокировки должен быть от 1 до 8760 часов либо пустым для постоянной блокировки.'});
      await pool.query('UPDATE users SET is_banned=$1,banned_until=$2,banned_reason=$3,updated_at=NOW() WHERE telegram_id=$4',
        [action==='ban',action==='ban'&&hours?new Date(Date.now()+hours*3600000):null,action==='ban'?String(reason||'Блокировка администратором').slice(0,500):null,target_id]);
    }else return res.status(400).json({error:'Неизвестное действие.'});
    res.json({success:true});
  }catch(e){console.error(e.message);res.status(400).json({error:e.message||'Ошибка операции.'});}
});

app.get('/api/owner/overview',roles('owner'),async(req,res)=>{
  try{
    const q=await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)::int AS total_users,
        (SELECT COUNT(*) FROM users WHERE role IN ('seller','admin'))::int AS total_staff,
        (SELECT COALESCE(SUM(balance),0) FROM users) AS total_balance,
        (SELECT COUNT(*) FROM products) ::int AS total_products,
        (SELECT COUNT(*) FROM orders) ::int AS total_orders,
        (SELECT COALESCE(SUM(amount),0) FROM orders) AS sales_volume,
        (SELECT balance FROM shop_wallet WHERE id=1) AS shop_balance,
        (SELECT COALESCE(SUM(commission),0) FROM orders) AS shop_revenue,
        (SELECT COUNT(*) FROM payments WHERE status='pending')::int AS pending_payments,
        (SELECT COUNT(*) FROM payments WHERE status='paid')::int AS paid_payments
    `);
    const r=q.rows[0];
    res.json(Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='string'&&/^\d+(\.\d+)?$/.test(v)?Number(v):v])));
  }catch(e){console.error('Owner overview:',e.message);res.status(503).json({error:'Не удалось загрузить статистику.'});}
});
app.get('/api/owner/sellers',roles('owner'),async(req,res)=>{
  try{
    const q=await pool.query(`
      SELECT u.telegram_id,u.username,u.role,u.balance,u.seller_balance,u.created_at,
        (SELECT COUNT(*)::int FROM products p WHERE p.seller_id=u.telegram_id) AS products_count,
        (SELECT COUNT(*)::int FROM orders o WHERE o.seller_id=u.telegram_id) AS orders_count,
        (SELECT COALESCE(SUM(o.amount),0) FROM orders o WHERE o.seller_id=u.telegram_id) AS sales_volume,
        (SELECT COALESCE(SUM(o.amount-o.commission),0) FROM orders o WHERE o.seller_id=u.telegram_id) AS seller_earned
      FROM users u
      WHERE u.role IN ('seller','admin')
      ORDER BY sales_volume DESC,u.created_at DESC
    `);
    res.json(q.rows);
  }catch(e){console.error('Owner sellers:',e.message);res.status(503).json({error:'Не удалось загрузить продавцов.'});}
});
app.get('/api/owner/sellers/:id',roles('owner'),async(req,res)=>{
  const id=String(req.params.id||'');
  if(!/^\d{1,20}$/.test(id))return res.status(400).json({error:'Некорректный Telegram ID.'});
  try{
    const [u,p,o,t,ledger]=await Promise.all([
      pool.query('SELECT telegram_id,username,role,balance,seller_balance,is_banned,created_at FROM users WHERE telegram_id=$1',[id]),
      pool.query('SELECT id,title,price,status,created_at FROM products WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 100',[id]),
      pool.query('SELECT o.id,o.amount,o.commission,o.status,o.created_at,p.title FROM orders o JOIN products p ON p.id=o.product_id WHERE o.seller_id=$1 ORDER BY o.created_at DESC LIMIT 100',[id]),
      pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE telegram_id=$1 AND type='sale'",[id]),
      pool.query('SELECT amount,type,description,created_at FROM transactions WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 100',[id])
    ]);
    if(!u.rowCount)return res.status(404).json({error:'Продавец не найден.'});
    res.json({user:u.rows[0],products:p.rows,orders:o.rows,totalEarned:Number(t.rows[0].total),transactions:ledger.rows});
  }catch(e){console.error('Owner seller detail:',e.message);res.status(503).json({error:'Не удалось загрузить профиль продавца.'});}
});
app.get('/api/owner/users',roles('owner'),async(req,res)=>{
  try{
    const q=await pool.query('SELECT telegram_id,username,role,balance,is_banned,created_at FROM users ORDER BY created_at DESC LIMIT 100');
    res.json(q.rows);
  }catch(e){console.error('Owner users:',e.message);res.status(503).json({error:'Не удалось загрузить пользователей.'});}
});
app.post('/api/owner/role',roles('owner'),async(req,res)=>{
  const id=String(req.body?.telegram_id||''),role=String(req.body?.role||'');
  if(!/^\d{1,20}$/.test(id)||!['user','seller','support','admin'].includes(role))return res.status(400).json({error:'Проверьте Telegram ID и роль.'});
  if(id===OWNER_TELEGRAM_ID)return res.status(400).json({error:'Роль владельца нельзя изменить.'});
  try{
    const q=await pool.query('UPDATE users SET role=$1,updated_at=NOW() WHERE telegram_id=$2 RETURNING telegram_id,role',[role,id]);
    if(!q.rowCount)return res.status(404).json({error:'Пользователь не найден.'});
    res.json({success:true,user:q.rows[0]});
  }catch(e){console.error('Owner role:',e.message);res.status(503).json({error:'Не удалось изменить роль.'});}
});

app.use((err,req,res,next)=>{console.error('Request error:',err.message);res.status(400).json({error:'Некорректный запрос.'});});
const tonMonitor=setInterval(()=>{pollTonPayments().catch(e=>console.error('TON poll failed:',e.message));},5000);
const transferExpiryMonitor=setInterval(()=>{expireTransferCodes().catch(e=>console.error('Transfer expiry failed:',e.message));},60000);
setTimeout(()=>pollTonPayments().catch(e=>console.error('TON poll failed:',e.message)),1500).unref();
let server;
async function start() {
  try {
    await migrateDatabase();
    server = app.listen(PORT,'0.0.0.0',()=>{
      console.log('WORLD TG SHOP listening on '+PORT);
      registerTelegramWebhook().catch(e=>console.error('Telegram webhook setup:',e.message));
    });
  } catch (error) {
    console.error('Startup migration failed:', error.message);
    await pool.end();
    process.exit(1);
  }
}
async function stop(){clearInterval(tonMonitor);clearInterval(transferExpiryMonitor);if(server)server.close(async()=>{await pool.end();process.exit(0);});else{await pool.end();process.exit(0);}setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
start();
