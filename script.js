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
let activeDirectPaymentUri = null;
let directPaymentPoll = null;
let currentRole='user';
function rub(value){return Number(value||0).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';}
function jsonPost(url,body){return apiFetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
function loadOwnerStats(){
  apiFetch('/api/owner/overview').then(r=>r.json()).then(d=>{
    if(d.error)throw new Error(d.error);
    document.getElementById('stats-total-users').textContent=d.total_users;
    document.getElementById('stats-sales-volume').textContent=rub(d.sales_volume);
    document.getElementById('stats-shop-revenue').textContent=rub(d.shop_revenue);
    document.getElementById('stats-total-orders').textContent=d.total_orders;
    document.getElementById('stats-pending-payments').textContent=d.pending_payments;
    document.getElementById('stats-total-balance').textContent=rub(d.total_balance);
  }).catch(e=>console.error(e));
}
function loadOwnerSellers(){
  const box=document.getElementById('owner-sellers-list');box.textContent='Загружаем продавцов…';
  apiFetch('/api/owner/sellers').then(r=>r.json()).then(rows=>{
    if(!Array.isArray(rows))throw new Error(rows.error||'Ошибка');
    box.innerHTML=rows.length?rows.map(s=>`<div class="data-row"><div><b>${escapeHtml(s.username?'@'+s.username:s.telegram_id)}</b><small>ID ${escapeHtml(s.telegram_id)} · ${s.orders_count} заказов · оборот ${rub(s.sales_volume)}</small></div><button onclick="showSeller('${escapeHtml(s.telegram_id)}')">Подробнее</button></div>`).join(''):'<div class="no-products">Продавцов пока нет</div>';
  }).catch(()=>box.textContent='Не удалось загрузить список продавцов.');
}
function showSeller(id){
  const box=document.getElementById('seller-detail');box.classList.remove('hidden');box.textContent='Загружаем профиль…';
  apiFetch('/api/owner/sellers/'+encodeURIComponent(id)).then(r=>r.json()).then(d=>{
    if(d.error)throw new Error(d.error);
    const u=d.user;
    box.innerHTML=`<div class="section-title"><h3>${escapeHtml(u.username?'@'+u.username:u.telegram_id)}</h3><button class="small-action" onclick="document.getElementById('seller-detail').classList.add('hidden')">Закрыть</button></div><p>ID: ${escapeHtml(u.telegram_id)} · Роль: ${escapeHtml(u.role)} · Баланс: ${rub(u.balance)}</p><p>Заработано: <b>${rub(d.totalEarned)}</b> · Товаров: ${d.products.length} · Заказов: ${d.orders.length}</p><h4>Товары</h4>${d.products.length?d.products.map(p=>`<div class="data-row"><div><b>${escapeHtml(p.title)}</b><small>${escapeHtml(p.status)} · ${rub(p.price)}</small></div></div>`).join(''):'<p>Нет товаров</p>'}<h4 style="margin-top:14px">Последние продажи</h4>${d.orders.length?d.orders.slice(0,10).map(o=>`<div class="data-row"><div><b>#${o.id} · ${escapeHtml(o.title)}</b><small>${rub(o.amount)} · ${escapeHtml(o.status)}</small></div></div>`).join(''):'<p>Продаж пока нет</p>'}${'<h4 style="margin-top:14px">История операций</h4>'}${d.transactions.length?d.transactions.slice(0,20).map(t=>`<div class="data-row"><div><b>${escapeHtml(t.description)}</b><small>${escapeHtml(t.type)} · ${new Date(t.created_at).toLocaleString('ru-RU')}</small></div><strong>${Number(t.amount)>0?'+':''}${rub(t.amount)}</strong></div>`).join(''):'<p>Операций пока нет</p>'}`;
  }).catch(e=>box.textContent=e.message);
}
function assignUserRole(){
 const id=document.getElementById('targetId').value.trim(),role=document.getElementById('assignRole').value;
 if(!id){alert('Введите Telegram ID');return;}
 jsonPost('/api/owner/role',{telegram_id:id,role}).then(async r=>({ok:r.ok,d:await r.json()})).then(x=>{if(!x.ok)throw new Error(x.d.error);alert('Роль назначена: '+role);loadOwnerSellers();}).catch(e=>alert(e.message));
}
function updateBalance(){
 const target_id=document.getElementById('targetId').value.trim(),amount=Number(document.getElementById('balanceDelta').value);
 if(!target_id||!Number.isFinite(amount)||amount===0){alert('Укажите Telegram ID и ненулевую сумму');return;}
 jsonPost('/api/admin/action',{action:'balance',target_id,amount}).then(async r=>({ok:r.ok,d:await r.json()})).then(x=>{if(!x.ok)throw new Error(x.d.error);alert('Баланс изменён');loadOwnerStats();}).catch(e=>alert(e.message));
}
function setUserBan(ban){
 const target_id=document.getElementById('targetId').value.trim();if(!target_id){alert('Введите Telegram ID');return;}
 jsonPost('/api/admin/action',{action:ban?'ban':'unban',target_id}).then(async r=>({ok:r.ok,d:await r.json()})).then(x=>{if(!x.ok)throw new Error(x.d.error);alert(ban?'Пользователь заблокирован':'Блокировка снята');}).catch(e=>alert(e.message));
}


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
    currentRole = data.role;
    document.getElementById('userrole-badge').innerText = data.role.toUpperCase();
    document.getElementById('user-balance').innerText = rub(data.balance);
    
    if(data.role === 'owner') {
        document.getElementById('nav-manage').classList.remove('hidden');
    }

    if(data.role === 'owner') {
        document.getElementById('owner-key-gen').style.display = 'block';
    }

    if(data.role === 'seller' || data.role === 'admin' || data.role === 'owner') {
        document.getElementById('seller-product-card').classList.remove('hidden');
        document.getElementById('key-activation-card').classList.add('hidden');
    }

    loadProducts();
    resumePendingPayment();
});

