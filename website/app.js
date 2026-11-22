const $=s=>document.querySelector(s);let currentFilter='all',products=[];let currentUser=null;
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),3000)}
async function api(path,options={}){const res=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let data={};try{data=await res.json()}catch{}if(!res.ok)throw new Error(data.error||'Не удалось выполнить запрос');return data}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function renderProducts(){const q=($('#searchProducts').value||'').toLowerCase();const filtered=products.filter(p=>{const text=[p.title,p.description,p.category,p.subcategory].join(' ').toLowerCase();const type=p.product_type||'standard';const cat=currentFilter==='all'||(currentFilter==='digital'?['telegram_stars','subscription','robux','roblox_account','telegram_account'].includes(type):['channel_customization','standard'].includes(type));return cat&&text.includes(q)});const grid=$('#productGrid');if(!filtered.length){grid.innerHTML='<div class="empty-card">Пока нет товаров по этому запросу.<br>Попробуй изменить поиск или загляни позже.</div>';return}grid.innerHTML=filtered.map(p=>'<article class="product-card">'+(p.has_image?'<img class="product-art product-photo" src="/api/products/'+encodeURIComponent(p.id)+'/image" alt="Фото товара" loading="lazy">':'<div class="product-art">✦</div>')+'<div class="product-category">'+escapeHtml(p.category||'WORLD TG SHOP')+'</div><h3>'+escapeHtml(p.title)+'</h3><p>'+escapeHtml((p.description||'').slice(0,100))+'</p><div class="product-foot"><span class="product-price">'+Number(p.price).toLocaleString('ru-RU')+' ₽</span><span class="product-seller">'+escapeHtml(p.seller_name||'Продавец')+'</span></div><button class="btn btn-primary" type="button" data-buy-id="'+Number(p.id)+'" style="width:100%;margin-top:14px">Купить</button></article>').join('')}
async function loadProducts(){const grid=$('#productGrid');grid.innerHTML='<div class="loading-card">Загружаем каталог<span class="loader"></span></div>';try{products=await api('/api/products');renderProducts()}catch(e){grid.innerHTML='<div class="empty-card">Не удалось загрузить каталог. Попробуй обновить страницу.</div>';$('#catalogNote').textContent=e.message}}
function showUser(user){currentUser=user;$('#loginPanel').classList.add('hidden');$('#profilePanel').classList.remove('hidden');$('#profileName').textContent=user.display_name||user.first_name||user.username||'Пользователь';$('#profileHandle').textContent=user.username?'@'+user.username:'Аккаунт Telegram';$('#profileBalance').textContent=Number(user.balance||0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽';$('#profileSellerBalance').textContent=Number(user.seller_balance||0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽';$('#profileRole').textContent=({owner:'Владелец',admin:'Администратор',support:'Поддержка',seller:'Продавец',user:'Пользователь'})[user.role]||user.role;$('#profileId').textContent=user.telegram_id;$('#avatar').textContent=(user.first_name||user.username||'W').slice(0,1).toUpperCase();if(user.photo_url)$('#avatar').style.backgroundImage='url('+JSON.stringify(user.photo_url)+')';if(user.role==='owner')$('#ownerTools').classList.remove('hidden');else $('#ownerTools').classList.add('hidden');$('#sellerProductTools').classList.toggle('hidden',!['seller','admin','owner'].includes(user.role))}
async function loadMe(){try{const user=await api('/api/me');if(user&&user.telegram_id)showUser(user)}catch{}}
window.onTelegramAuth=async function(user){try{const result=await api('/api/auth/telegram',{method:'POST',body:JSON.stringify(user)});showUser(result.user);toast('Вы вошли в WORLD TG SHOP')}catch(e){toast(e.message)}};
$('#loginTop').addEventListener('click',()=>$('#account').scrollIntoView({behavior:'smooth'}));
$('#searchProducts').addEventListener('input',renderProducts);
document.querySelectorAll('.filter').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');currentFilter=b.dataset.filter;renderProducts()}));
$('#refreshCatalog').addEventListener('click',loadProducts);
document.querySelector('#productGrid').addEventListener('click',async e=>{
 const button=e.target.closest('[data-buy-id]');if(!button)return;
 if(!currentUser){toast('Сначала войдите через Telegram');$('#account').scrollIntoView({behavior:'smooth'});return;}
 const id=Number(button.dataset.buyId);if(!Number.isSafeInteger(id)||id<1)return;
 const product=products.find(x=>Number(x.id)===id);if(!product)return toast('Товар не найден. Обновите каталог.');
 const type=product.product_type||'standard',details={};let quantity=1;
 const ask=(label)=>{const v=window.prompt(label);return v===null?null:v.trim()};
 if(type==='telegram_stars'){const q=ask('Сколько Telegram Stars купить? (50–1000)');if(q===null)return;quantity=Number(q);const recipient=ask('Telegram username получателя (например, @username)');if(recipient===null)return;details.recipient_username=recipient;}
 else if(type==='robux'){const q=ask('Сколько Robux купить? (10–100000)');if(q===null)return;quantity=Number(q);const roblox=ask('Username аккаунта Roblox');if(roblox===null)return;const telegram=ask('Твой Telegram username для связи');if(telegram===null)return;details.roblox_username=roblox;details.telegram_username=telegram;}
 else if(type==='roblox_account'){const telegram=ask('Твой Telegram username для связи');if(telegram===null)return;details.telegram_username=telegram;}
 else if(type==='channel_customization'){const owner=ask('Telegram username владельца канала');if(owner===null)return;const url=ask('Ссылка на канал (https://t.me/...)');if(url===null)return;details.owner_username=owner;details.channel_url=url;}
 else if(type==='subscription'||type==='loyalty_points'){const account=ask('Аккаунт, номер телефона или идентификатор для зачисления');if(account===null)return;details.account=account;}
 if(type==='telegram_stars'&&(!Number.isInteger(quantity)||quantity<50||quantity>1000))return toast('Количество Stars должно быть от 50 до 1000.');
 if(type==='robux'&&(!Number.isInteger(quantity)||quantity<10||quantity>100000))return toast('Количество Robux должно быть от 10 до 100000.');
 const total=Number(product.price)*quantity;if(!Number.isFinite(total)||total<=0)return toast('У товара указана некорректная цена.');
 if(!confirm('Подтвердить покупку «'+product.title+'» на '+total.toLocaleString('ru-RU')+' ₽? Деньги будут списаны с баланса.'))return;
 button.disabled=true;button.textContent='Оформляем…';
 try{const result=await api('/api/buy',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({product_id:id,quantity,details})});toast('Покупка оформлена. Заказ №'+result.order_id);await loadMe();if(location.pathname==='/profile')await loadAccountData();await loadProducts();}
 catch(err){toast(err.message)}
 finally{button.disabled=false;button.textContent='Купить'}
});
$('#logoutBtn').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:'{}'})}catch{}$('#profilePanel').classList.add('hidden');$('#loginPanel').classList.remove('hidden');currentUser=null;toast('Вы вышли из аккаунта')});
$('#activateKey').addEventListener('click',async()=>{const key=$('#activationKey').value.trim();if(!key)return toast('Введи ключ');const status=$('#keyStatus');status.textContent='Проверяем ключ…';try{const result=await api('/api/key/activate',{method:'POST',body:JSON.stringify({key})});status.textContent=result.type==='topup'?'Баланс пополнен на '+result.amount+' ₽':'Роль аккаунта обновлена: '+result.role;$('#activationKey').value='';await loadMe()}catch(e){status.textContent=e.message}});
$('#generateKey').addEventListener('click',async()=>{const role=$('#newKeyRole').value;try{const r=await api('/api/key/generate',{method:'POST',body:JSON.stringify({role})});$('#generatedKey').textContent=r.key;$('#generatedKey').classList.remove('hidden');await navigator.clipboard?.writeText(r.key);toast('Ключ создан'+(navigator.clipboard?' и скопирован':''))}catch(e){toast(e.message)}});

