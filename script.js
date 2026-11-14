const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const user = tg?.initDataUnsafe?.user;
const initData = tg?.initData || '';
if (!tg || !user || !initData) {
    const notice = 'Авторизация Telegram не получена. Откройте магазин через кнопку «Открыть магазин» в Telegram-боте.';
    const list = document.getElementById('products-list');
    if (list) list.innerText = notice;
    document.querySelectorAll('[onclick]').forEach(el => { el.style.pointerEvents = 'none'; el.setAttribute('aria-disabled','true'); });
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
let paymentReadiness = {};
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
    if(paymentReadiness[method]===false){alert('Этот способ оплаты пока не настроен. Выберите доступный способ.');return;}
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
    document.getElementById('profileName').value = data.display_name || '';
    document.getElementById('profileAvatarUrl').value = data.avatar_url || '';
    document.getElementById('profile-display-name').textContent = data.display_name || (data.username ? '@'+data.username : 'Пользователь');
    const avatar=document.getElementById('profile-avatar');
    if(data.avatar_url){avatar.src=data.avatar_url;avatar.style.visibility='visible';}else{avatar.removeAttribute('src');avatar.style.visibility='hidden';}
    if(['owner','support','admin'].includes(data.role)) document.getElementById('nav-manage').classList.remove('hidden');
    if(data.role!=='owner'){
      document.querySelector('.owner-heading').classList.add('hidden');
      document.querySelector('.owner-stats-grid').classList.add('hidden');
      document.getElementById('owner-sellers-list').parentElement.classList.add('hidden');
      document.getElementById('owner-user-card').classList.add('hidden');
      document.getElementById('support-ban-card').classList.toggle('hidden',data.role!=='support');
    } else {
      document.getElementById('support-ban-card').classList.add('hidden');
    }
    if(data.role==='support'||data.role==='admin') document.getElementById('owner-key-gen').classList.add('hidden');
    
    if(data.role === 'owner') document.getElementById('owner-key-gen').style.display = 'block';

    if(data.role === 'seller' || data.role === 'admin' || data.role === 'owner') {
        document.getElementById('seller-product-card').classList.remove('hidden');
        document.getElementById('key-activation-card').classList.add('hidden');
    }

    loadProducts();
    loadPaymentReadiness();
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
 'Telegram':['Дизайн ТГК','Аренда NFT','Разработка ботов','Stars','Подписчики','Просмотры и реакции'],
 'Instagram':['Аккаунты','Подписчики','Лайки','Просмотры','Комментарии'],
 'TikTok':['Аккаунты','Подписчики','Лайки','Просмотры'],
 'YouTube':['Каналы','Подписчики','Просмотры','Монетизация'],
 'Discord':['Серверы','Nitro','Бусты','Аккаунты'],
 'VK':['Сообщества','Подписчики','Оформление'],
 'Roblox':['Аккаунты','Robux','Буст','Предметы'],
 'Minecraft':['Аккаунты','Серверы','Привилегии'],
 'Genshin Impact':['Кристаллы','Луна','Аккаунты'],
 'PUBG Mobile':['UC','Аккаунты','Буст'],
 'Free Fire':['Алмазы','Аккаунты'],
 'Mobile Legends':['Алмазы','Аккаунты','Буст'],
 'Brawl Stars':['Гемы','Аккаунты','Буст'],
 'Fortnite':['V-Bucks','Аккаунты','Предметы'],
 'Valorant':['Points','Аккаунты','Буст'],
 'CS2':['Скины','Аккаунты','Услуги'],
 'Dota 2':['Предметы','Аккаунты','Услуги'],
 'Steam':['Пополнение кошелька','Аккаунты','Игры','Предметы'],
 'PlayStation':['Пополнение кошелька','Подписка PS Plus','Аккаунты'],
 'Xbox':['Пополнение кошелька','Game Pass','Аккаунты'],
 'Nintendo':['Пополнение','Подписки','Аккаунты'],
 'VPN':['Доступ на 1 месяц','Доступ на 1 год','Прокси'],
 'Подписки':['Premium','Plus','Pro','Семейные подписки'],
 'Аккаунты':['Аккаунты сервисов','Игровые аккаунты','Почта'],
 'Пополнение':['Донат','Внутриигровая валюта','Подарочные карты'],
 'Программное обеспечение':['Лицензии','Ключи активации','Подписки'],
 'Дизайн':['Аватары','Баннеры','Логотипы','Оформление каналов'],
 'Услуги':['Буст','Помощь','Консультации','Другое']
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
            alert('Заявка отправлена владельцу и поддержке. Товар появится в каталоге после одобрения.');
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
            const box=document.getElementById('generatedKeyResult');
            box.innerHTML='<p>Новый ключ доступа (сохрани его сейчас):</p><div class="copy-key" id="generated-key-value"></div><button onclick="copyGeneratedKey()">Скопировать ключ</button>';
            document.getElementById('generated-key-value').textContent=data.key;
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
        if(data.invoiceLink) {
            try { localStorage.setItem('world_tg_pending_payment',String(data.paymentId)); } catch(e) {}
            if (!tg || typeof tg.openInvoice !== 'function') { alert('Откройте оплату внутри Telegram Mini App.'); return; }
            tg.openInvoice(data.invoiceLink, status => {
                if (status === 'paid') {
                    alert('Telegram подтвердил оплату. Проверяем зачисление баланса…');
                    resumePendingPayment();
                } else if (status === 'failed') {
                    alert('Не удалось провести оплату Stars. Попробуйте ещё раз.');
                }
            });
        } else if(data.directTransfer) {
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

    if(tabName === 'manage') {
      if(currentRole==='owner'){loadOwnerStats();loadOwnerSellers();loadKeyHistory();}
      if(['owner','support'].includes(currentRole)) loadModeration();
    }
    if(tabName === 'history') loadHistory();
    if(tabName === 'profile') loadMyActivity();
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

async function loadPaymentReadiness(){
 const box=document.getElementById('payment-readiness');
 try{
  const status=await fetch('/health/payments').then(r=>r.json());
  paymentReadiness=status;
  const names={cryptobot:'CryptoBot',sbp:'СБП',card:'Банковская карта',direct_transfer:'TON / USDT',telegram_stars:'Telegram Stars'};
  const ready=Object.keys(names).filter(k=>status[k]);
  Object.keys(names).forEach(k=>{
   const el=document.getElementById('method-'+k);if(!el)return;
   el.classList.toggle('unavailable',!status[k]);el.title=status[k]?'Доступно':'Не настроено на сервере';
  });
  if(!status[selectedPaymentMethod]&&ready.length){selectedPaymentMethod=ready[0];const el=document.getElementById('method-'+selectedPaymentMethod);document.querySelectorAll('.pay-method-item').forEach(x=>x.classList.remove('selected'));el?.classList.add('selected');document.getElementById('directAssetWrap').classList.toggle('hidden',selectedPaymentMethod!=='direct_transfer');}
  if(box)box.textContent=ready.length?'Доступны: '+ready.map(k=>names[k]).join(', '):'Платёжные провайдеры пока не настроены. Напишите в поддержку.';
 }catch(e){if(box)box.textContent='Не удалось проверить способы оплаты.';}
}
function copyGeneratedKey(){
 const value=document.getElementById('generated-key-value')?.textContent||'';
 if(!value)return;
 if(navigator.clipboard?.writeText)navigator.clipboard.writeText(value).then(()=>alert('Ключ скопирован')).catch(()=>prompt('Скопируйте ключ:',value));
 else prompt('Скопируйте ключ:',value);
}
async function createTransferCode(){
 const amount=Number(document.getElementById('transferAmount').value),box=document.getElementById('transfer-code-result');
 if(!Number.isFinite(amount)||amount<=0){alert('Сумма должна быть положительной.');return;}
 try{
  const r=await jsonPost('/api/transfers/create',{amount}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');
  box.classList.remove('hidden');box.innerHTML='<p>Передай получателю этот код. Он одноразовый и действует 24 часа:</p><div class="copy-key" id="new-transfer-code"></div><p><b>Сумма: '+rub(d.amount)+'</b></p><button onclick="copyTransferCode()">Скопировать код</button>';
  document.getElementById('new-transfer-code').textContent=d.code;
  const me=await apiFetch('/api/user',{method:'POST'}).then(x=>x.json());document.getElementById('user-balance').textContent=rub(me.balance);
 }catch(e){alert(e.message);}
}
function copyTransferCode(){
 const v=document.getElementById('new-transfer-code')?.textContent||'';
 if(navigator.clipboard?.writeText)navigator.clipboard.writeText(v).then(()=>alert('Код скопирован')).catch(()=>prompt('Скопируйте код:',v));else prompt('Скопируйте код:',v);
}
async function redeemTransferCode(){
 const code=document.getElementById('redeemTransferCode').value.trim(),box=document.getElementById('transfer-redeem-result');
 try{
  const r=await jsonPost('/api/transfers/redeem',{code}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');
  box.textContent='Зачислено '+rub(d.amount)+'.';document.getElementById('redeemTransferCode').value='';
  const me=await apiFetch('/api/user',{method:'POST'}).then(x=>x.json());document.getElementById('user-balance').textContent=rub(me.balance);
 }catch(e){box.textContent=e.message;}
}
async function saveProfileSettings(){
 try{
  const r=await apiFetch('/api/profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({display_name:document.getElementById('profileName').value,avatar_url:document.getElementById('profileAvatarUrl').value})});
  const d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');
  document.getElementById('profile-display-name').textContent=d.display_name||'Пользователь';
  const img=document.getElementById('profile-avatar');if(d.avatar_url){img.src=d.avatar_url;img.style.visibility='visible';}else{img.removeAttribute('src');img.style.visibility='hidden';}
  alert('Настройки профиля сохранены.');
 }catch(e){alert(e.message);}
}
async function loadMyActivity(){
 const box=document.getElementById('my-activity');if(!box)return;
 try{
  const d=await apiFetch('/api/my/activity').then(r=>r.json());if(d.error)throw new Error(d.error);
  const render=(arr,kind)=>arr.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.title||('Перевод #'+x.id))+'</b><small>'+escapeHtml(x.status)+' · '+new Date(x.created_at).toLocaleString('ru-RU')+'</small></div><strong>'+rub(x.amount)+'</strong>'+(kind==='purchase'&&x.status!=='refunded'&&['owner','support'].includes(currentRole)?'<button onclick="refundOrder('+x.id+')">Возврат</button>':'')+'</div>').join('');
  box.innerHTML='<h4>Покупки</h4>'+(d.purchases.length?d.purchases.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.title)+'</b><small>'+escapeHtml(x.store_name||'Магазин')+' · '+escapeHtml(x.status)+' · '+new Date(x.created_at).toLocaleString('ru-RU')+'</small></div><strong>'+rub(x.amount)+'</strong>'+(kindRefundAllowed()&&x.status!=='refunded'?'<button onclick="refundOrder('+x.id+')">Возврат</button>':'')+'</div>').join(''):'<p>Покупок пока нет</p>')+'<h4>Продажи</h4>'+(d.sales.length?render(d.sales,'sale'):'<p>Продаж пока нет</p>')+'<h4>Переводы</h4>'+(d.transfers.length?d.transfers.map(x=>'<div class="data-row"><div><b>'+(x.direction==='sent'?'Отправлено':'Получено')+'</b><small>'+escapeHtml(x.status)+' · '+new Date(x.created_at).toLocaleString('ru-RU')+'</small></div><strong>'+rub(x.amount)+'</strong></div>').join(''):'<p>Переводов пока нет</p>');
 }catch(e){box.textContent=e.message;}
}
async function kindRefundAllowed(){return ['owner','support'].includes(currentRole);}
function refundOrder(id){
 const reason=prompt('Причина возврата:','Возврат по обращению покупателя');if(reason===null)return;
 try{const r=await jsonPost('/api/orders/'+id+'/refund',{reason}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');alert('Возврат '+rub(d.amount)+' оформлен.');loadMyActivity();}catch(e){alert(e.message);}
}
async function adjustSupportBalance(){
 const target_id=document.getElementById('supportLookupId').value.trim(),amount=Number(document.getElementById('supportBalanceDelta').value);
 if(!/^\d{1,20}$/.test(target_id)||!Number.isFinite(amount)||amount===0){alert('Укажите Telegram ID и ненулевую сумму.');return;}
 try{const r=await jsonPost('/api/admin/action',{action:'balance',target_id,amount}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');alert('Баланс изменён.');lookupUser();}catch(e){alert(e.message);}
}
async function loadKeyHistory(){
 const box=document.getElementById('key-history-list');if(!box)return;
 try{const r=await apiFetch('/api/owner/keys'),rows=await r.json();if(!r.ok)throw new Error(rows.error||'Ошибка');
 box.innerHTML=rows.length?rows.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.role.toUpperCase())+'</b><small>Создан: '+new Date(x.created_at).toLocaleString('ru-RU')+' · '+(x.used_by?'Активирован: '+escapeHtml(x.used_username||x.used_by):'Не использован')+'</small></div></div>').join(''):'<p>Коды ещё не создавались.</p>';
 }catch(e){box.textContent=e.message;}
}
async function lookupUser(){
 const id=document.getElementById('supportLookupId').value.trim(),box=document.getElementById('support-user-result');
 if(!/^\d{1,20}$/.test(id)){alert('Введите корректный Telegram ID.');return;}
 box.classList.remove('hidden');box.textContent='Загружаем историю…';
 try{
  const r=await apiFetch('/api/support/user/'+encodeURIComponent(id)),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');
  const u=d.user;
  box.innerHTML='<h4>'+(escapeHtml(u.username?'@'+u.username:u.telegram_id))+'</h4><p>ID: '+escapeHtml(u.telegram_id)+' · Роль: '+escapeHtml(u.role)+' · Баланс: <b>'+rub(u.balance)+'</b></p><p>Статус: '+(u.is_banned?'Заблокирован':'Активен')+'</p><h4>Пополнения и списания</h4>'+
   (d.transactions.length?d.transactions.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.description)+'</b><small>'+escapeHtml(x.type)+' · '+new Date(x.created_at).toLocaleString('ru-RU')+'</small></div><strong>'+rub(x.amount)+'</strong></div>').join(''):'<p>Операций нет</p>')+
   '<h4>Покупки</h4>'+(d.purchases.length?d.purchases.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.title)+'</b><small>Заказ #'+x.id+' · '+escapeHtml(x.status)+'</small></div><strong>'+rub(x.amount)+'</strong>'+(x.status!=='refunded'?'<button onclick="refundOrder('+x.id+')">Возврат</button>':'')+'</div>').join(''):'<p>Покупок нет</p>')+
   '<h4>Переводы средств</h4>'+(d.transfers.length?d.transfers.map(x=>'<div class="data-row"><div><b>'+(String(x.sender_id)===id?'Отправлено':'Получено')+'</b><small>'+escapeHtml(x.status)+' · ID получателя: '+escapeHtml(x.recipient_id||'—')+'</small></div><strong>'+rub(x.amount)+'</strong></div>').join(''):'<p>Переводов нет</p>');
 }catch(e){box.textContent=e.message;}
}
async function requestBan(){
 const telegram_id=document.getElementById('banTargetId').value.trim(),reason=document.getElementById('banReason').value.trim(),raw=document.getElementById('banDuration').value;
 const duration_hours=raw===''?null:Number(raw),out=document.getElementById('ban-request-result');
 try{const r=await jsonPost('/api/support/ban-request',{telegram_id,reason,duration_hours}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');out.textContent='Запрос отправлен владельцу. Ожидайте решения.';}catch(e){out.textContent=e.message;}
}
async function loadModeration(){
 const box=document.getElementById('moderation-list');if(!box)return;
 try{
  const r=await apiFetch('/api/moderation/pending'),rows=await r.json();if(!r.ok)throw new Error(rows.error||'Ошибка');
  box.innerHTML=rows.length?rows.map(m=>'<div class="data-row"><div><b>Заявка #'+m.id+' · '+(m.kind==='product'?'Публикация товара':'Блокировка пользователя')+'</b><small>'+(m.product_title?escapeHtml(m.product_title):'Telegram ID '+escapeHtml(m.target_user_id||''))+' · '+escapeHtml(m.reason||'')+(m.kind==='ban'?' · Срок: '+(m.duration_hours?m.duration_hours+' ч.':'навсегда'):'')+'</small></div><div class="action-row">'+(m.kind==='ban'&&currentRole!=='owner'?'Ожидает решения владельца':'<button onclick="decideModeration('+m.id+',\'approve\')">Одобрить</button><button class="danger-button" onclick="decideModeration('+m.id+',\'reject\')">Отклонить</button>')+'</div></div>').join(''):'<p>Ожидающих заявок нет.</p>';
 }catch(e){box.textContent=e.message;}
}
async function decideModeration(request_id,decision){
 if(!confirm(decision==='approve'?'Одобрить заявку?':'Отклонить заявку?'))return;
 try{const r=await jsonPost('/api/moderation/decision',{request_id,decision}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');loadModeration();loadProducts();}catch(e){alert(e.message);}
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
