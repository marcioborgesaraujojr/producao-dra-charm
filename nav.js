// nav.js — coluna lateral (rail) compartilhada da suíte de Atendimento.
//
// Fechada mostra só o ícone (56px). Passando o mouse ela abre pra 236px e mostra
// o nome de cada área. As áreas que têm seções internas (Lojas, WhatsApp Oficial)
// abrem um submenu ali dentro — assim a gente para de precisar daquela segunda
// barrinha dentro de cada página.
//
// A barra é sobreposta (position: fixed), então abrir não empurra o conteúdo.
(function () {
  const ADMIN = 'marcioborgesaraujojr@gmail.com';
  const SUPA = { url: 'https://wwytzoyeibekhstinott.supabase.co', key: 'sb_publishable_uMoCEK4Ed_u8ZIfjVZ7Jrg_tdR4b9bO' };

  const items = [
    { key: 'conversas', href: '/atendimento.html', label: 'Conversas', admin: false,
      icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },

    { key: 'lojas', label: 'Lojas', admin: true,
      icon: '<path d="M3 9l1.5-5h15L21 9M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M3 9h18M9 20v-6h6v6"/>',
      sub: [
        { href: '/lojas.html#resumo', label: 'Visão geral' },
        { href: '/automacoes.html#gatilhos', label: 'Gatilhos' },
        { href: '/lojas.html#eventos', label: 'Eventos' },
        { href: '/lojas.html#webhook', label: 'Webhook' },
        { href: '/lojas.html#relatorio', label: 'Relatórios' },
        { href: '/automacoes.html#fila', label: 'Fila de envios' },
        { href: '/lojas.html#leads', label: 'Lista de leads' }
      ] },

    { key: 'chatbot', label: 'Chatbot IA', admin: true,
      icon: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4M8 2h8"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>',
      sub: [
        { href: '/chatbot.html#treinamento',   label: 'Treinamento' },
        { href: '/chatbot.html#configuracoes', label: 'Configurações' },
        { href: '/chatbot.html#atendimento',   label: 'Atendimento' },
        { href: '/chatbot.html#gatilhos',      label: 'Gatilhos' },
        { href: '/chatbot.html#metricas',      label: 'Métricas' },
        { href: '/chatbot.html#custos',        label: 'Custos' }
      ] },

    { key: 'relatorios', href: '/relatorios.html', label: 'Relatórios', admin: true,
      icon: '<path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7"/><rect x="12" y="6" width="3" height="11"/><rect x="17" y="13" width="3" height="4"/>' },

    { key: 'campanhas', href: '/campanhas.html', label: 'Campanhas', admin: true,
      icon: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>' },

    { key: 'workflows', href: '/workflows.html', label: 'Workflows', admin: true,
      icon: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 6h6a3 3 0 0 1 3 3v0M9 18h6a3 3 0 0 0 3-3v0"/>' },

    { key: 'pipelines', label: 'Pipelines', admin: true,
      icon: '<rect x="3" y="4" width="4" height="16" rx="1"/><rect x="10" y="4" width="4" height="10" rx="1"/><rect x="17" y="4" width="4" height="6" rx="1"/>',
      sub: [
        { href: '/pipelines.html#quadros',   label: 'Quadros' },
        { href: '/pipelines.html#etiquetas', label: 'Etiquetas' }
      ] },

    { key: 'whatsapp', label: 'WhatsApp Oficial', admin: true,
      icon: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/><path d="M9.2 9c.2-.5.5-.5.8-.5h.4c.2 0 .3.3.5.7l.4 1c.1.2 0 .3-.1.5l-.4.5c-.1.1-.2.3-.1.5a4 4 0 0 0 2 1.9c.2.1.4 0 .5-.1l.5-.6c.1-.2.3-.2.5-.1l1 .5c.3.2.5.3.5.5s0 .9-.4 1.3a2 2 0 0 1-1.4.6 6.5 6.5 0 0 1-5.3-4.1 2.2 2.2 0 0 1 .3-2.6z"/>',
      sub: [
        { href: '/whatsapp.html#visao', label: 'Visão geral' },
        { href: '/whatsapp.html#templates', label: 'Templates' },
        { href: '/whatsapp.html#escudo', label: 'Escudo antibanimentos' },
        { href: '/ativar-numero.html', label: 'Conexão do número' }
      ] }
  ];

  const path = location.pathname;
  const arq = (h) => String(h || '').split('#')[0];
  const naPagina = (h) => { const a = arq(h); return path === a || path.endsWith(a) || (path === '/' && a === '/atendimento.html'); };
  const itemAtual = items.find(it => it.sub ? it.sub.some(s => naPagina(s.href)) : naPagina(it.href));
  const subAtual = (it) => (it.sub || []).find(s => naPagina(s.href) && s.href.split('#')[1] === location.hash.slice(1))
                        || (it.sub || []).find(s => naPagina(s.href));

  function svg(inner, cls) {
    return '<svg class="' + (cls || 'w-5 h-5') + ' shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  function build(showAdmin) {
    if (document.getElementById('atRail')) return;

    const st = document.createElement('style');
    st.textContent = [
      '#atRail{width:56px;transition:width .18s ease}',
      '#atRail.aberto{width:236px;box-shadow:0 10px 30px rgba(15,23,42,.10)}',
      '#atRail .rotulo{opacity:0;transition:opacity .12s ease;white-space:nowrap;pointer-events:none}',
      '#atRail.aberto .rotulo{opacity:1;pointer-events:auto}',
      '#atRail .seta{opacity:0;transition:opacity .12s ease,transform .18s ease}',
      '#atRail.aberto .seta{opacity:1}',
      '#atRail .grupo[data-open="1"] .seta{transform:rotate(90deg)}',
      '#atRail .sub{display:none}',
      '#atRail.aberto .grupo[data-open="1"] + .sub{display:block}'
    ].join('');
    document.head.appendChild(st);

    const rail = document.createElement('nav');
    rail.id = 'atRail';
    rail.className = 'fixed left-0 top-0 bottom-0 bg-white dark:bg-ink-800 border-r border-slate-200 dark:border-ink-600 flex flex-col py-3 gap-0.5 z-40 overflow-x-hidden overflow-y-auto';

    const linha = 'mx-2 h-10 px-2.5 rounded-xl flex items-center gap-3 text-sm font-medium transition cursor-pointer ';
    const off = 'text-slate-400 hover:bg-slate-100 hover:text-pink-600 dark:hover:bg-ink-700';
    const on  = 'bg-pink-50 text-pink-600 dark:bg-pink-900/30 dark:text-pink-300';

    let html = '';
    items.forEach((it) => {
      if (it.admin && !showAdmin) return;
      const ativo = it === itemAtual;

      if (!it.sub) {
        html += '<a href="' + it.href + '" title="' + esc(it.label) + '" class="' + linha + (ativo ? on : off) + '">'
             + svg(it.icon) + '<span class="rotulo">' + esc(it.label) + '</span></a>';
        return;
      }

      const sa = ativo ? subAtual(it) : null;
      html += '<div class="grupo ' + linha + (ativo ? on : off) + '" data-key="' + it.key + '" data-open="' + (ativo ? '1' : '0') + '" title="' + esc(it.label) + '">'
           + svg(it.icon)
           + '<span class="rotulo flex-1">' + esc(it.label) + '</span>'
           + '<svg class="seta w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'
           + '</div>';

      html += '<div class="sub pb-1">';
      it.sub.forEach((s) => {
        const subOn = !!(sa && s.href === sa.href);
        html += '<a href="' + s.href + '" class="ml-9 mr-2 h-8 px-2.5 rounded-lg flex items-center text-[13px] transition '
             + (subOn ? 'bg-pink-50 text-pink-600 font-semibold dark:bg-pink-900/30 dark:text-pink-300'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-pink-600 dark:text-slate-400 dark:hover:bg-ink-700') + '">'
             + '<span class="rotulo">' + esc(s.label) + '</span></a>';
      });
      html += '</div>';
    });

    rail.innerHTML = html;
    document.body.appendChild(rail);

    // abre/fecha com o mouse; no toque, o primeiro clique no grupo abre a barra
    let t = null;
    const abrir = () => { clearTimeout(t); rail.classList.add('aberto'); };
    const fechar = () => { clearTimeout(t); t = setTimeout(() => rail.classList.remove('aberto'), 220); };
    rail.addEventListener('mouseenter', abrir);
    rail.addEventListener('mouseleave', fechar);

    rail.querySelectorAll('.grupo').forEach((g) => {
      g.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (!rail.classList.contains('aberto')) { abrir(); g.setAttribute('data-open', '1'); return; }
        const jaAberto = g.getAttribute('data-open') === '1';
        rail.querySelectorAll('.grupo').forEach(x => x.setAttribute('data-open', '0'));
        g.setAttribute('data-open', jaAberto ? '0' : '1');
      });
    });

    // o conteúdo continua deslocado só pelos 56px da barra fechada
    const wrap = document.getElementById('appWrap');
    if (wrap) wrap.style.paddingLeft = '3.5rem';
  }

  async function init() {
    try {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      const sb = createClient(SUPA.url, SUPA.key, { auth: { persistSession: true, autoRefreshToken: true } });
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return; // sem login: authGate cuida
      const isAdmin = (session.user.email || '').toLowerCase() === ADMIN;
      if (itemAtual && itemAtual.admin && !isAdmin) { location.href = '/atendimento.html'; return; }
      build(isAdmin);
    } catch (e) { /* silencioso */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();


/* ---- carrega o botao "Voltar a Suite" (4 quadradinhos), padrao unico da suite ---- */
(function(){ try{ if(document.querySelector("script[data-suite-back]")) return; var s=document.createElement("script"); s.src="/suite-back.js"; s.defer=true; s.setAttribute("data-suite-back","1"); (document.head||document.documentElement).appendChild(s); }catch(e){} })();
