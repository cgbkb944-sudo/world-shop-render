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
      const match = /^wts_stars_(\\d+)_([a-f0-9]+)$/.exec(String(q.invoice_payload || ''));
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
      const match = /^wts_stars_(\\d+)_([a-f0-9]+)$/.exec(String(payment.invoice_payload || ''));
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
  p.delete('hash'); p.delete('signature');
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
      "RETURNING telegram_id,username,role,balance,is_banned",
      [u.id,u.username,role,OWNER_TELEGRAM_ID]);
    req.user = r.rows[0];
    if (req.user.is_banned) return res.status(403).json({error:'Ваш аккаунт заблокирован. Обратитесь в поддержку.'});
    next();
  } catch(e) { console.error('Auth error:',e.message); res.status(503).json({error:'Сервис временно недоступен.'}); }
}
const roles = (...allowed) => (req,res,next) => allowed.includes(req.user.role) ? next() : res.status(403).json({error:'Недостаточно прав.'});
const money = v => { const n=Number(v); return Number.isFinite(n)&&n>0&&n<=1e7&&Math.round(n*100)===n*100?n:null; };
const hashKey = v => crypto.createHash('sha256').update(String(v).trim().toUpperCase()).digest('hex');

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:'connected'});}catch{res.status(503).json({ok:false,database:'unavailable'});}});
app.get('/api/products',async(req,res)=>{
  try { const r=await pool.query("SELECT id,title,description,price,price_from,max_price,category,subcategory FROM products WHERE status='active' ORDER BY created_at DESC LIMIT 200"); res.json(r.rows); }
  catch(e){console.error(e.message);res.status(503).json({error:'Не удалось загрузить товары.'});}
});
app.use('/api',auth);
app.post('/api/user',(req,res)=>res.json(req.user));
app.get('/api/history',async(req,res)=>{try{const r=await pool.query('SELECT amount,type,description,created_at FROM transactions WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.telegram_id]);res.json(r.rows);}catch(e){console.error(e.message);res.status(503).json({error:'Не удалось загрузить историю.'});}});

app.post('/api/products/add',roles('seller','admin','owner'),async(req,res)=>{
  const b=req.body||{}, price=money(b.price), max= b.price_from ? money(b.max_price):null;
  if(typeof b.title!=='string'||!b.title.trim()||b.title.length>160||typeof b.category!=='string'||!b.category||b.category.length>80||
     typeof (b.subcategory||'')!=='string'||(b.subcategory||'').length>100||typeof (b.description||'')!=='string'||(b.description||'').length>5000||
     !price||(b.price_from&&(!max||max<price))) return res.status(400).json({error:'Проверьте название, категорию и цену товара.'});
  try {
    const r=await pool.query("INSERT INTO products (title,description,price,price_from,max_price,category,subcategory,seller_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING id",
      [b.title.trim(),b.description||'',price,Boolean(b.price_from),max,b.category,b.subcategory||'',req.user.telegram_id]);
    res.json({success:true,product_id:r.rows[0].id});
  } catch(e){console.error(e.message);res.status(503).json({error:'Не удалось сохранить товар.'});}
});

app.post('/api/key/activate',async(req,res)=>{
  const key=req.body?.key;
  if(typeof key!=='string'||key.length<8||key.length>128)return res.status(400).json({error:'Неверный ключ.'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const k=await c.query('SELECT key_hash,role FROM activation_keys WHERE key_hash=$1 AND used_by IS NULL FOR UPDATE',[hashKey(key)]);
    if(!k.rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'Неверный или уже использованный ключ.'});}
    await c.query('UPDATE activation_keys SET used_by=$1,used_at=NOW() WHERE key_hash=$2',[req.user.telegram_id,k.rows[0].key_hash]);
    await c.query('UPDATE users SET role=$1,updated_at=NOW() WHERE telegram_id=$2',[k.rows[0].role,req.user.telegram_id]);
    await c.query('COMMIT');res.json({success:true,role:k.rows[0].role});
  }catch(e){await c.query('ROLLBACK');console.error(e.message);res.status(500).json({error:'Не удалось активировать ключ.'});}
  finally{c.release();}
});
app.post('/api/key/generate',roles('owner'),async(req,res)=>{
  const role=req.body?.role;if(!['admin','seller','support'].includes(role))return res.status(400).json({error:'Недопустимая роль.'});
  const key='WTS-'+role.toUpperCase()+'-'+crypto.randomBytes(9).toString('hex').toUpperCase();
  try{await pool.query('INSERT INTO activation_keys (key_hash,role) VALUES ($1,$2)',[hashKey(key),role]);res.json({success:true,key});}
  catch(e){console.error(e.message);res.status(500).json({error:'Не удалось создать ключ.'});}
});

app.post('/api/buy',async(req,res)=>{
  const id=Number(req.body?.product_id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Неверный товар.'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const p=await c.query("SELECT id,seller_id,price FROM products WHERE id=$1 AND status='active' FOR UPDATE",[id]);
    if(!p.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Товар не найден.'});}
    const product=p.rows[0];if(String(product.seller_id)===String(req.user.telegram_id)){await c.query('ROLLBACK');return res.status(400).json({error:'Нельзя купить собственный товар.'});}
    const amount=Number(product.price), fee=Math.round(amount*3)/100, sellerAmount=Math.round((amount-fee)*100)/100;
    const debit=await c.query('UPDATE users SET balance=balance-$1,updated_at=NOW() WHERE telegram_id=$2 AND balance >= $1 RETURNING telegram_id',[amount,req.user.telegram_id]);
    if(!debit.rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'Недостаточно средств на балансе.'});}
    await c.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2',[sellerAmount,product.seller_id]);
    await c.query('UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2',[fee,OWNER_TELEGRAM_ID]);
    const order=await c.query("INSERT INTO orders (buyer_id,seller_id,product_id,amount,commission,status) VALUES ($1,$2,$3,$4,$5,'paid') RETURNING id",[req.user.telegram_id,product.seller_id,id,amount,fee]);
    const ref='order_'+order.rows[0].id;
    await c.query("INSERT INTO transactions (telegram_id,amount,type,reference,description) VALUES ($1,$2,'purchase',$3,$4),($5,$6,'sale',$7,$8),($9,$10,'commission',$11,$12)",
      [req.user.telegram_id,-amount,ref,'Покупка товара #'+order.rows[0].id,product.seller_id,sellerAmount,ref+'_seller','Продажа товара #'+order.rows[0].id,OWNER_TELEGRAM_ID,fee,ref+'_fee','Комиссия магазина']);
    await c.query('COMMIT');res.json({success:true,message:'Покупка успешно совершена!',order_id:order.rows[0].id});
  }catch(e){await c.query('ROLLBACK');console.error('Purchase:',e.message);res.status(500).json({error:'Не удалось оформить покупку.'});}
  finally{c.release();}
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
  if(!['cryptobot','sbp','card','direct_transfer','telegram_stars'].includes(method))return res.status(400).json({error:'Неизвестный способ оплаты.'});
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
        provider_token:''
      });
      return res.json({invoiceLink,paymentId:row.rows[0].id,stars:amount});
    }
    if(method==='cryptobot'){
      if(!process.env.CRYPTO_PAY_API_TOKEN||!process.env.CRYPTO_PAY_WEBHOOK_SECRET)return res.status(503).json({error:'Crypto Pay ещё не настроен на сервере.'});
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
      if(!process.env.ROLLYPAY_API_KEY||!process.env.ROLLYPAY_WEBHOOK_SECRET)return res.status(503).json({error:'RollyPay ещё не настроен на сервере.'});
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
    console.error('Payment create:',e.message);
    return res.status(503).json({error:'Не удалось создать платёж. Проверьте настройки провайдера и попробуйте позже.'});
  }
}
async function paymentStatus(req,res) {
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Неверный номер платежа.'});
  try {
    const r=await pool.query('SELECT id,status,amount,currency,asset,expected_crypto,expires_at FROM payments WHERE id=$1 AND telegram_id=$2',[id,req.user.telegram_id]);
    if(!r.rowCount)return res.status(404).json({error:'Платёж не найден.'});
    const p=r.rows[0];
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
app.post('/api/payment/create',createPayment);
app.get('/api/payment/status/:id',paymentStatus);


app.post('/api/admin/action',roles('owner','support'),async(req,res)=>{
  const {action,target_id,amount}=req.body||{};
  try{
    if(action==='stats'&&req.user.role==='owner'){
      const r=await pool.query('SELECT (SELECT COUNT(*) FROM users) total_users,(SELECT COALESCE(SUM(balance),0) FROM users) total_balance');
      return res.json({totalUsers:Number(r.rows[0].total_users),totalBalance:Number(r.rows[0].total_balance)});
    }
    if(req.user.role!=='owner')return res.status(403).json({error:'Только владелец может изменять аккаунты.'});
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
      await pool.query('UPDATE users SET is_banned=$1,updated_at=NOW() WHERE telegram_id=$2',[action==='ban',target_id]);
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
      SELECT u.telegram_id,u.username,u.role,u.balance,u.created_at,
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
      pool.query('SELECT telegram_id,username,role,balance,is_banned,created_at FROM users WHERE telegram_id=$1',[id]),
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
async function stop(){clearInterval(tonMonitor);if(server)server.close(async()=>{await pool.end();process.exit(0);});else{await pool.end();process.exit(0);}setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
start();
