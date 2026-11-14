'use strict';
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const { DATABASE_URL, BOT_TOKEN, OWNER_TELEGRAM_ID } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!OWNER_TELEGRAM_ID || !/^\d+$/.test(OWNER_TELEGRAM_ID)) throw new Error('OWNER_TELEGRAM_ID must be numeric');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
});
pool.on('error', e => console.error('PostgreSQL pool error:', e.message));
app.disable('x-powered-by');
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

app.post('/api/products/add',roles('seller','owner'),async(req,res)=>{
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
  const role=req.body?.role;if(!['seller','support'].includes(role))return res.status(400).json({error:'Недопустимая роль.'});
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

app.post('/api/payment/create',async(req,res)=>res.status(503).json({error:'Автоматическое пополнение временно отключено до настройки и проверки платёжного провайдера.'}));

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
app.use((err,req,res,next)=>{console.error('Request error:',err.message);res.status(400).json({error:'Некорректный запрос.'});});
const server=app.listen(PORT,'0.0.0.0',()=>console.log('WORLD TG SHOP listening on '+PORT));
async function stop(){server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