function loadProducts() {
    apiFetch('/api/products')
    .then(res => res.json())
    .then(products => {
        allProducts = Array.isArray(products) ? products : [];
        document.getElementById('catalog-count').textContent = allProducts.length + ' предложений';
        renderProducts(allProducts);
    }).catch(() => {
        document.getElementById('products-list').innerHTML = '<div class="no-products">Не удалось загрузить каталог. Попробуйте обновить страницу.</div>';
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

function resumePendingPayment(){
    let id=new URLSearchParams(window.location.search).get('payment_id');
    try{if(!id)id=localStorage.getItem('world_tg_pending_payment');}catch(e){}
    if(!id||String(id).length>20||Array.from(String(id)).some(ch=>ch<'0'||ch>'9'))return;
    let checks=0;
    const timer=setInterval(async()=>{
        checks++;
        try{
            const response=await apiFetch('/api/payment/status/'+encodeURIComponent(id));
            const data=await response.json();
            if(data.status==='paid'){
                clearInterval(timer);
                try{localStorage.removeItem('world_tg_pending_payment');}catch(e){}
                alert('Оплата подтверждена! Баланс пополнен.');
                location.href=location.pathname;
            }else if(data.status==='expired'||data.status==='failed'||checks>=120){
                clearInterval(timer);
                try{localStorage.removeItem('world_tg_pending_payment');}catch(e){}
                if(data.status==='expired'||data.status==='failed')alert('Платёж не подтверждён. Если деньги списались, обратитесь в поддержку.');
            }
        }catch(e){if(checks>=120)clearInterval(timer);}
    },5000);
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
            if(!data.transferUri || !data.comment) { alert('Сервер не вернул реквизиты с комментарием. Платёж не запущен.'); return; }
            activeDirectPaymentId = data.paymentId;
            activeDirectPaymentUri = data.transferUri;
            document.getElementById('transferAssetTitle').innerText = data.asset === 'TON' ? 'TON' : 'USDT (TON)';
            document.getElementById('transferAmountText').innerText = data.cryptoAmount + ' ' + data.asset;
            document.getElementById('walletAddressText').innerText = data.walletAddress;
            document.getElementById('walletCommentText').innerText = data.comment;
            document.getElementById('transferRubText').innerText = amount.toFixed(2) + ' ₽';
            document.getElementById('transferExpiryText').innerText = new Date(data.expiresAt).toLocaleTimeString('ru-RU');
            document.getElementById('transferStatusText').innerText = 'Ожидаем перевод';
            const qrImage = document.getElementById('transferQrImg');
            if(window.QRCode && typeof window.QRCode.toDataURL === 'function') {
                window.QRCode.toDataURL(data.transferUri,{width:220,margin:1,errorCorrectionLevel:'M'})
                    .then(url => { qrImage.src = url; })
                    .catch(() => { qrImage.alt = 'Не удалось сформировать QR-код'; });
            } else {
                qrImage.alt = 'QR-код временно недоступен';
            }
            document.getElementById('transferModal').classList.remove('hidden');
            document.getElementById('transferModal').setAttribute('aria-hidden','false');
            if(directPaymentPoll) clearInterval(directPaymentPoll);
            directPaymentPoll = setInterval(checkDirectPayment,5000);
        } else if(data.paymentUrl) {
            try{localStorage.setItem('world_tg_pending_payment',String(data.paymentId));}catch(e){}
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
    if(navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(()=>alert('Адрес скопирован')).catch(()=>alert(value));
    else alert(value);
}

function copyWalletComment() {
    const value=document.getElementById('walletCommentText').innerText;
    if(navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(()=>alert('Комментарий скопирован')).catch(()=>alert(value));
    else alert(value);
}

function openWalletApp() {
    if(activeDirectPaymentUri) window.location.href = activeDirectPaymentUri;
}

function closeTransferModal() {
    if(directPaymentPoll) clearInterval(directPaymentPoll);
    directPaymentPoll=null;
    document.getElementById('transferModal').classList.add('hidden');
    document.getElementById('transferModal').setAttribute('aria-hidden','true');
}

function switchTab(tabName, element) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.remove('hidden');
    element.classList.add('active');

    if(tabName === 'manage') { if(currentRole==='owner'){loadOwnerStats();loadOwnerSellers();}else loadAdminStats(); }
    if(tabName === 'history') loadHistory();
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

function loadHistory(){const box=document.getElementById('history-list');apiFetch('/api/history').then(r=>r.json()).then(rows=>{box.innerHTML=Array.isArray(rows)&&rows.length?rows.map(x=>`<div class="data-row"><div><b>${escapeHtml(x.description)}</b><small>${new Date(x.created_at).toLocaleString('ru-RU')}</small></div><strong>${Number(x.amount)>0?'+':''}${rub(x.amount)}</strong></div>`).join(''):'<div class="no-products">Операций пока нет</div>';}).catch(()=>box.textContent='Не удалось загрузить историю.');}

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
