const tg = window.Telegram.WebApp;
tg.expand();

const user = tg.initDataUnsafe?.user;
const initData = tg.initData || '';
if (!user || !initData) {
    document.getElementById('products-list').innerText = 'Откройте магазин через Telegram.';
    throw new Error('Telegram WebApp initData is required');
}
function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('X-Telegram-Init-Data', initData);
    return fetch(url, { ...options, headers });
}
document.getElementById('userid').innerText = user.id;
document.getElementById('username').innerText = user.username || 'user';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

let allProducts = [];
let selectedPaymentMethod = 'cryptobot';
let activeDirectPaymentId = null;
let directPaymentPoll = null;

function setAmount(val) {
    document.getElementById('payAmount').value = val;
    document.querySelectorAll('.quick-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.quick-btn').forEach(btn => { if (Number(btn.textContent.replace(/[^0-9.]/g, '')) === Number(val)) btn.classList.add('active'); });
}

function selectMethod(method, element) {
    selectedPaymentMethod = method;
    document.querySelectorAll('.pay-method-item').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
    document.getElementById('directAssetWrap').classList.toggle('hidden', method !== 'direct_transfer');
}

apiFetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram_id: String(user.id), username: user.username })
})
.then(res => res.json())
.then(data => {
    document.getElementById('userrole-badge').innerText = data.role.toUpperCase();
    document.getElementById('user-balance').innerText = data.balance + ' ₽';
    
    if(data.role === 'owner' || data.role === 'support') {
        document.getElementById('nav-manage').classList.remove('hidden');
    }

    if(data.role === 'owner') {
        document.getElementById('owner-key-gen').style.display = 'block';
    }

    if(data.role === 'seller' || data.role === 'owner') {
        document.getElementById('seller-product-card').classList.remove('hidden');
        document.getElementById('key-activation-card').classList.add('hidden');
    }

    loadProducts();
});

function loadProducts() {
    apiFetch('/api/products')
    .then(res => res.json())
    .then(products => {
        allProducts = products.length > 0 ? products : [
            { id: 1, title: 'Telegram Звезды (100 шт)', category: 'Telegram', subcategory: 'Покупка Telegram Stars', price: 150, price_from: false },
            { id: 2, title: 'Дизайн ТГК', category: 'Telegram', subcategory: 'Дизайн ТГК', price: 500, price_from: true, max_price: 3000 }
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
                    <b style="font-size: 15px;">${escapeHtml(p.title)}</b>
                    <br><small style="color:var(--text-muted);">${escapeHtml(p.category)} / ${escapeHtml(p.subcategory || 'Общее')}</small>
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

    apiFetch('/api/products/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title, category, subcategory, price, price_from, max_price,
            seller_id: String(user.id)
        })
    })
    .then(async res => {
        const data = await res.json();
        if(res.ok && data.success) {
            alert('Товар успешно отправлен на модерацию и опубликован!');
            location.reload();
        } else {
            alert(data.error || 'Ошибка публикации товара');
        }
    })
    .catch(err => {
        alert('Ошибка соединения с сервером');
    });
}

function activateKey() {
    const key = document.getElementById('keyCode').value;
    if(!key) { alert('Введите ключ'); return; }

    apiFetch('/api/key/activate', {
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

function generateKey() {
    const role = document.getElementById('genRole').value;
    apiFetch('/api/key/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_id: String(user.id), role })
    })
    .then(res => res.json())
    .then(data => {
        if(data.success) {
            document.getElementById('generatedKeyResult').innerText = `Сгенерированный ключ: ${data.key}`;
        } else {
            alert(data.error || 'Ошибка генерации');
        }
    });
}

function makePayment() {
    const amount = Number(document.getElementById('payAmount').value);
    if(!Number.isFinite(amount) || amount <= 0 || amount > 10000000) { alert('Введите корректную сумму'); return; }
    const body = { amount, method: selectedPaymentMethod };
    if (selectedPaymentMethod === 'direct_transfer') body.asset = document.getElementById('directAsset').value;
    apiFetch('/api/payment/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    .then(async res => ({ ok:res.ok, data:await res.json() }))
    .then(({ok,data}) => {
        if(!ok) { alert(data.error || 'Ошибка создания платежа'); return; }
        if(data.directTransfer) {
            activeDirectPaymentId = data.paymentId;
            document.getElementById('transferAssetTitle').innerText = data.asset === 'TON' ? 'TON' : 'USDT (TON)';
            document.getElementById('transferAmountText').innerText = data.cryptoAmount + ' ' + data.asset;
            document.getElementById('walletAddressText').innerText = data.walletAddress;
            document.getElementById('transferRubText').innerText = amount.toFixed(2) + ' ₽';
            document.getElementById('transferExpiryText').innerText = new Date(data.expiresAt).toLocaleTimeString();
            document.getElementById('transferStatusText').innerText = 'Ожидаем перевод';
            document.getElementById('transferModal').classList.remove('hidden');
            if(directPaymentPoll) clearInterval(directPaymentPoll);
            directPaymentPoll = setInterval(checkDirectPayment,5000);
        } else if(data.paymentUrl) {
            window.location.href = data.paymentUrl;
        } else {
            alert(data.error || 'Платёж создан, но ссылка не получена.');
        }
    })
    .catch(() => alert('Ошибка соединения с сервером'));
}

async function checkDirectPayment() {
    if(!activeDirectPaymentId) return;
    try {
        const res=await apiFetch('/api/payment/status/'+activeDirectPaymentId);
        const data=await res.json();
        if(data.status==='paid') {
            document.getElementById('transferStatusText').innerText='Оплата подтверждена! Баланс пополнен.';
            if(directPaymentPoll) clearInterval(directPaymentPoll);
            directPaymentPoll=null;
            activeDirectPaymentId=null;
            setTimeout(()=>{ closeTransferModal(); location.reload(); },1800);
        } else if(data.status==='expired') {
            document.getElementById('transferStatusText').innerText='Срок оплаты истёк. Создайте новый платёж.';
            if(directPaymentPoll) clearInterval(directPaymentPoll);
            directPaymentPoll=null;
        }
    } catch(e) { /* Network retry: payment state remains server-authoritative. */ }
}

function copyWalletAddress() {
    const value=document.getElementById('walletAddressText').innerText;
    if(navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(()=>alert('Адрес скопирован'));
    else alert(value);
}

function openWalletApp() { copyWalletAddress(); }

function closeTransferModal() {
    if(directPaymentPoll) clearInterval(directPaymentPoll);
    directPaymentPoll=null;
    document.getElementById('transferModal').classList.add('hidden');
}

function switchTab(tabName, element) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.remove('hidden');
    element.classList.add('active');

    if(tabName === 'manage') loadAdminStats();
}

function loadAdminStats() {
    apiFetch('/api/admin/action', {
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
    apiFetch('/api/buy', {
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
