/* ============================================================
   AVATAR + MENU DO USUÁRIO — compartilhado por TODOS os apps.
   Um só arquivo controla o "M" da barra superior: a cor vem do
   perfil (profiles.color) — a MESMA em toda a suíte. Clicar abre
   o menu com nome, email, trocar cor (vale pro suite todo),
   "Ir para a Suíte" e "Sair".

   Como usar num app:
     1) ter um elemento  <div id="userAvatar">  na barra
     2) incluir  <script src="/suite-user.js"></script>
   (não use na index.html da Suíte — lá já existe o menu completo.)
   ============================================================ */
(function(){
  "use strict";
  if (window.__dcUser) return; window.__dcUser = true;

  var SUPA_URL = 'https://wwytzoyeibekhstinott.supabase.co';
  var SUPA_KEY = 'sb_publishable_uMoCEK4Ed_u8ZIfjVZ7Jrg_tdR4b9bO';
  // Mesma paleta da Suíte (profiles.color)
  var COLORS = ['#ef4444','#f97316','#f59e0b','#16a34a','#14b8a6','#0ea5e9','#3b82f6','#6366f1','#a855f7','#ff3c6f','#84cc16','#f43f5e'];

  var sb = null, prof = null, menuEl = null;

  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function isDark(){ return document.documentElement.classList.contains('dark'); }
  function colorFor(p){
    if (p && p.color) return p.color;
    var s = (p && (p.id || p.email)) || '';
    var h = 0; for (var i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  async function client(){
    if (sb) return sb;
    var m = await import('https://esm.sh/@supabase/supabase-js@2');
    sb = m.createClient(SUPA_URL, SUPA_KEY, { auth:{ persistSession:true, autoRefreshToken:true } });
    return sb;
  }

  async function init(){
    var av = document.getElementById('userAvatar');
    if (!av) return;                              // app sem avatar: não faz nada
    var c;
    try { c = await client(); } catch(e){ return; }
    var sess;
    try { sess = (await c.auth.getSession()).data.session; } catch(e){ return; }
    if (!sess) return;                            // sem login: o próprio app trata o gate
    try {
      var r = await c.from('profiles').select('id,full_name,email,color').eq('id', sess.user.id).maybeSingle();
      prof = r.data;
    } catch(e){}
    if (!prof) prof = { id: sess.user.id, email: sess.user.email, full_name: (sess.user.email||'').split('@')[0] };
    paint(av);
    av.style.cursor = 'pointer';
    av.addEventListener('click', function(e){ e.stopPropagation(); toggle(av); });
  }

  function paint(av){
    av.textContent = (prof.full_name || prof.email || '?').charAt(0).toUpperCase();
    av.style.backgroundColor = colorFor(prof);
    av.style.color = '#fff';
    av.title = prof.full_name || prof.email || '';
  }

  function buildMenu(){
    var dark = isDark();
    var line = dark ? '#1f2937' : '#eef2f7';
    var sub  = dark ? '#94a3b8' : '#64748b';
    var extra = window.DC_USER_MENU_EXTRA_HTML || '';   // ações específicas do app (opcional)
    var el = document.createElement('div');
    el.id = 'dcUserMenu';
    el.style.cssText = 'position:fixed;z-index:9999;width:230px;border-radius:14px;overflow:hidden;'
      + 'box-shadow:0 14px 44px rgba(15,23,42,.20);border:1px solid '+(dark?'rgba(255,255,255,.08)':'rgba(226,232,240,.9)')+';'
      + 'background:'+(dark?'#111827':'#fff')+';color:'+(dark?'#e5e7eb':'#0f172a')+';font-family:inherit';
    el.innerHTML = ''
      + '<div style="padding:12px 14px;border-bottom:1px solid '+line+'">'
      +   '<div style="font-weight:600;font-size:13px">'+esc(prof.full_name||'')+'</div>'
      +   '<div style="font-size:11px;color:'+sub+';word-break:break-all">'+esc(prof.email||'')+'</div>'
      + '</div>'
      + '<div style="padding:10px 14px 8px">'
      +   '<div style="font-size:11px;color:'+sub+';margin-bottom:7px">Minha cor</div>'
      +   '<div id="dcColorRow" style="display:flex;flex-wrap:wrap;gap:6px"></div>'
      + '</div>'
      + extra
      + '<div style="border-top:1px solid '+line+';padding:6px">'
      +   '<button id="dcGoSuite" type="button" style="width:100%;text-align:left;padding:8px 10px;border-radius:9px;font-size:13px;background:none;border:none;cursor:pointer;color:inherit;display:flex;align-items:center;gap:8px">'
      +     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>Ir para a Suíte</button>'
      +   '<button id="dcLogout" type="button" style="width:100%;text-align:left;padding:8px 10px;border-radius:9px;font-size:13px;background:none;border:none;cursor:pointer;color:#e11d48;display:flex;align-items:center;gap:8px">'
      +     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Sair</button>'
      + '</div>';
    document.body.appendChild(el);

    var row = el.querySelector('#dcColorRow');
    row.innerHTML = COLORS.map(function(c){
      var on = prof.color === c;
      return '<button type="button" data-c="'+c+'" style="width:22px;height:22px;border-radius:999px;border:'+(on?'2px solid '+(dark?'#fff':'#0f172a'):'2px solid transparent')+';background:'+c+';cursor:pointer;padding:0"></button>';
    }).join('');
    row.querySelectorAll('button').forEach(function(b){ b.addEventListener('click', function(){ setColor(b.getAttribute('data-c')); }); });

    el.querySelector('#dcGoSuite').addEventListener('click', function(){ location.href = '/'; });
    el.querySelector('#dcLogout').addEventListener('click', async function(){ try { await (await client()).auth.signOut(); } catch(e){} location.href = '/'; });
    ['dcGoSuite','dcLogout'].forEach(function(id){
      var b = el.querySelector('#'+id);
      b.addEventListener('mouseenter', function(){ b.style.background = dark ? '#1f2937' : '#f1f5f9'; });
      b.addEventListener('mouseleave', function(){ b.style.background = 'none'; });
    });
    return el;
  }

  async function setColor(hex){
    prof.color = hex;
    var av = document.getElementById('userAvatar'); if (av) av.style.backgroundColor = hex;
    if (menuEl){
      menuEl.querySelectorAll('#dcColorRow button').forEach(function(b){
        var on = b.getAttribute('data-c') === hex;
        b.style.border = on ? '2px solid ' + (isDark()?'#fff':'#0f172a') : '2px solid transparent';
      });
    }
    try { await (await client()).from('profiles').update({ color: hex }).eq('id', prof.id); } catch(e){}
  }

  function positionMenu(el, av){
    var r = av.getBoundingClientRect();
    el.style.top = (r.bottom + 8) + 'px';
    el.style.right = Math.max(8, (window.innerWidth - r.right)) + 'px';
  }
  function onDoc(e){ if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
  function closeMenu(){ if (menuEl){ menuEl.remove(); menuEl = null; document.removeEventListener('click', onDoc); } }
  function toggle(av){
    if (menuEl){ closeMenu(); return; }
    menuEl = buildMenu();
    positionMenu(menuEl, av);
    setTimeout(function(){ document.addEventListener('click', onDoc); }, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
