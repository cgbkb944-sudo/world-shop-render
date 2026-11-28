(function(){
 const tabs=[...document.querySelectorAll('.wts-tab')];
 const setPage=page=>{
  document.body.dataset.page=page;
  tabs.forEach(t=>t.classList.toggle('is-active',t.dataset.page===page));
  if(page==='profile'||page==='orders'){
   document.querySelector('#account')?.scrollIntoView({behavior:'smooth',block:'start'});
   if(page==='orders'){
    document.querySelector('#profileActions')?.classList.remove('hidden');
    document.querySelectorAll('.profile-subpanel').forEach(p=>p.classList.add('hidden'));
    document.querySelector('#ordersPanel')?.classList.remove('hidden');
   }
  }else window.scrollTo({top:0,behavior:'smooth'});
 };
 tabs.forEach(t=>t.addEventListener('click',()=>setPage(t.dataset.page)));
 document.querySelector('#loginTop')?.addEventListener('click',()=>setPage('profile'));
 document.querySelector('#profileShortcut')?.addEventListener('click',()=>setPage('profile'));
 document.querySelectorAll('a[href="#catalog"]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();setPage('catalog')}));
 document.body.dataset.page='home';
})();