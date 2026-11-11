const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  if (!process.env.DATABASE_URL) return;
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
        subcategory TEXT,
        seller_id TEXT
      );
    `);
    console.log('БД инициализирована');
  } catch (err) {
    console.error('Ошибка БД:', err);
  }
}
initDb();

// Эндпоинт добавления товара с выбором отдела и подкатегории
app.post('/api/products/add', async (req, res) => {
  const { title, price, price_from, max_price, category, subcategory, seller_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO products (title, price, price_from, max_price, category, subcategory, seller_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [title, price, price_from || false, max_price || null, category, subcategory || '', seller_id || '8127900151']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка добавления товара:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Получение товаров с фильтрацией по категории и подкатегории
app.get('/api/products', async (req, res) => {
  const { category, subcategory } = req.query;
  try {
    let query = 'SELECT * FROM products WHERE 1=1';
    let params = [];
    if (category) {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    if (subcategory) {
      params.push(subcategory);
      query += ` AND subcategory = $${params.length}`;
    }
    const products = await pool.query(query, params);
    res.json(products.rows);
  } catch (err) {
    res.json([]);
  }
});

// Остальные маршруты (/api/user, /api/buy, /api/admin/action и т.д.) остаются без изменений...
