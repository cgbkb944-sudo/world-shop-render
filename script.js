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
function showSubscriptionGate(data = {}) {
    const gate = document.getElementById('subscription-gate');
    if (!gate) return;
    const link = document.getElementById('subscription-channel-link');
    if (link && data.channel_url) link.href = data.channel_url;
    gate.classList.remove('hidden');
}
async function checkSubscription() {
    const button = document.getElementById('subscription-check-button');
    const status = document.getElementById('subscription-status');
    if (button) button.disabled = true;
    if (status) status.textContent = 'Проверяем подписку…';
    try {
        const response = await fetch('/api/subscription/check', {
            method: 'POST',
            headers: { 'X-Telegram-Init-Data': initData, 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await response.json();
        if (response.ok && data.success) {
            if (status) status.textContent = data.rewarded ? 'Подписка подтверждена! Начислено 10 ₽.' : 'Подписка подтверждена! Бонус ранее уже был получен.';
            location.reload();
            return;
        }
        if (status) status.textContent = data.error || 'Подписка пока не найдена. Подпишитесь на канал и попробуйте снова.';
        if (data.channel_url) document.getElementById('subscription-channel-link').href = data.channel_url;
    } catch {
        if (status) status.textContent = 'Не удалось связаться с сервером. Попробуйте ещё раз.';
    } finally {
        if (button) button.disabled = false;
    }
}
function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('X-Telegram-Init-Data', initData);
    return fetch(url, { ...options, headers }).then(async response => {
        if (response.status === 403) {
            try { const data = await response.clone().json(); if (data.subscription_required) showSubscriptionGate(data); } catch {}
        }
        return response;
    });
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
let activeDirectWalletLinks = null;
let directPaymentPoll = null;
let currentRole='user';
function rub(value){return Number(value||0).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';}
function jsonPost(url,body){return apiFetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
async function loadPromoCodes(){
 const box=document.getElementById('promo-codes-list');if(!box)return;box.textContent='Загружаем промокоды…';
 try{const r=await apiFetch('/api/promos'),rows=await r.json();if(!r.ok)throw new Error(rows.error||'Ошибка');
 box.innerHTML=rows.length?rows.map(p=>{const expiry=p.expires_at?'до '+new Date(p.expires_at).toLocaleString('ru-RU'):'без срока';const state=p.is_active?'активен':'отключён';return `<div class="data-row"><div><b>${escapeHtml(p.code)}</b><small>${escapeHtml(p.promo_type)} · ${escapeHtml(p.value)} · ${p.uses_count}/${p.max_uses} активаций · ${expiry} · ${state}</small></div>${p.is_active?`<button class="danger-button" onclick="disablePromo('${escapeHtml(p.code)}')">Отключить</button>`:''}</div>`;}).join(''):'<p>Промокодов пока нет.</p>';
 }catch(e){box.textContent=e.message;}
}
async function createPromoFromPanel(){
 const type=document.getElementById('promo-type').value,value=Number(document.getElementById('promo-value').value),max_uses=Number(document.getElementById('promo-max-uses').value),expires_hours=Number(document.getElementById('promo-expires-hours').value),result=document.getElementById('promo-create-result');
 result.textContent='Создаём промокод…';
 try{const r=await jsonPost('/api/promos/create',{type,value,max_uses,expires_hours}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка создания');
 result.textContent='Создан код '+d.promo.code+' · действует '+(expires_hours?expires_hours+' ч.':'без ограничения')+'.';if(navigator.clipboard?.writeText)navigator.clipboard.writeText(d.promo.code).catch(()=>{});loadPromoCodes();
 }catch(e){result.textContent=e.message;}
}
async function disablePromo(code){
 if(!confirm('Отключить промокод '+code+'?'))return;
 try{const r=await jsonPost('/api/promos/'+encodeURIComponent(code)+'/disable',{}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');loadPromoCodes();}catch(e){alert(e.message);}
}
function loadOwnerStats(){
  apiFetch('/api/owner/overview').then(r=>r.json()).then(d=>{
    if(d.error)throw new Error(d.error);
    document.getElementById('stats-total-users').textContent=d.total_users;
    document.getElementById('stats-sales-volume').textContent=rub(d.sales_volume);
    document.getElementById('stats-shop-revenue').textContent=rub(d.shop_revenue);
    const shopBalance=document.getElementById('stats-shop-balance');if(shopBalance)shopBalance.textContent=rub(d.shop_balance);
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
    box.innerHTML=`<div class="section-title"><h3>${escapeHtml(u.username?'@'+u.username:u.telegram_id)}</h3><button class="small-action" onclick="document.getElementById('seller-detail').classList.add('hidden')">Закрыть</button></div><p>ID: ${escapeHtml(u.telegram_id)} · Роль: ${escapeHtml(u.role)} · Баланс аккаунта: ${rub(u.balance)} · Баланс продавца: ${rub(u.seller_balance)}</p><p>Заработано: <b>${rub(d.totalEarned)}</b> · Товаров: ${d.products.length} · Заказов: ${d.orders.length}</p><h4>Товары</h4>${d.products.length?d.products.map(p=>`<div class="data-row"><div><b>${escapeHtml(p.title)}</b><small>${escapeHtml(p.status)} · ${rub(p.price)}</small></div></div>`).join(''):'<p>Нет товаров</p>'}<h4 style="margin-top:14px">Последние продажи</h4>${d.orders.length?d.orders.slice(0,10).map(o=>`<div class="data-row"><div><b>#${o.id} · ${escapeHtml(o.title)}</b><small>${rub(o.amount)} · ${escapeHtml(o.status)}</small></div></div>`).join(''):'<p>Продаж пока нет</p>'}${'<h4 style="margin-top:14px">История операций</h4>'}${d.transactions.length?d.transactions.slice(0,20).map(t=>`<div class="data-row"><div><b>${escapeHtml(t.description)}</b><small>${escapeHtml(t.type)} · ${new Date(t.created_at).toLocaleString('ru-RU')}</small></div><strong>${Number(t.amount)>0?'+':''}${rub(t.amount)}</strong></div>`).join(''):'<p>Операций пока нет</p>'}`;
  }).catch(e=>box.textContent=e.message);
}
function loadOwnerWithdrawals(){
 const box=document.getElementById('owner-withdrawals-list');if(!box)return;box.textContent='Загружаем заявки…';
 apiFetch('/api/owner/withdrawals').then(r=>r.json()).then(rows=>{
  if(!Array.isArray(rows))throw new Error(rows.error||'Ошибка');
  box.innerHTML=rows.length?rows.map(w=>{const d=w.payout_details||{};const details=w.method==='stars'?`${d.stars||w.amount} ⭐`:w.method==='rub'?`${d.channel==='phone'?'Телефон':'Электронный кошелёк'}: ${escapeHtml(d.value||'')} · ${escapeHtml(d.bank||'')}`:`${escapeHtml(d.asset||'')} / ${escapeHtml(d.network||'')} · ${escapeHtml(d.address||'')}`;return `<div class="data-row"><div><b>Заявка #${w.id} · ${escapeHtml(w.username?'@'+w.username:w.seller_id)}</b><small>${rub(w.amount)} · ${escapeHtml(w.method)} · ${details} · ${escapeHtml(w.status)}</small></div>${w.status==='pending'?`<button onclick="decideWithdrawal(${w.id},'paid')">Выплачено</button><button class="danger-button" onclick="decideWithdrawal(${w.id},'rejected')">Отклонить</button>`:''}</div>`;}).join(''):'<div class="no-products">Заявок пока нет</div>';
 }).catch(e=>box.textContent=e.message);
}
async function decideWithdrawal(id,decision){
 const note=decision==='rejected'?prompt('Причина отклонения (необязательно):',''):'';if(note===null)return;
 try{const r=await jsonPost('/api/owner/withdrawals/'+id+'/decision',{decision,note}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');loadOwnerWithdrawals();alert(decision==='paid'?'Заявка отмечена как выплаченная.':'Заявка отклонена, средства возвращены продавцу.');}catch(e){alert(e.message);}
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
 const duration_hours=document.getElementById('ownerBanDuration')?.value||null;
 const reason=document.getElementById('ownerBanReason')?.value||'';
 jsonPost('/api/admin/action',{action:ban?'ban':'unban',target_id,duration_hours,reason}).then(async r=>({ok:r.ok,d:await r.json()})).then(x=>{if(!x.ok)throw new Error(x.d.error);alert(ban?'Пользователь заблокирован':'Блокировка снята');}).catch(e=>alert(e.message));
}


async function loadSellerWallet(){
 try{const r=await apiFetch('/api/seller/wallet'),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');
  document.getElementById('seller-balance').textContent=rub(d.balance);
  const box=document.getElementById('seller-withdrawal-history');
  box.innerHTML=d.withdrawals.length?d.withdrawals.map(w=>`<div class="data-row"><div><b>Заявка #${w.id} · ${rub(w.amount)}</b><small>${escapeHtml(w.method)} · ${escapeHtml(w.status)} · ${new Date(w.created_at).toLocaleString('ru-RU')}${w.decision_note?' · '+escapeHtml(w.decision_note):''}</small></div></div>`).join(''):'<p>Заявок пока нет.</p>';
 }catch(e){document.getElementById('seller-withdrawal-history').textContent=e.message;}
}
function updateWithdrawalFields(){
 const method=document.getElementById('withdrawMethod').value,asset=document.getElementById('withdrawCryptoAsset').value;
 document.getElementById('withdraw-rub-fields').classList.toggle('hidden',method!=='rub');
 document.getElementById('withdraw-crypto-fields').classList.toggle('hidden',method!=='crypto');
 document.getElementById('withdraw-stars-fields').classList.toggle('hidden',method!=='stars');
 const network=document.getElementById('withdrawCryptoNetwork');
 if(asset==='TON'){network.value='TON';network.disabled=true;}else{network.disabled=false;}
}
async function submitWithdrawal(){
 const amount=Number(document.getElementById('withdrawAmount').value),method=document.getElementById('withdrawMethod').value;let details={};
 if(method==='rub')details={channel:document.getElementById('withdrawRubChannel').value,value:document.getElementById('withdrawRubValue').value,bank:document.getElementById('withdrawRubBank').value};
 if(method==='crypto')details={asset:document.getElementById('withdrawCryptoAsset').value,network:document.getElementById('withdrawCryptoNetwork').value,address:document.getElementById('withdrawCryptoAddress').value};
 const result=document.getElementById('withdrawal-result');result.textContent='';
 if(!Number.isFinite(amount)||amount<=0){result.textContent='Введите корректную сумму.';return;}
 try{const r=await jsonPost('/api/withdrawals',{amount,method,details}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');result.textContent='Заявка #'+d.request_id+'. '+(d.message||'Заявка создана.');document.getElementById('withdrawAmount').value='';loadSellerWallet();}catch(e){result.textContent=e.message;}
}

function setAmount(val) {
    document.getElementById('payAmount').value = val;
    document.querySelectorAll('.quick-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.quick-btn').forEach(btn => { if (Number(btn.textContent.replace(/[^0-9.]/g, '')) === Number(val)) btn.classList.add('active'); });
}

function selectMethod(method, element) {
    if(paymentReadiness[method]===false){alert('Этот способ оплаты пока не настроен. Выберите доступный способ.');return;}
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
    if (data.subscription_required) return;
    if (data.error) throw new Error(data.error);
    currentRole = data.role;
    const promoCard=document.getElementById('promo-management-card');if(promoCard){promoCard.style.display=['owner','admin','support'].includes(data.role)?'block':'none';if(['owner','admin','support'].includes(data.role))loadPromoCodes();}
    document.getElementById('userrole-badge').innerText = data.role.toUpperCase();
    document.getElementById('user-balance').innerText = rub(data.balance);
    document.getElementById('profileName').value = data.display_name || '';
    document.getElementById('profileAvatarUrl').value = data.avatar_url || user.photo_url || '';
    document.getElementById('profile-display-name').textContent = data.display_name || (data.username ? '@'+data.username : 'Пользователь');
    const avatar=document.getElementById('profile-avatar');
    const shownAvatar=data.avatar_url || user.photo_url || '';
    if(shownAvatar){avatar.src=shownAvatar;avatar.style.visibility='visible';}else{avatar.removeAttribute('src');avatar.style.visibility='hidden';}
    if(['owner','support','admin'].includes(data.role)) document.getElementById('nav-manage').classList.remove('hidden');
    document.getElementById('owner-withdrawals-card').classList.toggle('hidden',data.role!=='owner');
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
    if(data.role==='seller'||data.role==='admin')document.getElementById('seller-wallet-card').classList.remove('hidden');
    if(data.role==='seller'||data.role==='admin')loadSellerWallet();
    if(data.role==='seller')loadSellerProducts();

    if(data.role === 'seller' || data.role === 'admin' || data.role === 'owner') {
        document.getElementById('seller-product-card').classList.remove('hidden');
    }

    document.getElementById('manage-products-card')?.classList.toggle('hidden',!['owner','support'].includes(data.role));
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
        renderCatalogCategories();
        filterProducts();
    }).catch(() => {
        document.getElementById('products-list').innerHTML = '<div class="no-products">Не удалось загрузить каталог. Попробуйте обновить страницу.</div>';
    });
}

let selectedCatalogCategory = 'Все товары';
let selectedCatalogSubcategory = 'Все подкатегории';

const catalogCategoryLabels = {
    VK: 'ВКонтакте',
    VPN: 'VPN и прокси',
    Подписки: 'Подписки и премиум',
    'Баллы магазинов': 'Баллы магазинов и программы лояльности',
    Аккаунты: 'Аккаунты и профили',
    Пополнение: 'Пополнение баланса и донат',
    'Программное обеспечение': 'Программы и ПО',
    Дизайн: 'Дизайн и оформление',
    Услуги: 'Услуги и другое'
};

function toggleCatalogMenu(force) {
    const menu = document.getElementById('catalog-menu');
    const button = document.getElementById('catalog-toggle');
    if (!menu || !button) return;
    const shouldOpen = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !shouldOpen);
    button.setAttribute('aria-expanded', String(shouldOpen));
}

function selectCatalogCategory(category) {
    selectedCatalogCategory = category;
    selectedCatalogSubcategory = 'Все подкатегории';
    const button = document.getElementById('catalog-toggle');
    if (button) button.textContent = category === 'Все товары' ? '☷ Каталог' : '☷ ' + (catalogCategoryLabels[category] || category);
    renderCatalogCategories();
    filterProducts();

    toggleCatalogMenu(false);
}

function selectCatalogSubcategory(subcategory) {
    selectedCatalogSubcategory = subcategory;
    renderCatalogCategories();
    filterProducts();
    toggleCatalogMenu(false);
}

const comingSoonCatalogProducts = [
 {id:'soon-vpn',title:'VPN — подписка',category:'VPN',subcategory:'VPN-доступ',price:0,description:'Подписки на VPN-сервисы. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-esim',title:'eSIM — виртуальная SIM-карта',category:'eSIM',subcategory:'eSIM QR-код',price:0,description:'eSIM для поездок и интернета. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-stars',title:'Telegram Stars',category:'Telegram',subcategory:'Stars',price:0,description:'Пополнение Telegram Stars. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-premium',title:'Telegram Premium',category:'Telegram',subcategory:'Telegram Premium',price:0,description:'Подписка Telegram Premium на разные сроки. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-robux',title:'Robux',category:'Roblox',subcategory:'Robux',price:0,description:'Пополнение игровой валюты Roblox. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-roblox-accounts',title:'Аккаунты Roblox',category:'Roblox',subcategory:'Аккаунты',price:0,description:'Игровые аккаунты Roblox. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-game-keys',title:'Ключи для игр и программ',category:'Программное обеспечение',subcategory:'Цифровые ключи',price:0,description:'Цифровые ключи и лицензии. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-game-topup',title:'Игровые пополнения и донат',category:'Пополнение',subcategory:'Игровой донат',price:0,description:'Пополнение баланса и игровые товары. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-accounts',title:'Цифровые аккаунты',category:'Аккаунты',subcategory:'Аккаунты и профили',price:0,description:'Аккаунты и цифровые профили. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-subscriptions',title:'Подписки на сервисы',category:'Подписки',subcategory:'Подписки и премиум',price:0,description:'Подписки на популярные цифровые сервисы. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true},
 {id:'soon-social',title:'Услуги для соцсетей',category:'Услуги',subcategory:'Продвижение',price:0,description:'Услуги и оформление социальных сетей. Скоро будет в наличии.',seller_name:'WORLD TG SHOP',coming_soon:true}
];
function getCatalogProducts(){return [...allProducts,...comingSoonCatalogProducts];}

function renderCatalogCategories() {
    const menu = document.getElementById('catalog-menu');
    if (!menu) return;
    const counts = new Map();
    const canonicalCategory = value => {
        const raw = String(value || 'Без категории').trim() || 'Без категории';
        const known = Object.keys(subsByCat || {}).find(item => normalizeCatalogCategory(item) === normalizeCatalogCategory(raw));
        return known || raw;
    };
    getCatalogProducts().forEach(product => {
        const category = canonicalCategory(product.category);
        const subcategory = String(product.subcategory || 'Общее').trim() || 'Общее';
        counts.set(category, (counts.get(category) || 0) + 1);
        const key = category + '::' + subcategory;
        counts.set(key, (counts.get(key) || 0) + 1);
    });

    const knownCategories = Object.keys(subsByCat || {});
    const extraCategories = Array.from(new Set(getCatalogProducts().map(p => canonicalCategory(p.category))))
        .filter(category => !knownCategories.includes(category));
    const categories = ['Все товары', ...knownCategories, ...extraCategories];
    const categoryButtons = categories.map(category => {
        const count = category === 'Все товары' ? getCatalogProducts().length : (counts.get(category) || 0);
        const label = category === 'Все товары' ? category : (catalogCategoryLabels[category] || category);
        return `<button type="button" class="catalog-category ${selectedCatalogCategory === category ? 'active' : ''}" onclick="selectCatalogCategory(${JSON.stringify(category).replace(/</g,'\\u003c')})"><span>${escapeHtml(label)}</span><small>${count}</small></button>`;
    }).join('');

    let subcategorySection = '';
    if (selectedCatalogCategory !== 'Все товары') {
        const subcategories = subsByCat[selectedCatalogCategory] || [];
        const allSubCount = counts.get(selectedCatalogCategory) || 0;
        const options = ['Все подкатегории', ...subcategories];
        subcategorySection = `
            <div class="catalog-subheading">Подкатегории · ${escapeHtml(catalogCategoryLabels[selectedCatalogCategory] || selectedCatalogCategory)}</div>
            <div class="catalog-subcategories">
                ${options.map(sub => {
                    const count = sub === 'Все подкатегории' ? allSubCount : (counts.get(selectedCatalogCategory + '::' + sub) || 0);
                    return `<button type="button" class="catalog-subcategory ${selectedCatalogSubcategory === sub ? 'active' : ''}" onclick="selectCatalogSubcategory(${JSON.stringify(sub).replace(/</g,'\\u003c')})"><span>${escapeHtml(sub)}</span><small>${count}</small></button>`;
                }).join('')}
            </div>`;
    }
    menu.innerHTML = `<div class="catalog-category-grid">${categoryButtons}</div>${subcategorySection}`;
}

function renderProducts(products) {
    const list = document.getElementById('products-list');
    if(products.length === 0) {
        list.innerHTML = '<div class="no-products">По выбранным условиям товары не найдены</div>';
        return;
    }
    list.innerHTML = products.map(p => {
        let priceText = `${p.price} ₽`;
        if (p.price_from && p.max_price) priceText = `от ${p.price} до ${p.max_price} ₽`;
        else if (p.price_from) priceText = `от ${p.price} ₽`;
        if (p.coming_soon) return `
            <div class="product-item" style="opacity:.92">
                <div>
                    <b style="font-size:15px;">${escapeHtml(p.title)}</b>
                    <br><small style="color:var(--text-muted);">${escapeHtml(p.category)} / ${escapeHtml(p.subcategory)}</small>
                    <br><small style="display:block;color:#8b95a7;margin-top:5px;">Скоро будет в наличии</small>
                </div>
                <div style="text-align:right;">
                    <b style="display:block;margin-bottom:6px;color:var(--text-muted);">0 ₽</b>
                    <button type="button" disabled style="width:auto;padding:6px 14px;margin:0;font-size:13px;opacity:.5;cursor:not-allowed;">Скоро</button>
                </div>
            </div>`;
        const visualIcon = ({Telegram:'✈',Roblox:'◈',VPN:'⌁',eSIM:'▤',Steam:'◉',PlayStation:'△',Xbox:'✕',Подписки:'✦',Пополнение:'◉'})[p.category] || '✧';
        return `
            <div class="product-item">
                <div class="mini-product-art art-${escapeHtml(String(p.category||'digital').toLowerCase().replace(/[^a-zа-яё0-9]+/gi,'-'))}"><span>${visualIcon}</span><small>${escapeHtml(p.category||'DIGITAL GOODS')}</small></div>
                <div class="mini-product-info">
                    <b style="font-size: 15px;">${escapeHtml(p.title)}</b>
                    <br><small style="color:var(--text-muted);">${escapeHtml(p.category)} / ${escapeHtml(p.subcategory || 'Общее')} · ${escapeHtml(p.seller_name||'Магазин')}</small>
                </div>
                <div style="text-align: right;">
                    <b style="display:block; margin-bottom:6px; color:#818cf8;">${p.product_type === 'telegram_stars' ? `${Number(p.price).toFixed(2)} ₽ / ⭐` : p.product_type === 'telegram_premium' ? `${Number(p.price).toFixed(2)} ₽ / месяц Premium` : p.product_type === 'robux' ? `${Number(p.price).toFixed(2)} ₽ / Robux` : priceText}</b>
                    <button style="width:auto; padding:6px 14px; margin:0; font-size:13px;" onclick="buyProduct(${p.id})">Купить</button>
                </div>
            </div>`;
    }).join('');
}

function normalizeCatalogValue(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

function normalizeCatalogCategory(value) {
    const normalized = normalizeCatalogValue(value).replace(/ё/g, 'е');
    const aliases = {
        'genshin': 'genshin impact',
        'геншин': 'genshin impact',
        'вконтакте': 'vk',
        'в контакте': 'vk',
        'vpn и прокси': 'vpn',
        'tik tok': 'tiktok',
        'тик ток': 'tiktok',
        'тикток': 'tiktok'
    };
    return aliases[normalized] || normalized;
}

function filterProducts() {
    const query = normalizeCatalogValue(document.getElementById('searchInput')?.value || '');
    const selectedCategory = normalizeCatalogCategory(selectedCatalogCategory);
    const selectedSubcategory = normalizeCatalogValue(selectedCatalogSubcategory);
    const filtered = getCatalogProducts().filter(p => {
        const category = normalizeCatalogCategory(p.category || 'Без категории');
        const subcategory = normalizeCatalogValue(p.subcategory || 'Общее');
        const matchesCategory = selectedCatalogCategory === 'Все товары' || category === selectedCategory;
        const matchesSubcategory = selectedCatalogCategory !== 'Все товары' &&
            (selectedCatalogSubcategory === 'Все подкатегории' || subcategory === selectedSubcategory) ||
            selectedCatalogCategory === 'Все товары' && selectedCatalogSubcategory === 'Все подкатегории';
        const searchable = [p.title, p.category, p.subcategory, p.seller_name].map(normalizeCatalogValue).join(' ');
        return matchesCategory && matchesSubcategory && searchable.includes(query);
    });
    renderProducts(filtered);
}


const subsByCat = {
 'Telegram':['Дизайн ТГК','Аренда NFT','Разработка ботов','Stars','Telegram Premium','Подписчики','Просмотры и реакции'],
  'eSIM':['eSIM QR-код','Интернет 1 ГБ','Интернет 3 ГБ','Интернет 5 ГБ','Интернет 10 ГБ','Региональный пакет'],
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
 'Подписки':['Подписки на магазины','Клубные карты и абонементы','Telegram Premium','YouTube Premium','Spotify','Netflix','PlayStation Plus','Xbox Game Pass','VPN','Другие подписки'],
  'Баллы магазинов':['Баллы Пятёрочки','Баллы Магнит','Спасибо от Сбербанка','Бонусы Fix Price','Баллы других магазинов'],
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

function updateProductTypeHelp() {
    const type=document.getElementById('newProductType')?.value||'standard',help=document.getElementById('newProductTypeHelp'),priceLabel=document.getElementById('newPriceLabel');
    const special=['telegram_stars','telegram_premium','robux','roblox_account','telegram_account','digital_key'].includes(type);
    if(help)help.textContent=type==='telegram_stars'?'Укажите цену за одну звезду. Покупатель выберет от 50 до 1 000.':
      type==='telegram_premium'?'Укажите цену за 1 месяц Premium. Покупатель выберет срок от 1 до 12 месяцев и получателя.':
      type==='digital_key'?'Добавьте одноразовый цифровой ключ, VPN-конфигурацию или QR-файл eSIM. Покупатель получит его после оплаты.':
      type==='robux'?'Укажите цену за 1 Robux. Покупатель сможет заказать от 10 до 100 000 Robux.':
      type==='roblox_account'?'Добавьте данные аккаунта Roblox.':
      type==='telegram_account'?'Выберите Premium и способ передачи: файл выдаётся после оплаты, по номеру покупатель получает номер телефона.':
      type==='channel_customization'?'После покупки покупатель укажет username владельца и ссылку на канал.':
      type==='subscription'?'Покупатель укажет аккаунт или данные для оформления подписки.':
      type==='loyalty_points'?'Покупатель укажет номер телефона или идентификатор карты лояльности.':'Обычный товар или услуга.';
    if(priceLabel)priceLabel.textContent=type==='telegram_stars'?'Цена за одну звезду (₽):':type==='telegram_premium'?'Цена за 1 месяц Premium (₽):':type==='robux'?'Цена за 1 Robux (₽):':'Цена (₽):';
    document.getElementById('newPriceFrom')?.closest('div')?.classList.toggle('hidden',special);
    document.getElementById('newRobloxPrivateFields')?.classList.toggle('hidden',type!=='roblox_account');
    document.getElementById('newTelegramAccountFields')?.classList.toggle('hidden',type!=='telegram_account');
    document.getElementById('newDigitalKeyFields')?.classList.toggle('hidden',type!=='digital_key');
    if(special){const range=document.getElementById('newPriceFrom');if(range)range.checked=false;document.getElementById('maxPriceContainer')?.classList.add('hidden');}
}

function toggleTelegramDeliveryFields(){const m=document.getElementById('telegramDeliveryMethod')?.value||'file';document.getElementById('telegramFileFields')?.classList.toggle('hidden',m!=='file');document.getElementById('telegramPhoneFields')?.classList.toggle('hidden',m!=='phone');}
function toggleDigitalDeliveryFields(){const m=document.getElementById('digitalDeliveryMethod')?.value||'code';document.getElementById('digitalCodeFields')?.classList.toggle('hidden',m!=='code');document.getElementById('digitalFileFields')?.classList.toggle('hidden',m!=='file');}

async function addNewProduct() {
    const title=document.getElementById('newTitle').value,product_type=document.getElementById('newProductType')?.value||'standard';
    const category=document.getElementById('newCategory').value,subcategory=document.getElementById('newSubcategory').value;
    const price=document.getElementById('newPrice').value,price_from=document.getElementById('newPriceFrom').checked,max_price=document.getElementById('newMaxPrice').value;
    let private_data={};
    if(product_type==='roblox_account')private_data={
      roblox_username:document.getElementById('robloxAccountUsername').value.trim(),
      account_email:document.getElementById('robloxAccountEmail').value.trim(),
      account_password:document.getElementById('robloxAccountPassword').value,
      email_password:document.getElementById('robloxEmailPassword').value
    };
    if(product_type==='digital_key'){
      const delivery_method=document.getElementById('digitalDeliveryMethod').value;
      private_data={delivery_method};
      if(delivery_method==='code')private_data.code=document.getElementById('digitalKeyCode').value.trim();
      else {
        const file=document.getElementById('digitalKeyFile').files[0];
        if(!file){alert('Загрузите файл выдачи.');return;}
        if(file.size>5*1024*1024){alert('Максимальный размер файла — 5 МБ.');return;}
        private_data.file={name:file.name,mime:file.type||'application/octet-stream',data:await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);})};
      }
    }
    if(product_type==='telegram_account'){
      const delivery_method=document.getElementById('telegramDeliveryMethod').value;
      private_data={delivery_method,premium:document.getElementById('telegramPremium').value};
      if(delivery_method==='phone')private_data.phone=document.getElementById('telegramAccountPhone').value.trim();
      else {
        const file=document.getElementById('telegramAccountFile').files[0];
        if(!file){alert('Загрузите файл аккаунта.');return;}
        if(file.size>5*1024*1024){alert('Максимальный размер файла — 5 МБ.');return;}
        private_data.file={name:file.name,mime:file.type||'application/octet-stream',data:await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);})};
      }
    }
    if(!title||!price){alert('Заполните название и цену!');return;}
    if(product_type==='roblox_account'&&(!private_data.roblox_username||!private_data.account_email||!private_data.account_password||!private_data.email_password)){alert('Заполните username Roblox, почту и оба пароля.');return;}
    if(product_type==='telegram_account'&&private_data.delivery_method==='phone'&&!private_data.phone){alert('Укажите номер телефона.');return;}
    if(product_type==='digital_key'&&private_data.delivery_method==='code'&&!private_data.code){alert('Введите цифровой ключ или код.');return;}
    apiFetch('/api/products/add',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title,product_type,category,subcategory,price,price_from:['telegram_stars','telegram_premium','robux','roblox_account','telegram_account','digital_key'].includes(product_type)?false:price_from,max_price,private_data})})
    .then(async res=>{const data=await res.json();if(res.ok&&data.success){alert(data.pending?'Заявка отправлена на модерацию. Товар появится после одобрения.':'Товар опубликован от имени владельца и уже доступен в каталоге.');location.reload();}else alert(data.error||'Ошибка публикации товара');})
    .catch(()=>alert('Ошибка соединения с сервером'));
}
async function activateKey() {
    const field=document.getElementById('keyCode'), result=document.getElementById('key-activation-result');
    const code=String(field?.value||'').trim();
    if(!code){alert('Введите ключ или код пополнения.');return;}
    const isTransferCode=/^WTS-[A-F0-9]{10}$/i.test(code);
    const isOwnerKey=/^WTS-OWNER-[A-F0-9]{64}$/i.test(code);
    try{
      const endpoint=isOwnerKey?'/api/owner-key/activate':(isTransferCode?'/api/transfers/redeem':'/api/key/activate');
      const payload=isTransferCode?{code}:{key:code};
      const response=await apiFetch(endpoint,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload)
      });
      const data=await response.json();
      if(!response.ok||!data.success)throw new Error(data.error||'Не удалось обработать код.');
      if(isOwnerKey){
        if(result)result.textContent='Ключ владельца активирован в Telegram Mini App.';
        field.value='';
        alert('Ключ владельца успешно активирован в Mini App.');
        location.reload();
      }else if(isTransferCode||data.type==='topup'){
        if(result)result.textContent='Баланс пополнен на '+rub(data.amount)+'.';
        field.value='';
        const me=await apiFetch('/api/user',{method:'POST'}).then(r=>r.json());
        const balance=document.getElementById('user-balance');
        if(balance)balance.textContent=rub(me.balance);
        if(result)result.textContent+=' Код использован и больше не действует.';
      }else{
        if(result)result.textContent='Ключ активирован. Роль: '+data.role+'.';
        alert('Ключ успешно активирован! Ваша роль: '+data.role);
        location.reload();
      }
    }catch(error){if(result)result.textContent=error.message;else alert(error.message);}
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

function generateTopupCode() {
    const amount=Number(document.getElementById('topupCodeAmount').value);
    if(!Number.isFinite(amount)||amount<10||amount>10000000||Math.round(amount*100)/100!==amount){
      alert('Введите сумму от 10 ₽ с точностью до копеек.');return;
    }
    jsonPost('/api/key/generate-topup',{amount})
      .then(async r=>({ok:r.ok,data:await r.json()}))
      .then(({ok,data})=>{
        if(!ok||!data.success)throw new Error(data.error||'Не удалось создать код');
        const box=document.getElementById('topupCodeResult');
        box.innerHTML='<p>Одноразовый код на '+rub(data.amount)+'. Действует 30 дней, использовать можно один раз.</p><div class="copy-key" id="generated-topup-code"></div><button onclick="copyTopupCode()">Скопировать код</button>';
        document.getElementById('generated-topup-code').textContent=data.code;
        document.getElementById('topupCodeAmount').value='';
      }).catch(e=>alert(e.message));
}
function copyTopupCode() {
    const value=document.getElementById('generated-topup-code')?.textContent||'';
    if(!value)return;
    if(navigator.clipboard?.writeText)navigator.clipboard.writeText(value).then(()=>alert('Код пополнения скопирован')).catch(()=>alert(value));
    else alert(value);
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
    if(selectedPaymentMethod==='owner_transfer'){
        apiFetch('/api/payment/manual-transfer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})})
          .then(async res=>({ok:res.ok,data:await res.json()}))
          .then(({ok,data})=>{if(!ok)throw new Error(data.error||'Не удалось открыть чат владельца.');if(tg&&typeof tg.openTelegramLink==='function')tg.openTelegramLink(data.url);else window.location.href=data.url;})
          .catch(e=>alert(e.message));
        return;
    }
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
            activeDirectWalletLinks = data.walletLinks || {};
            document.getElementById('transferAssetTitle').innerText = data.asset === 'TON' ? 'TON' : 'USDT (TON)';
            document.getElementById('transferAmountText').innerText = data.cryptoAmount + ' ' + data.asset;
            document.getElementById('walletAddressText').innerText = data.walletAddress;
            document.getElementById('walletCommentText').innerText = data.comment;
            document.getElementById('transferRubText').innerText = amount.toFixed(2) + ' ₽';
            document.getElementById('transferExpiryText').innerText = new Date(data.expiresAt).toLocaleTimeString('ru-RU');
            document.getElementById('transferStatusText').innerText = 'Ожидаем перевод';
            const qrImage = document.getElementById('transferQrImg');
            qrImage.src = data.qrCodeDataUrl || '';
            qrImage.alt = data.qrCodeDataUrl ? 'QR-код оплаты через TON-кошелёк' : 'QR-код временно недоступен';
            qrImage.style.display = data.qrCodeDataUrl ? 'block' : 'none';
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

function openWalletApp(wallet='tonkeeper') {
    const link=activeDirectWalletLinks?.[wallet] || activeDirectWalletLinks?.tonkeeper || activeDirectPaymentUri;
    if(!link)return;
    if(tg?.openLink && /^https:\/\//i.test(link)) {
        tg.openLink(link);
        return;
    }
    window.location.assign(link);
}

function copyWalletPaymentLink() {
    const value=activeDirectWalletLinks?.tonkeeper || activeDirectPaymentUri || '';
    if(!value)return;
    if(navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(()=>alert('Ссылка на оплату скопирована')).catch(()=>alert(value));
    else alert(value);
}

function closeTransferModal() {
    if(directPaymentPoll) clearInterval(directPaymentPoll);
    activeDirectWalletLinks=null;
    activeDirectPaymentUri=null;
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
      if(currentRole==='owner'){loadOwnerStats();loadOwnerSellers();loadKeyHistory();loadOwnerWithdrawals();}
      if(['owner','admin','support'].includes(currentRole))loadPromoCodes();
      if(['owner','support'].includes(currentRole)) { loadModeration(); loadManageProducts(); }
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
  const names={cryptobot:'CryptoBot',owner_transfer:'Перевод на карту владельцу',direct_transfer:'TON / USDT',telegram_stars:'Telegram Stars',sbp:'СБП (RollyPay)',crypto:'Криптовалюта (RollyPay)'};
  const ready=Object.keys(names).filter(k=>status[k]);
  Object.keys(names).forEach(k=>{
   const el=document.getElementById('method-'+k);if(!el)return;
   el.classList.toggle('unavailable',!status[k]);el.title=status[k]?'Доступно':'Не настроено на сервере';
  });
  if(!status[selectedPaymentMethod]&&ready.length){selectedPaymentMethod=ready[0];const el=document.getElementById('method-'+selectedPaymentMethod);document.querySelectorAll('.pay-method-item').forEach(x=>x.classList.remove('selected'));el?.classList.add('selected');document.getElementById('directAssetWrap').classList.toggle('hidden',selectedPaymentMethod!=='direct_transfer');}
  if(box){
  if(ready.length){
   const missing=Object.entries(status.missing||{}).filter(([k,v])=>v?.length).map(([k,v])=>names[k]+': '+v.join(', '));
   const warnings=Object.entries(status.webhookWarnings||{}).filter(([,v])=>v?.length).map(([k,v])=>v.join(', '));
   box.textContent='Доступны: '+ready.map(k=>names[k]).join(', ')+(missing.length?' · Не настроены: '+missing.join('; '):'')+(warnings.length?' · Примечание: '+warnings.join('; '):'');
  }else{
   const missing=Object.entries(status.missing||{}).map(([k,v])=>names[k]+': '+(v?.length?v.join(', '):'готово')).join('; ');
   box.textContent='Пополнение пока не настроено. Не хватает: '+missing;
  }
 }
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
  const render=(arr,kind)=>arr.map(x=>{const details=kind==='sale'&&x.buyer_details&&Object.keys(x.buyer_details).length?Object.entries(x.buyer_details).map(([k,v])=>k+': '+v).join(' · '):'';return '<div class="data-row"><div><b>'+escapeHtml(x.title||('Перевод #'+x.id))+'</b><small>'+escapeHtml(x.status)+' · '+new Date(x.created_at).toLocaleString('ru-RU')+(details?' · '+escapeHtml(details):'')+'</small></div><strong>'+rub(x.amount)+'</strong>'+(kind==='purchase'&&x.status!=='refunded'&&['owner','support'].includes(currentRole)?'<button onclick="refundOrder('+x.id+')">Возврат</button>':'')+'</div>';}).join('');
  box.innerHTML='<h4>Покупки</h4>'+(d.purchases.length?d.purchases.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.title)+'</b><small>'+escapeHtml(x.store_name||'Магазин')+' · '+escapeHtml(x.status)+' · '+new Date(x.created_at).toLocaleString('ru-RU')+'</small></div><strong>'+rub(x.amount)+'</strong>'+(kindRefundAllowed()&&x.status!=='refunded'?'<button onclick="refundOrder('+x.id+')">Возврат</button>':'')+'</div>').join(''):'<p>Покупок пока нет</p>')+'<h4>Продажи</h4>'+(d.sales.length?render(d.sales,'sale'):'<p>Продаж пока нет</p>')+'<h4>Переводы</h4>'+(d.transfers.length?d.transfers.map(x=>'<div class="data-row"><div><b>'+(x.direction==='sent'?'Отправлено':'Получено')+'</b><small>'+escapeHtml(x.status)+' · '+new Date(x.created_at).toLocaleString('ru-RU')+'</small></div><strong>'+rub(x.amount)+'</strong></div>').join(''):'<p>Переводов пока нет</p>');
 }catch(e){box.textContent=e.message;}
}
function kindRefundAllowed(){return ['owner','support'].includes(currentRole);}
async function refundOrder(id){
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
   '<h4>Покупки</h4>'+(d.purchases.length?d.purchases.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.title)+'</b><small>'+escapeHtml(x.store_name||'Магазин')+' · Заказ #'+x.id+' · '+escapeHtml(x.status)+'</small></div><strong>'+rub(x.amount)+'</strong>'+(x.status!=='refunded'?'<button onclick="refundOrder('+x.id+')">Возврат</button>':'')+'</div>').join(''):'<p>Покупок нет</p>')+
   '<h4>Продажи</h4>'+(d.sales.length?d.sales.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.title)+'</b><small>'+escapeHtml(x.buyer_name||'Покупатель')+' · Заказ #'+x.id+' · '+escapeHtml(x.status)+'</small></div><strong>'+rub(x.amount)+'</strong></div>').join(''):'<p>Продаж нет</p>')+
   '<h4>Переводы средств</h4>'+(d.transfers.length?d.transfers.map(x=>'<div class="data-row"><div><b>'+(String(x.sender_id)===id?'Отправлено пользователю':'Получено от пользователя')+'</b><small>'+escapeHtml(x.status)+' · Telegram ID: '+escapeHtml(String(x.sender_id)===id?(x.recipient_id||'ожидает получателя'):x.sender_id)+'</small></div><strong>'+rub(x.amount)+'</strong></div>').join(''):'<p>Переводов нет</p>');
 }catch(e){box.textContent=e.message;}
}
async function unbanSupportUser(){
 const target_id=document.getElementById('banTargetId').value.trim()||document.getElementById('supportLookupId').value.trim();
 if(!/^\d{1,20}$/.test(target_id)){alert('Введите Telegram ID.');return;}
 try{const r=await jsonPost('/api/admin/action',{action:'unban',target_id}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');alert('Блокировка снята.');}catch(e){alert(e.message);}
}
async function requestBan(){
 const telegram_id=document.getElementById('banTargetId').value.trim(),reason=document.getElementById('banReason').value.trim(),raw=document.getElementById('banDuration').value;
 const duration_hours=raw===''?null:Number(raw),out=document.getElementById('ban-request-result');
 try{const r=await jsonPost('/api/support/ban-request',{telegram_id,reason,duration_hours}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');out.textContent='Запрос отправлен владельцу. Ожидайте решения.';}catch(e){out.textContent=e.message;}
}
async function loadSellerProducts(){
 const box=document.getElementById('seller-products-list');if(!box)return;
 try{
  const r=await apiFetch('/api/products/manage'),rows=await r.json();if(!r.ok)throw new Error(rows.error||'Ошибка');
  box.innerHTML=rows.length?rows.map(p=>'<div class="data-row"><div><b>'+escapeHtml(p.title)+'</b><small>'+rub(p.price)+' · '+escapeHtml(p.status)+'</small></div>'+(p.status!=='deleted'?'<button class="danger-button" onclick="deleteOwnProduct('+p.id+')">Удалить</button>':'')+'</div>').join(''):'<p>Вы ещё не выставили товары.</p>';
 }catch(e){box.textContent=e.message;}
}
async function deleteOwnProduct(id){
 if(!confirm('Удалить этот товар из каталога?'))return;
 try{const r=await jsonPost('/api/products/'+id+'/delete',{}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');loadSellerProducts();loadProducts();alert('Товар удалён.');}catch(e){alert(e.message);}
}
async function loadManageProducts(){
 const box=document.getElementById('manage-products-list');if(!box)return;
 try{
  const r=await apiFetch('/api/products/manage'),rows=await r.json();if(!r.ok)throw new Error(rows.error||'Ошибка');
  box.innerHTML=rows.length?rows.map(p=>'<div class="data-row"><div><b>'+escapeHtml(p.title)+'</b><small>#'+p.id+' · '+escapeHtml(p.seller_name)+' · '+rub(p.price)+' · '+escapeHtml(p.status)+'</small></div><div class="action-row">'+(p.status==='deleted'?'Удалён':currentRole==='owner'?'<button class="danger-button" onclick="deleteManagedProduct('+p.id+')">Удалить</button>':p.status==='active'?'<button class="danger-button" onclick="requestProductDeletion('+p.id+')">Запросить удаление</button>':'Недоступен')+'</div></div>').join(''):'<p>Товары не найдены.</p>';
 }catch(e){box.textContent=e.message;}
}
async function deleteManagedProduct(id){
 if(!confirm('Владелец: удалить этот товар из каталога?'))return;
 try{const r=await jsonPost('/api/products/'+id+'/delete',{}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');loadManageProducts();loadProducts();alert('Товар удалён.');}catch(e){alert(e.message);}
}
async function requestProductDeletion(id){
 const reason=prompt('Укажите причину, по которой нужно удалить товар:');
 if(reason===null)return;
 if(reason.trim().length<5){alert('Причина должна содержать не менее 5 символов.');return;}
 try{const r=await jsonPost('/api/products/delete-request',{product_id:id,reason:reason.trim()}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');loadManageProducts();loadModeration();loadProducts();alert(d.message||'Товар заморожен, запрос отправлен владельцу.');}catch(e){alert(e.message);}
}
async function loadModeration(){
 const box=document.getElementById('moderation-list');if(!box)return;
 try{
  const r=await apiFetch('/api/moderation/pending'),rows=await r.json();if(!r.ok)throw new Error(rows.error||'Ошибка');
  box.innerHTML=rows.length?rows.map(m=>{
   const label=m.kind==='product_delete'?'Запрос удаления товара':m.kind==='product'?'Публикация товара':'Блокировка пользователя';
   const waiting=(m.kind==='ban'||m.kind==='product_delete')&&currentRole!=='owner';
   const subject=m.product_title?escapeHtml(m.product_title):'Telegram ID '+escapeHtml(m.target_user_id||'');
   return `<div class="data-row"><div><b>Заявка #${m.id} · ${label}</b><small>${subject} · ${escapeHtml(m.reason||'')}${m.kind==='ban'?' · Срок: '+(m.duration_hours?m.duration_hours+' ч.':'навсегда'):''}</small></div><div class="action-row">${waiting?'Ожидает решения владельца':`<button onclick="decideModeration(${m.id}, 'approve')">Одобрить</button><button class="danger-button" onclick="decideModeration(${m.id}, 'reject')">Отклонить</button>`}</div></div>`;
  }).join(''):'<p>Ожидающих заявок нет.</p>';
 }catch(e){box.textContent=e.message;}
}
async function decideModeration(request_id,decision){
 if(!confirm(decision==='approve'?'Одобрить заявку?':'Отклонить заявку?'))return;
 try{const r=await jsonPost('/api/moderation/decision',{request_id,decision}),d=await r.json();if(!r.ok)throw new Error(d.error||'Ошибка');loadModeration();loadProducts();loadManageProducts();}catch(e){alert(e.message);}
}
function loadHistory(){const box=document.getElementById('history-list');apiFetch('/api/history').then(r=>r.json()).then(rows=>{box.innerHTML=Array.isArray(rows)&&rows.length?rows.map(x=>`<div class="data-row"><div><b>${escapeHtml(x.description)}</b><small>${new Date(x.created_at).toLocaleString('ru-RU')}</small></div><strong>${Number(x.amount)>0?'+':''}${rub(x.amount)}</strong></div>`).join(''):'<div class="no-products">Операций пока нет</div>';}).catch(()=>box.textContent='Не удалось загрузить историю.');}

async function buyProduct(productId) {
    const product=allProducts.find(p=>Number(p.id)===Number(productId));
    if(!product){alert('Товар не найден. Обновите каталог.');return;}
    const type=product.product_type||'standard';let quantity=1,details={};
    if(type==='telegram_premium'){
      const raw=prompt('На сколько месяцев оформить Telegram Premium? От 1 до 12.','3');
      if(raw===null)return;quantity=Number(raw);if(!Number.isInteger(quantity)||quantity<1||quantity>12){alert('Срок должен быть от 1 до 12 месяцев.');return;}
      const recipient=prompt('Укажите Telegram username получателя Premium:');if(recipient===null)return;details.recipient_username=recipient.trim();
    }else if(type==='telegram_stars'){
      const raw=prompt('Сколько Telegram Stars нужно купить? Введите от 50 до 1 000.','50');
      if(raw===null)return;quantity=Number(raw);if(!Number.isInteger(quantity)||quantity<50||quantity>1000){alert('Можно купить от 50 до 1 000 звёзд.');return;}
      const recipient=prompt('Укажите Telegram username аккаунта, куда прислать звёзды:');if(recipient===null)return;details.recipient_username=recipient.trim();
    }else if(type==='robux'){
      const raw=prompt('Сколько Robux хотите купить? От 10 до 100 000.','100');
      if(raw===null)return;quantity=Number(raw);if(!Number.isInteger(quantity)||quantity<10||quantity>100000){alert('Можно купить от 10 до 100 000 Robux.');return;}
      const roblox=prompt('Введите username своего аккаунта Roblox:');if(roblox===null)return;details.roblox_username=roblox.trim();
      const telegram=prompt('Введите свой Telegram username (например, @username):');if(telegram===null)return;details.telegram_username=telegram.trim();
    }else if(type==='roblox_account'){
      const telegram=prompt('Введите свой Telegram username для связи с продавцом:');if(telegram===null)return;details.telegram_username=telegram.trim();
    }else if(type==='channel_customization'){
      const owner=prompt('Укажите Telegram username владельца канала:');if(owner===null)return;details.owner_username=owner.trim();
      const link=prompt('Вставьте ссылку на Telegram-канал (https://t.me/...):');if(link===null)return;details.channel_url=link.trim();
    }else if(type==='subscription'||type==='loyalty_points'){
      const account=prompt(type==='subscription'?'Укажите аккаунт или данные для оформления подписки:':'Укажите номер телефона или номер карты лояльности:');if(account===null)return;details.account=account.trim();
    }
    const total=Math.round(Number(product.price)*quantity*100)/100;
    const label=type==='robux'?quantity+' Robux × '+Number(product.price).toFixed(2)+' ₽ = ':type==='telegram_stars'?quantity+' ⭐ × '+Number(product.price).toFixed(2)+' ₽ = ':type==='telegram_premium'?quantity+' мес. Premium × '+Number(product.price).toFixed(2)+' ₽ = ':'';
    const promoCode=(prompt('Промокод на скидку (оставьте поле пустым, если его нет):','')||'').trim().toUpperCase();
    if(!confirm('Подтвердить покупку «'+product.title+'»?\\n'+label+total.toFixed(2)+' ₽'+(promoCode?'\\nПромокод: '+promoCode:'')))return;
    try{
      const res=await apiFetch('/api/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({product_id:productId,quantity,details,promo_code:promoCode})});
      const data=await res.json();if(!res.ok||data.error)throw new Error(data.error||'Не удалось оформить заказ.');
      if(type==='digital_key'){
        const dr=await apiFetch('/api/orders/'+data.order_id+'/delivery'),delivery=await dr.json();
        if(!dr.ok||!delivery.success||!delivery.delivery)throw new Error(delivery.error||'Данные выдачи пока недоступны. Обратитесь в поддержку.');
        const d=delivery.delivery;
        if(d.type==='code'){alert('Ваш цифровой ключ / код:\n\n'+d.code);try{await navigator.clipboard.writeText(d.code)}catch{}}
        else if(d.type==='file'){const bytes=Uint8Array.from(atob(d.file_data),c=>c.charCodeAt(0));const blob=new Blob([bytes],{type:d.mime||'application/octet-stream'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=d.file_name||'digital-delivery.bin';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);alert('Файл заказа #'+data.order_id+' загружен.');}
      }else if(type==='telegram_account'){
        const dr=await apiFetch('/api/orders/'+data.order_id+'/delivery'),delivery=await dr.json();
        if(!dr.ok||!delivery.success)throw new Error(delivery.error||'Покупка прошла, но выдача пока недоступна. Заказ #'+data.order_id);
        const d=delivery.delivery||{};
        if(d.type==='file'){
          const bytes=Uint8Array.from(atob(d.file_data),c=>c.charCodeAt(0));
          const blob=new Blob([bytes],{type:d.mime||'application/octet-stream'});
          const url=URL.createObjectURL(blob),link=document.createElement('a');
          link.href=url;link.download=d.file_name||'telegram-account-file';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
          alert('Покупка успешна! Файл аккаунта загружен. Заказ #'+data.order_id+'.');
        }else{
          alert('Покупка успешна! Номер телефона: '+d.phone+'\\nPremium: '+(d.premium==='yes'?'есть':'нет')+'\\n\\n'+d.notice+'\\nЗаказ #'+data.order_id);
        }
      }else if(type==='roblox_account'){
        const dr=await apiFetch('/api/orders/'+data.order_id+'/delivery'),delivery=await dr.json();
        if(!dr.ok||!delivery.success)throw new Error(delivery.error||'Покупка прошла, но данные аккаунта пока не удалось загрузить. Заказ #'+data.order_id);
        const d=delivery.delivery||{};
        alert('Покупка прошла успешно! Данные аккаунта Roblox\\n\\nUsername: '+d.roblox_username+'\\nПочта: '+d.account_email+'\\nПароль аккаунта: '+d.account_password+'\\nПароль от почты: '+d.email_password+'\\n\\nСохраните данные. Заказ #'+data.order_id);
      }else alert('Оплата прошла успешно! Номер заказа #'+data.order_id+'.'+(data.discount>0?' Скидка: '+rub(data.discount)+'.':'')+' Данные для выполнения заказа отправлены продавцу.');
      location.reload();
    }catch(e){alert(e.message||'Ошибка соединения с сервером.');}
}