const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Токен Crypto Bot
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || '665752:AAEu6varMhK9mT8H5dcnC20b7lqdbWj7Wb0';
const CRYPTO_BOT_API = 'https://pay.crypt.bot/api';

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Роут для отдачи главной страницы
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Создание счета в Crypto Bot
app.post('/api/create-invoice', async (req, res) => {
  try {
    const { amount, asset = 'USDT' } = req.body;

    const response = await fetch(`${CRYPTO_BOT_API}/createInvoice`, {
      method: 'POST',
      headers: {
        'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        asset: asset,
        amount: amount.toString(),
        description: 'Пополнение баланса World Shop',
        paid_btn_name: 'openBot',
        paid_btn_url: 'https://t.me/CryptoBot'
      })
    });

    const data = await response.json();

    if (data.ok) {
      res.json({ success: true, payUrl: data.result.pay_url, invoiceId: data.result.invoice_id });
    } else {
      res.status(400).json({ success: false, error: data.error || 'Ошибка создания счета' });
    }
  } catch (err) {
    console.error('CryptoBot Invoice Error:', err);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});