(() => {
  if (window.__wtsSupportWidgetLoaded) return;
  window.__wtsSupportWidgetLoaded = true;
  const tg = window.Telegram?.WebApp;
  const api = async (url, options={}) => {
    const headers = { 'Content-Type':'application/json', ...(options.headers||{}) };
    if (tg?.initData) headers['X-Telegram-Init-Data'] = tg.initData;
    const r = await fetch(url, { credentials:'include', ...options, headers });
    const data = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(data.error || 'Ошибка поддержки');
    return data;
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const style = document.createElement('style');
  style.textContent = `
    #wts-support-launch{position:relative;z-index:1;display:flex;width:100%;align-items:center;justify-content:center;gap:10px;padding:11px 17px 11px 9px;margin:12px 0 0;border:1px solid rgba(125,211,252,.42);border-radius:999px;background:linear-gradient(135deg,#172b48 0%,#111827 62%,#16233c 100%);color:#f8fafc;font:650 14px/1 system-ui;letter-spacing:.1px;box-shadow:0 8px 28px rgba(2,8,23,.48),inset 0 1px 0 rgba(255,255,255,.09);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);cursor:pointer;transition:transform .18s ease,box-shadow .18s ease}
    #wts-support-launch:hover{transform:translateY(-2px);box-shadow:0 12px 34px rgba(2,8,23,.58),0 0 0 3px rgba(56,189,248,.12)}
    #wts-support-launch:active{transform:scale(.97)}
    #wts-support-launch .wts-support-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:50%;background:linear-gradient(145deg,#38bdf8,#2563eb 72%);box-shadow:0 4px 14px rgba(37,99,235,.42);font-size:19px}
    #wts-support-launch .wts-support-label{display:flex;flex-direction:column;gap:3px;text-align:left}
    #wts-support-launch .wts-support-label small{font-size:10px;font-weight:500;letter-spacing:.25px;color:#a5c9e8}
    #wts-support-panel{position:fixed;right:14px;bottom:14px;width:min(420px,calc(100vw - 28px));height:min(680px,calc(100dvh - 32px));max-height:calc(100dvh - 32px);z-index:9999;background:linear-gradient(160deg,#111c2e,#0b1220 70%);color:#f8fafc;border:1px solid rgba(125,211,252,.2);border-radius:22px;box-shadow:0 22px 70px rgba(0,0,0,.62),0 0 36px rgba(37,99,235,.12);display:none;overflow:hidden;font:14px system-ui}
    @media(max-width:480px){#wts-support-panel{right:10px;bottom:10px;width:calc(100vw - 20px);height:min(680px,calc(100dvh - 20px));max-height:calc(100dvh - 20px)}}
    #wts-support-panel.open{display:flex;flex-direction:column}
    #wts-support-head{padding:14px 16px;background:#172338;display:flex;align-items:center;justify-content:space-between;font-weight:700}
    #wts-support-close{background:transparent;color:#fff;border:0;font-size:22px}
    #wts-support-filters{padding:8px 12px;display:flex;gap:6px;overflow-x:auto;border-bottom:1px solid #334155}
    #wts-support-filters[hidden]{display:none}
    #wts-support-filters button{border:1px solid #475569;background:#1e293b;color:#e2e8f0;border-radius:10px;padding:7px 10px;white-space:nowrap}
    #wts-support-filters button.active{background:#1d4ed8;border-color:#60a5fa}
    #wts-support-list{padding:8px 12px;display:flex;gap:6px;overflow-x:auto;border-bottom:1px solid #334155}
    #wts-support-list button,#wts-support-new{border:1px solid #475569;background:#1e293b;color:#e2e8f0;border-radius:10px;padding:7px 10px;white-space:nowrap}
    #wts-support-list button.active{background:#1d4ed8;border-color:#60a5fa}
    #wts-support-messages{padding:14px;flex:1;overflow:auto;display:flex;flex-direction:column;gap:9px}
    .wts-support-msg{max-width:88%;padding:10px 12px;border-radius:13px;background:#243247;white-space:pre-wrap;overflow-wrap:anywhere;align-self:flex-start}
    .wts-support-msg.mine{background:#1d4ed8;align-self:flex-end}
    .wts-support-msg small{display:block;color:#cbd5e1;font-size:10px;margin-bottom:4px}
    #wts-support-compose{display:grid;grid-template-columns:minmax(0,1fr) 54px;align-items:end;gap:9px;padding:12px;border-top:1px solid #334155;background:#0b1220;flex-shrink:0}
    #wts-support-input{display:block;box-sizing:border-box;width:100%;min-width:0;min-height:54px;height:54px;max-height:132px;resize:none;overflow-y:auto;border:1px solid #40516b;border-radius:16px;background:#172338;color:#fff;padding:15px 14px;font:16px/1.4 system-ui;outline:none;box-shadow:inset 0 1px 2px #0005}#wts-support-input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px #2563eb2b}#wts-support-input::placeholder{color:#91a2ba}
    #wts-support-send{width:54px;height:54px;border:0;border-radius:16px;background:linear-gradient(145deg,#3478ff,#1d4ed8);color:#fff;font-size:23px;font-weight:700;display:grid;place-items:center;box-shadow:0 5px 16px #1d4ed855}#wts-support-send:disabled{opacity:.55}
    #wts-support-status{padding:4px 12px;color:#cbd5e1;font-size:11px}
    .wts-support-action{border:1px solid #d97706;background:#42200655;border-radius:12px;padding:12px;margin:8px 0}
    .wts-support-action p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;color:#e2e8f0}
    .wts-support-action small{color:#fbbf24}
    .wts-support-action-controls{display:flex;gap:8px;margin-top:10px}
    .wts-support-action-controls button,.wts-support-takeover{border:0;border-radius:9px;padding:9px 12px;background:#1d4ed8;color:#fff}
    .wts-support-action-controls button:last-child{background:#991b1b}
    .wts-support-takeover{width:100%;margin-top:10px}
  `;
  document.head.appendChild(style);
  const launch = document.createElement('button');
  launch.id='wts-support-launch'; launch.type='button'; launch.setAttribute('aria-label','Открыть чат поддержки WORLD TG SHOP'); launch.innerHTML='<span class="wts-support-icon">💬</span><span class="wts-support-label"><span>Поддержка</span><small>Мы на связи</small></span>';
  const panel = document.createElement('section');
  panel.id='wts-support-panel';
  panel.innerHTML = `<div id="wts-support-head"><span>WORLD TG SHOP · Поддержка</span><button id="wts-support-close" aria-label="Закрыть">×</button></div><div id="wts-support-filters" hidden><button data-state="all">Все</button><button data-state="ai">Ведёт поддержка</button><button data-state="human">Нужен оператор</button><button data-state="closed">Закрытые</button></div><div id="wts-support-list"></div><div id="wts-support-messages"></div><div id="wts-support-status">AI-помощник онлайн, оператор может подключиться к диалогу.</div><form id="wts-support-compose"><textarea id="wts-support-input" rows="2" placeholder="Введите сообщение…" required></textarea><button id="wts-support-send" type="submit">➤</button></form>`;
  const launchTarget=document.querySelector('#tab-profile .card')||document.querySelector('#profileActions .profile-action-grid')||document.querySelector('#profilePanel');
  if(launchTarget){
    if(launchTarget.closest('#tab-profile')){const identity=launchTarget.querySelector('p');if(identity)identity.after(launch);else launchTarget.appendChild(launch);}
    else launchTarget.appendChild(launch);
  }
  document.body.appendChild(panel);
  const list=panel.querySelector('#wts-support-list'), messages=panel.querySelector('#wts-support-messages'), form=panel.querySelector('#wts-support-compose'), input=panel.querySelector('#wts-support-input'), status=panel.querySelector('#wts-support-status');
  let tickets=[], current=null, staff=false, canApprove=false, busy=false, staffFilter='all';
  const renderMessages = async () => {
    if(!current){messages.innerHTML='<p>Опишите вопрос — мы поможем.</p>';return;}
    const data=await api('/api/support/tickets/'+current+'/messages');
    messages.innerHTML=(data.messages||[]).map(m=>{
      const mine=m.sender_role==='user' || (staff && ['owner','admin','support'].includes(m.sender_role));
      const label=m.sender_role==='assistant'?'Поддержка':(['owner','admin','support'].includes(m.sender_role)?'Оператор':'Вы');
      return `<div class="wts-support-msg ${mine?'mine':''}"><small>${esc(label)}</small>${esc(m.body)}</div>`;
    }).join('') || '<p>Начните переписку.</p>';
    if(staff){
      const actionData=await api('/api/support/tickets/'+current+'/actions');
      (actionData.actions||[]).forEach(a=>{
        const card=document.createElement('div');card.className='wts-support-action';
        const title=a.action_type==='refund'?'Возврат средств':'Изменение аккаунта / заказа';
        card.innerHTML='<b>Запрос №'+Number(a.id)+' · '+esc(title)+'</b><p>'+esc(a.details)+'</p><small>Статус: '+esc(a.status)+'</small>';
        if(canApprove&&a.status==='pending'){
          const controls=document.createElement('div');controls.className='wts-support-action-controls';
          const yes=document.createElement('button');yes.type='button';yes.textContent='Одобрить';
          const no=document.createElement('button');no.type='button';no.textContent='Отклонить';
          yes.onclick=()=>reviewAction(a.id,'approved');no.onclick=()=>reviewAction(a.id,'rejected');
          controls.append(yes,no);card.appendChild(controls);
        }
        messages.appendChild(card);
      });
      const selected=tickets.find(t=>Number(t.id)===Number(current));
      const canReply=selected&&selected.status==='human';
      input.disabled=staff&&!canReply;
      status.textContent=staff?(canReply?'Запрошено подключение оператора — можно ответить.':'Просмотр переписки. Вмешательство пока не запрошено.'):'Специалист поддержки ответит здесь.';
    }
    messages.scrollTop=messages.scrollHeight;
  };
  const renderList = () => {
    list.innerHTML='';
    const filters=panel.querySelector('#wts-support-filters');
    filters.hidden=!staff;
    if(staff){
      const visible=tickets.filter(t=>staffFilter==='all'||t.status===staffFilter);
      filters.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.state===staffFilter));
      visible.forEach(t=>{const b=document.createElement('button');b.textContent='#'+t.id+' · '+t.status+' · '+t.user_id;b.className=String(t.id)===String(current)?'active':'';b.onclick=()=>selectTicket(t.id);list.appendChild(b);});
      if(!visible.length){const empty=document.createElement('small');empty.textContent='В этой категории обращений нет.';list.appendChild(empty);}
      const fresh=document.createElement('button');fresh.id='wts-support-new';fresh.textContent='Обновить список';fresh.onclick=loadTickets;list.appendChild(fresh);
    }else{
      const active=tickets.find(t=>t.status!=='closed');
      if(active){const b=document.createElement('button');b.textContent='Обращение #'+active.id+' · '+active.status;b.className='active';list.appendChild(b);}
      const fresh=document.createElement('button');fresh.id='wts-support-new';fresh.textContent='＋ Новое обращение';fresh.onclick=newTicket;list.appendChild(fresh);
    }
  };
  panel.querySelector('#wts-support-filters').addEventListener('click',e=>{const b=e.target.closest('button[data-state]');if(!b)return;staffFilter=b.dataset.state;renderList();});
  async function reviewAction(id,decision){
    const note=decision==='rejected'?'Отклонено владельцем/администратором':'Одобрено владельцем/администратором';
    try{await api('/api/support/actions/'+id+'/review',{method:'POST',body:JSON.stringify({decision,note})});await loadTickets();status.textContent='Решение сохранено и отправлено пользователю.';}
    catch(e){status.textContent=e.message;}
  }
  async function selectTicket(id){current=Number(id);renderList();try{await renderMessages();}catch(e){status.textContent=e.message;}}
  async function loadTickets(){
    try{
      const d=await api('/api/support/tickets');tickets=d.tickets||[];staff=Boolean(d.is_staff);canApprove=Boolean(d.can_approve);
      if(!current || !tickets.some(t=>Number(t.id)===Number(current))){const active=tickets.find(t=>t.status!=='closed');current=active?Number(active.id):null;}
      renderList();await renderMessages();
      status.textContent=staff?'Режим оператора: ответы отправляются от имени поддержки.':'AI-помощник отвечает автоматически. Для оператора напишите «оператор».';
    }catch(e){status.textContent=e.message;}
  }
  async function newTicket(){
    current=null;renderList();messages.innerHTML='<p>Напишите первый вопрос, чтобы открыть обращение.</p>';input.focus();
  }
  input.addEventListener('input',()=>{input.style.height='54px';input.style.height=Math.min(input.scrollHeight,132)+'px';});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();form.requestSubmit();}});
  launch.onclick=()=>{panel.classList.toggle('open');if(panel.classList.contains('open'))loadTickets();};
  panel.querySelector('#wts-support-close').onclick=()=>panel.classList.remove('open');
  form.onsubmit=async e=>{
    e.preventDefault();const body=input.value.trim();if(!body||busy)return;
    if(staff){const t=tickets.find(x=>Number(x.id)===Number(current));if(!t||t.status!=='human'){status.textContent='Ответить можно только после запроса оператора.';return;}}
    busy=true;input.disabled=true;status.textContent='Отправляем…';
    try{
      if(!current && !staff){
        const d=await api('/api/support/tickets',{method:'POST',body:JSON.stringify({message:body})});
        current=Number(d.ticket_id);
      }else{
        await api('/api/support/tickets/'+current+'/messages',{method:'POST',body:JSON.stringify({message:body})});
      }
      input.value='';await loadTickets();
    }catch(err){status.textContent=err.message;}
    finally{busy=false;input.disabled=false;input.focus();}
  };
  loadTickets();
})();