const productImageInput=$('#webProductImage');
productImageInput?.addEventListener('change',()=>{
  const file=productImageInput.files?.[0],preview=$('#webProductPreview');
  if(!file){preview.classList.add('hidden');preview.removeAttribute('src');return;}
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2*1024*1024){
    toast('Выберите JPG, PNG или WebP размером до 2 МБ.');productImageInput.value='';preview.classList.add('hidden');preview.removeAttribute('src');return;
  }
  preview.src=URL.createObjectURL(file);preview.classList.remove('hidden');
});
$('#websiteProductForm')?.addEventListener('submit',async event=>{
  event.preventDefault();
  const status=$('#webProductStatus'),submit=$('#webProductSubmit'),file=productImageInput?.files?.[0];
  status.textContent='Отправляем товар…';submit.disabled=true;
  try{
    let image_data=null,image_mime=null;
    if(file){
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2*1024*1024)throw new Error('Фото должно быть JPG, PNG или WebP размером до 2 МБ.');
      image_mime=file.type;
      image_data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error('Не удалось прочитать изображение.'));reader.readAsDataURL(file)});
    }
    const payload={title:$('#webProductTitle').value.trim(),category:$('#webProductCategory').value.trim(),price:$('#webProductPrice').value,description:$('#webProductDescription').value.trim(),image_data,image_mime};
    const result=await api('/api/products/add',{method:'POST',body:JSON.stringify(payload)});
    status.textContent='Заявка отправлена на модерацию. Товар появится в каталоге после одобрения.';
    $('#websiteProductForm').reset();$('#webProductPreview').classList.add('hidden');$('#webProductPreview').removeAttribute('src');
    toast('Товар отправлен на проверку');
  }catch(e){status.textContent=e.message||'Не удалось отправить товар.'}
  finally{submit.disabled=false}
});

