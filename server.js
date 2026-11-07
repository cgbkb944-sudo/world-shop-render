const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Отдача статических файлов (index.html)
app.use(express.static(path.join(__dirname)));

// Подключение к PostgreSQL с безопасной обработкой ошибок
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Ошибка в пуле PostgreSQL:', err);
});

// Инициализация базы данных
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.error('КРИТИЧЕСКАЯ ОШИБКА: Переменная DATABASE_URL не задана в Render!');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        balance NUMERIC DEFAULT 0,
        is_banned BOOLEAN DEFAULT FALSE,
        role TEXT DEFAULT 'user'
      );
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        title TEXT,
        price NUMERIC,
        price_from BOOLEAN DEFAULT FALSE,
        max_price NUMERIC,
        category TEXT,
        seller_id TEXT
      );
    `);
    console.log('База данных успешно инициализирована');
  } catch (err) {
    console.error('Ошибка инициализации БД:', err);
  }
}
initDb();

// Middleware проверки бана
async function checkBan(req, res, next) {
  const telegram_id = req.headers['x-telegram-id'] || req.query.telegram_id || req.body.telegram_id;
  if (!telegram_id || !process.env.DATABASE_URL) return next();
  
  try {
    const user = await pool.query('SELECT is_banned FROM users WHERE telegram_id = $1', [telegram_id]);
    if (user.rows.length > 0 && user.rows[0].is_banned) {
      return res.status(403).json({ error: 'Вы заблокированы, обратитесь в поддержку.' });
    }
  } catch (e) {
    console.error('Ошибка проверки бана:', e);
  }
  next();
}

app.use(checkBan);

// Главная страница (отдача index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Авторизация / получение профиля
app.post('/api/user', async (req, res) => {
  const { telegram_id, username } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'No telegram_id' });

  try {
    let result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
    
    let role = 'user';
    if (telegram_id === '8127900151') {
      role = 'owner';
    } else if (result.rows.length > 0) {
      role = result.rows[0].role;
    }

    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (telegram_id, username, balance, role) VALUES ($1, $2, 0, $3)',
        [telegram_id, username || '', role]
      );
      result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Ошибка в /api/user:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Список товаров
app.get('/api/products', async (req, res) => {
  try {
    const products = await pool.query('SELECT * FROM products');
    res.json(products.rows);
  } catch (err) {
    res.json([]);
  }
});

// Покупка с комиссией 3% владельцу
app.post('/api/buy', async (req, res) => {
  const { telegram_id, product_id } = req.body;
  try {
    const productRes = await pool.query('SELECT * FROM products WHERE id = $1', [product_id]);
    if (productRes.rows.length === 0) return res.status(404).json({ error: 'Товар не найден' });
    
    const product = productRes.rows[0];
    const price = parseFloat(product.price);

    const buyerRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [telegram_id]);
    if (buyerRes.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });
    
    const buyerBalance = parseFloat(buyerRes.rows[0].balance);
    if (buyerBalance < price) return res.status(400).json({ error: 'Недостаточно средств на балансе' });

    const commission = price * 0.03;
    const sellerAmount = price - commission;

    await pool.query('UPDATE users SET balance = balance - $1 WHERE telegram_id = $2', [price, telegram_id]);
    await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = \'8127900151\'', [commission]);

    if (product.seller_id && product.seller_id !== '8127900151') {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [sellerAmount, product.seller_id]);
    } else if (!product.seller_id) {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = \'8127900151\'', [sellerAmount]);
    }

    res.json({ success: true, message: 'Покупка успешно совершена!' });
  } catch (err) {
    console.error('Ошибка покупки:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET-вебхук NicePay
app.get('/api/webhook/nicepay', async (req, res) => {
  const { amount, user_id, status } = req.query;
  if ((status === 'success' || status === 'paid') && user_id && amount) {
    try {
      await pool.query(
        'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2',
        [parseFloat(amount), user_id]
      );
    } catch (e) {
      console.error('Ошибка вебхука NicePay:', e);
    }
  }
  res.send('OK');
});

// Админ-действия (баланс, баны, статистика)
app.post('/api/admin/action', async (req, res) => {
  const { admin_id, target_id, action, amount } = req.body;
  
  if (admin_id !== '8127900151') {
    const adminCheck = await pool.query('SELECT role FROM users WHERE telegram_id = $1', [admin_id]);
    if (adminCheck.rows.length === 0 || (adminCheck.rows[0].role !== 'owner' && adminCheck.rows[0].role !== 'support')) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  try {
    if (action === 'stats') {
      const usersCount = await pool.query('SELECT COUNT(*) FROM users');
      const totalBalance = await pool.query('SELECT SUM(balance) FROM users');
      return res.json({
        totalUsers: parseInt(usersCount.rows[0].count) || 0,
        totalBalance: parseFloat(totalBalance.rows[0].sum) || 0
      });
    }

    if (action === 'balance') {
      const val = parseFloat(amount);
      await pool.query(
        'UPDATE users SET balance = GREATEST(0, balance + $1) WHERE telegram_id = $2',
        [val, target_id]
      );
    } else if (action === 'ban') {
      await pool.query('UPDATE users SET is_banned = TRUE WHERE telegram_id = $1', [target_id]);
    } else if (action === 'unban') {
      await pool.query('UPDATE users SET is_banned = FALSE WHERE telegram_id = $1', [target_id]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка админ-действия:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
