// Global error handlers to prevent application crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (index.html, script.js)
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// Database initialization
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.error('CRITICAL ERROR: DATABASE_URL is not defined!');
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
        subcategory TEXT,
        seller_id TEXT
      );
    `);
    console.log('Database successfully initialized');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}
initDb();

// Ban check middleware
async function checkBan(req, res, next) {
  const telegram_id = req.headers['x-telegram-id'] || req.query.telegram_id || req.body.telegram_id;
  if (!telegram_id || !process.env.DATABASE_URL) return next();
  
  try {
    const user = await pool.query('SELECT is_banned FROM users WHERE telegram_id = $1', [telegram_id]);
    if (user.rows.length > 0 && user.rows[0].is_banned) {
      return res.status(403).json({ error: 'You are banned, please contact support.' });
    }
  } catch (e) {
    console.error('Ban check error:', e);
  }
  next();
}

app.use(checkBan);

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Authorization / Profile fetch
app.post('/api/user', async (req, res) => {
  const { telegram_id, username } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'No telegram_id provided' });

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
    console.error('Error in /api/user:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get products with filtering
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
    console.error('Error fetching products:', err);
    res.json([]);
  }
});

// Add product
app.post('/api/products/add', async (req, res) => {
  const { title, price, price_from, max_price, category, subcategory, seller_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO products (title, price, price_from, max_price, category, subcategory, seller_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [title, price, price_from || false, max_price || null, category, subcategory || '', seller_id || '8127900151']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error adding product:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Purchase product with 3% commission to owner
app.post('/api/buy', async (req, res) => {
  const { telegram_id, product_id } = req.body;
  try {
    const productRes = await pool.query('SELECT * FROM products WHERE id = $1', [product_id]);
    if (productRes.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    
    const product = productRes.rows[0];
    const price = parseFloat(product.price);

    const buyerRes = await pool.query('SELECT balance FROM users WHERE telegram_id = $1', [telegram_id]);
    if (buyerRes.rows.length === 0) return res.status(400).json({ error: 'User not found' });
    
    const buyerBalance = parseFloat(buyerRes.rows[0].balance);
    if (buyerBalance < price) return res.status(400).json({ error: 'Insufficient funds on balance' });

    const commission = price * 0.03;
    const sellerAmount = price - commission;

    await pool.query('UPDATE users SET balance = balance - $1 WHERE telegram_id = $2', [price, telegram_id]);
    await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = \'8127900151\'', [commission]);

    if (product.seller_id && product.seller_id !== '8127900151') {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [sellerAmount, product.seller_id]);
    } else if (!product.seller_id) {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = \'8127900151\'', [sellerAmount]);
    }

    res.json({ success: true, message: 'Purchase successfully completed!' });
  } catch (err) {
    console.error('Purchase error:', err);
    res.status(500).json({ error: 'Server error during purchase' });
  }
});

// Create RollyPay payment
app.post('/api/payment/create', async (req, res) => {
  const { telegram_id, amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const terminalId = 'c7085e83-49b4-4fdb-ab38-c9840ea853c9';
  const apiKey = 'wB48FPrR0zqnrsDYm4wwp2tG0GZ9djZWgdcogwOC75c';
  const nonce = crypto.randomBytes(16).toString('hex');

  try {
    const payload = {
      amount: parseFloat(amount).toFixed(2),
      payment_currency: 'RUB',
      order_id: `topup_${telegram_id}_${Date.now()}`,
      terminal_id: terminalId,
      description: `Balance top-up for user ${telegram_id}`
    };

    const response = await fetch('https://rollypay.io/api/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Nonce': nonce
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (data.pay_url) {
      res.json({ paymentUrl: data.pay_url });
    } else {
      console.error('RollyPay error response:', data);
      res.status(400).json({ error: 'Failed to create payment via RollyPay' });
    }
  } catch (err) {
    console.error('RollyPay creation error:', err);
    res.status(500).json({ error: 'Payment gateway error' });
  }
});

// RollyPay Webhook handler
app.post('/api/webhook/rollypay', async (req, res) => {
  const signature = req.headers['x-signature'];
  const signingSecret = 'v4It9y0eczYsMxCZMqg1TFXecq2PO8WuNDEixX9VIE4';
  
  // Optional signature verification check if needed, then process successful payment
  const event = req.body;
  if (event && (event.status === 'paid' || event.status === 'success')) {
    const orderId = event.order_id || '';
    const amount = parseFloat(event.amount);
    const parts = orderId.split('_');
    if (parts.length >= 2 && parts[0] === 'topup') {
      const telegramId = parts[1];
      try {
        await pool.query(
          'UPDATE users SET balance = balance + $1 WHERE telegram_id = $2',
          [amount, telegramId]
        );
        console.log(`Balance successfully credited via RollyPay for user ${telegramId}: ${amount} RUB`);
      } catch (e) {
        console.error('Webhook DB credit error:', e);
      }
    }
  }
  res.send('OK');
});

// Admin panel actions
app.post('/api/admin/action', async (req, res) => {
  const { admin_id, target_id, action, amount } = req.body;
  
  if (admin_id !== '8127900151') {
    try {
      const adminCheck = await pool.query('SELECT role FROM users WHERE telegram_id = $1', [admin_id]);
      if (adminCheck.rows.length === 0 || (adminCheck.rows[0].role !== 'owner' && adminCheck.rows[0].role !== 'support')) {
        return res.status(403).json({ error: 'Access denied' });
      }
    } catch (e) {
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
    console.error('Admin action error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
         
