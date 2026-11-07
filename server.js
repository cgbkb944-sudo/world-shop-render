const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
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
}
initDb();

// Покупка товара с комиссией 3% владельцу
app.post('/api/buy', async (req, res) => {
  const { telegram_id, product_id } = req.body;
  
  const productRes = await pool.query('SELECT * FROM products WHERE id = $1', [product_id]);
  if (productRes.rows.length === 0) return res.status(404).json({ error: 'Товар не найден' });
  
  const product = productRes.rows[0];
  const price = parseFloat(product.price);

  const buyerRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [telegram_id]);
  if (buyerRes.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });
  
  const buyerBalance = parseFloat(buyerRes.rows[0].balance);
  if (buyerBalance < price) return res.status(400).json({ error: 'Недостаточно средств на балансе' });

  // Расчет комиссии 3%
  const commission = price * 0.03;
  const sellerAmount = price - commission;

  // Списание с покупателя
  await pool.query('UPDATE users SET balance = balance - $1 WHERE telegram_id = $2', [price, telegram_id]);
  
  // Начисление 3% владельцу (ID: 8127900151)
  await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = \'8127900151\'', [commission]);

  // Если у товара есть продавец (не владелец), зачисляем ему сумму за вычетом комиссии
  if (product.seller_id && product.seller_id !== '8127900151') {
    await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [sellerAmount, product.seller_id]);
  } else {
    // Если продавец сам владелец, комиссия остается у него (уже учтена или зачислена)
    if (!product.seller_id) {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = \'8127900151\'', [sellerAmount]);
    }
  }

  res.json({ success: true, message: 'Покупка успешно совершена!' });
});

// Эндпоинт добавления товара с поддержкой цены «от»
app.post('/api/products/add', async (req, res) => {
  const { title, price, price_from, max_price, category, seller_id } = req.body;
  await pool.query(
    'INSERT INTO products (title, price, price_from, max_price, category, seller_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [title, price, price_from || false, max_price || null, category, seller_id]
  );
  res.json({ success: true });
});

// Остальные эндпоинты (/api/user, /api/products, /api/admin/action и т.д.) сохраняются аналогично предыдущим...
