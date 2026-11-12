const tg = window.Telegram.WebApp;
tg.expand();

const user = tg.initDataUnsafe?.user || { id: '8127900151', username: 'Tobias_26' };
document.getElementById('userid').innerText = user.id;
document.getElementById('username').innerText = user.username || 'user';

let allProducts = [];

fetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram_id: String(user.id), username: user.username })
})
.then(res => res.json())
.then(data => {
    document.getElementById('userrole-badge').innerText = data.role.toUpperCase();
    document.getElementById('user-balance').innerText = data.balance + ' ₽';
    
    // Показываем вкладку управления для owner или support
    if(data.role === 'owner' || data.role === 'support') {
        document.getElementById('nav-manage').classList.remove('hidden');
    }

    // Показываем карточку добавления товаров для продавцов и владельца
    if(data.role === 'seller' || data.role === 'owner') {
        document.getElementById('seller-product-card').classList.remove('hidden');
        document.getElementById('key-activation-card').classList.add('hidden');
    }

    loadProducts();
});

function loadProducts() {
    fetch('/api/products')
    .then(res => res.json())
    .then(products => {
        allProducts = products.length > 0 ? products : [
            { id: 1, title: 'Telegram Звезды (100 шт)', category: 'Telegram', subcategory: 'Покупка Telegram Stars', price: 150, price_from: false },
            { id: 2, title: 'Дизайн ТГК', category: 'Telegram', subcategory: 'Дизайн ТГК', price: 500, price_from: true, max_price: 3000 },
            { id: 3, title: 'Аренда NFT', category: 'Telegram', subcategory: 'Аренда NFT', price: 300, price_from: false },
            { id: 4, title: 'Разработка ТГ ботов', category: 'Telegram', subcategory: 'Разработка ТГ ботов', price: 1000, price_from: true, max_price: 15000 },
            { id: 5, title: 'Буст в Roblox', category: 'Roblox', subcategory: 'Буст', price: 200, price_from: false },
            { id: 6, title: 'Аккаунты Roblox', category: 'Roblox', subcategory: 'Аккаунты Roblox', price: 400, price_from: false },
            { id: 7, title: 'Напарник на час в Roblox', category: 'Roblox', subcategory: 'Напарник на час', price: 250, price_from: false }
        ];
        renderProducts(allProducts);
    });
}

function renderProducts(products) {
    const list = document.getElementById('products-list');
    if(products.length === 0) {
        list.innerHTML = '<div class="no-products">Товары пока не добавлены</div>';
        return;
    }
    list.innerHTML = products.map(p => {
        let priceText = `${p.price} ₽`;
        if (p.price_from && p.max_price) {
            priceText = `от ${p.price} до ${p.max_price} ₽`;
        } else if (p.price_from) {
            priceText = `от ${p.price} ₽`;
        }

        return `
            <div class="product-item">
                <div>
                    <b style="font-size: 15px;">${p.title}</b>
                    <br><small style="color:var(--text-muted);">${p.category} / ${p.subcategory || 'Общее'}</small>
                </div>
                <div style="text-align: right;">
                    <b style="display:block; margin-bottom:6px; color:#818cf8;">${priceText}</b>
                    <button style="width:auto; padding:6px 14px; margin:0; font-size:13px;" onclick="buyProduct(${p.id})">Купить</button>
                </div>
            </div>
        `;
    }).join('');
}

function filterProducts() {
    const query = document.getElementById('searchInput').value.toLowerCase();
    let filtered = allProducts.filter(p => p.title.toLowerCase().includes(query));
    renderProducts(filtered);
}

const subsByCat = {
    'Telegram': ['Дизайн ТГК', 'Аренда NFT', 'Разработка ТГ ботов', 'Накрутка подписчиков', 'Покупка Telegram Stars', 'Просмотры и реакции'],
    'Instagram': ['Подписчики', 'Лайки', 'Просмотры', 'Комментарии'],
    'Roblox': ['Буст', 'Аккаунты Roblox', 'Напарник на час', 'Робуксы'],
    'Genshin': ['Кристаллы', 'Луна'],
    'Steam': ['Пополнение кошелька 500₽', 'Пополнение кошелька 1000₽'],
    'VPN': ['Доступ на 1 месяц', 'Доступ на 1 год']
};

function updateSubcategoryOptions() {
    const cat = document.getElementById('newCategory').value;
    const subSelect = document.getElementById('newSubcategory');
    const list = subsByCat[cat] || ['Основная услуга'];
    subSelect.innerHTML = list.map(s => `<option value="${s}">${s}</option>`).join('');
}

function toggleMaxPriceField() {
    const isChecked = document.getElementById('newPriceFrom').checked;
    document.getElementById('maxPriceContainer').classList.toggle('hidden', !isChecked);
}

function addNewProduct() {
    const title = document.getElementById('newTitle').value;
    const category = document.getElementById('newCategory').value;
    const subcategory = document.getElementById('newSubcategory').value;
    const price = document.getElementById('newPrice').value;
    const price_from = document.getElementById('newPriceFrom').checked;
    const max_price = document.getElementById('newMaxPrice').value;

    if(!title || !price) {
        alert('Заполните название и цену!');
        return;
    }

    fetch('/api/products/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title, category, subcategory, price, price_from, max_price,
            seller_id: String(user.id)
        })
    })
    .then(res => res.json())
    .then(data => {
        if(data.success) {
            alert('Товар успешно опубликован!');
            location.reload();
        } else {
            alert(data.error || 'Ошибка публикации');
        }
    });
}

function activateKey() {
    const key = document.getElementById('keyCode').value;
    if(!key) { alert('Введите ключ'); return; }

    fetch('/api/key/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: String(user.id), key })
    })
    .then(res => res.json())
    .then(data => {
        if(data.success) {
            alert(`Ключ успешно активирован! Ваша роль: ${data.role}`);
            location.reload();
        } else {
            alert(data.error || 'Неверный ключ');
        }
    });
}

function makePayment() {
    const amount = document.getElementById('payAmount').value;
    const method = document.getElementById('payMethod').value;
    if(!amount || amount <= 0) { alert('Введите корректную сумму'); return; }

    fetch('/api/payment/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: String(user.id), amount, method })
    })
    .then(res => res.json())
    .then(data => {
        if(data.paymentUrl) {
            window.location.href = data.paymentUrl;
        } else {
            alert(data.message || data.error || 'Ошибка платежа');
        }
    });
}

function switchTab(tabName, element) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.remove('hidden');
    element.classList.add('active');

    if(tabName === 'manage') loadAdminStats();
}

function loadAdminStats() {
    fetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_id: String(user.id), action: 'stats' })
    })
    .then(res => res.json())
    .then(data => {
        if(data.totalUsers !== undefined) {
            document.getElementById('stats-total-users').innerText = data.totalUsers + ' чел.';
            document.getElementById('stats-total-balance').innerText = data.totalBalance + ' ₽';
        }
    });
}

function buyProduct(productId) {
    if(!confirm('Подтвердить покупку товара?')) return;
    fetch('/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: String(user.id), product_id: productId })
    })
    .then(res => res.json())
    .then(data => {
        if(data.error) alert(data.error);
        else { alert('Успешно оформлено!'); location.reload(); }
    });
}