function setupTelegramWidget(){const mount=$('#telegramLogin');const script=document.createElement('script');script.async=true;script.src='https://telegram.org/js/telegram-widget.js?22';script.setAttribute('data-telegram-login','World_tg_shop_bot');script.setAttribute('data-size','large');script.setAttribute('data-radius','10');script.setAttribute('data-onauth','onTelegramAuth(user)');script.setAttribute('data-request-access','write');mount.innerHTML='';mount.appendChild(script)}
loadProducts();loadMe();setupTelegramWidget();

function setAvatar(el,url,fallback){if(!el)return;if(url){el.innerHTML='<img src="'+escapeHtml(url)+'" alt="Аватар Telegram">';}else{el.textContent=(fallback||'W').slice(0,1).toUpperCase();}}
function showUser(user){
 currentUser=user;
 if(location.pathname==='/login')history.replaceState({},'','/profile');
 const isProfileRoute=location.pathname==='/profile';
 $('#profileShortcut').classList.remove('hidden');$('#loginTop').classList.add('hidden');
 $('#account').classList.toggle('hidden',!isProfileRoute);
 if(!isProfileRoute)return;
 $('#loginPanel').classList.add('hidden');$('#profilePanel').classList.remove('hidden');$('#profileActions').classList.remove('hidden');
 $('#profileName').textContent=user.display_name||user.first_name||user.username||'Пользователь';
 $('#profileHandle').textContent=user.username?'@'+user.username:'Аккаунт Telegram';
 $('#profileBalance').textContent=Number(user.balance||0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽';
 $('#profileRole').textContent=({owner:'Владелец',admin:'Администратор',support:'Поддержка',seller:'Продавец',user:'Пользователь'})[user.role]||user.role;
 $('#profileId').textContent=user.telegram_id;setAvatar($('#avatar'),user.photo_url||user.avatar_url,user.first_name||user.username);
 const head=$('#headerAvatar');if(user.photo_url||user.avatar_url){head.src=user.photo_url||user.avatar_url;head.style.display='block'}else head.style.display='none';
 $('#headerName').textContent=user.display_name||user.first_name||user.username||'Профиль';
 $('#ownerTools').classList.toggle('hidden',user.role!=='owner');
 $('#sellerProductTools').classList.toggle('hidden',!['seller','admin','owner'].includes(user.role));
 if(location.pathname==='/login')history.replaceState({},'','/profile');
 if(location.pathname==='/profile')loadAccountData();
}
async function loadAccountData(){loadHistoryAndOrders();loadPaymentMethods()}
async function loadHistoryAndOrders(){
 try{
  const pair=await Promise.all([api('/api/history'),api('/api/my/activity')]),h=pair[0],a=pair[1];
  $('#accountHistory').innerHTML=h.length?h.map(x=>'<div class="data-row"><div><b>'+escapeHtml(x.description||x.type)+'</b><small>'+new Date(x.created_at).toLocaleString('ru-RU')+'</small></div><strong>'+(Number(x.amount)>0?'+':'')+Number(x.amount).toLocaleString('ru-RU')+' ₽</strong></div>').join(''):'<p>Операций пока нет.</p>';
  const rows=[...(a.purchases||[]),...(a.sales||[])].sort((x,y)=>new Date(y.created_at)-new Date(x.created_at));
  $('#accountOrders').innerHTML=rows.length?rows.map(x=>'<div class="data-row"><div><b>#'+x.id+' · '+escapeHtml(x.title)+'</b><small>'+escapeHtml(x.status)+' · '+new Date(x.created_at).toLocaleString('ru-RU')+'</small></div><strong>'+Number(x.amount).toLocaleString('ru-RU')+' ₽</strong></div>').join(''):'<p>Заказов пока нет.</p>';
 }catch(e){$('#accountHistory').textContent=e.message;$('#accountOrders').textContent=e.message}
}
async function loadPaymentMethods(){try{const m=await api('/api/payment/methods');for(const opt of $('#topupMethod').options){if(opt.dataset.comingSoon==='true')continue;opt.disabled=!m[opt.value];if(!m[opt.value]&&!opt.textContent.includes('недоступно'))opt.textContent+=' (недоступно)'}const f=[...$('#topupMethod').options].find(x=>!x.disabled);if(f)$('#topupMethod').value=f.value}catch{}}
document.querySelectorAll('[data-panel]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.profile-subpanel').forEach(x=>x.classList.add('hidden'));$('#'+b.dataset.panel).classList.remove('hidden');if(['historyPanel','ordersPanel'].includes(b.dataset.panel))loadHistoryAndOrders()}));
$('#topupMethod').addEventListener('change',()=>$('#topupAssetWrap').classList.toggle('hidden',$('#topupMethod').value!=='direct_transfer'));
$('#topupCreate').addEventListener('click',async()=>{const s=$('#topupStatus');s.textContent='Создаём платёж…';s.querySelectorAll('button,img,a').forEach(x=>x.remove());try{const method=$('#topupMethod').value,payload={amount:$('#topupAmount').value,method};if(method==='direct_transfer')payload.asset=$('#topupAsset').value;const r=await api('/api/payment/create',{method:'POST',body:JSON.stringify(payload)});if(r.directTransfer){s.textContent='Переведите ровно '+r.cryptoAmount+' '+r.asset+' на указанный адрес. Обязательно укажите комментарий.';const img=document.createElement('img');img.src=r.qrCodeDataUrl;img.alt='QR-код оплаты';img.style.cssText='display:block;width:220px;max-width:100%;margin:12px auto';s.appendChild(img);const address=document.createElement('p');address.textContent='Кошелёк: '+r.walletAddress;s.appendChild(address);const comment=document.createElement('p');comment.textContent='Комментарий: '+r.comment;s.appendChild(comment);const link=document.createElement('a');link.href=r.walletLinks.tonkeeper;link.target='_blank';link.rel='noopener';link.textContent='Открыть TON Keeper';s.appendChild(link)}else if(r.paymentUrl){window.open(r.paymentUrl,'_blank','noopener');s.textContent='Счёт создан. После оплаты нажмите «Проверить оплату».'}const b=document.createElement('button');b.className='text-button';b.textContent='Проверить оплату';let checking=false;const check=async()=>{if(checking)return;checking=true;try{const p=await api('/api/payment/status/'+r.paymentId);if(p.status==='paid'){s.textContent='Оплата подтверждена, баланс пополнен.';loadMe()}else if(['failed','expired','cancelled'].includes(p.status)){s.appendChild(document.createTextNode(' Статус платежа: '+p.status))}else{if(!s.querySelector('[data-pay-wait]')){const wait=document.createElement('p');wait.dataset.payWait='1';wait.textContent='Ожидаем подтверждения оплаты…';s.appendChild(wait)}setTimeout(check,5000)}}catch(e){setTimeout(check,8000)}finally{checking=false}};b.onclick=check;s.appendChild(b);setTimeout(check,5000)}catch(e){s.textContent=e.message}});
$('#transferCreate').addEventListener('click',async()=>{const s=$('#transferStatus');try{const r=await api('/api/transfers/create',{method:'POST',body:JSON.stringify({amount:$('#transferAmount').value})});$('#transferCode').textContent=r.code+' · '+r.amount+' ₽ · 24 часа';$('#transferCode').classList.remove('hidden');if(navigator.clipboard?.writeText)navigator.clipboard.writeText(r.code).catch(()=>{});s.textContent='Код создан. Передайте его получателю.';loadMe()}catch(e){s.textContent=e.message}});
$('#transferRedeem').addEventListener('click',async()=>{const s=$('#transferStatus');try{const r=await api('/api/transfers/redeem',{method:'POST',body:JSON.stringify({code:$('#transferRedeemCode').value})});s.textContent='Получено '+r.amount+' ₽.';$('#transferRedeemCode').value='';loadMe()}catch(e){s.textContent=e.message}});
$('#promoRedeem').addEventListener('click',async()=>{const s=$('#promoStatus');try{const r=await api('/api/promos/redeem',{method:'POST',body:JSON.stringify({code:$('#promoCodeInput').value})});s.textContent=r.message;$('#promoCodeInput').value='';loadMe()}catch(e){s.textContent=e.message}});
$('#loginTop').addEventListener('click',()=>location.href='/login');
$('#profileShortcut').addEventListener('click',()=>location.href='/profile');
$('#logoutBtn').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:'{}'})}catch{}location.href='/'});
async function initAccountRoute(){
 const p=location.pathname;
 if(p==='/login'||p==='/profile'){
  document.querySelector('.hero')?.classList.add('hidden');document.querySelector('.stats-strip')?.classList.add('hidden');
  $('#catalog').classList.add('hidden');$('#how').classList.add('hidden');document.querySelector('.account-side')?.classList.add('hidden');
  if(p==='/login'){$('#profilePanel').classList.add('hidden');$('#profileActions').classList.add('hidden');$('#loginPanel').classList.remove('hidden')}
 }
 try{const u=await api('/api/me');if(u&&u.telegram_id){showUser(u);if(p==='/login')history.replaceState({},'','/profile')}else if(p==='/profile')location.replace('/login')}catch{if(p==='/profile')location.replace('/login')}
}
initAccountRoute();
