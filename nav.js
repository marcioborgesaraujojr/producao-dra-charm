// nav.js — coluna lateral (rail) compartilhada do módulo Atendimento ao Cliente.
// Inclui: Conversas (todos), Automações / Chatbot / Relatórios (só admin).
// Some/redireciona automaticamente para não-admins. Reaproveita a sessão da suíte.
(function () {
  const ADMIN = 'marcioborgesaraujojr@gmail.com';
  const SUPA = { url: 'https://wwytzoyeibekhstinott.supabase.co', key: 'sb_publishable_uMoCEK4Ed_u8ZIfjVZ7Jrg_tdR4b9bO' };
  const items = [
    { href: '/atendimento.html', label: 'Conversas', admin: false,
      icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
    { href: '/automacoes.html', label: 'Automações', admin: true,
      icon: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>' },
    { href: '/chatbot.html', label: 'Chatbot IA', admin: true,
      icon: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4M8 2h8"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>' },
    { href: '/relatorios.html', label: 'Relatórios', admin: true,
      icon: '<path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7"/><rect x="12" y="6" width="3" height="11"/><rect x="17" y="13" width="3" height="4"/>' },
    { href: '/campanhas.html', label: 'Campanhas', admin: true,
      icon: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>' },
    { href: '/workflows.html', label: 'Workflows', admin: true,
      icon: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 6h6a3 3 0 0 1 3 3v0M9 18h6a3 3 0 0 0 3-3v0"/>' },
    { href: '/pipelines.html', label: 'Funil de Leads', admin: true,
      icon: '<rect x="3" y="4" width="4" height="16" rx="1"/><rect x="10" y="4" width="4" height="10" rx="1"/><rect x="17" y="4" width="4" height="6" rx="1"/>' },
  ];
  const path = location.pathname;
  const isActive = (href) => path === href || path.endsWith(href) || (path === '/' && href === '/atendimento.html');

  function svg(inner) {
    return '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  function build(showAdmin) {
    const rail = document.createElement('nav');
    rail.id = 'atRail';
    rail.className = 'fixed left-0 top-0 bottom-0 w-14 bg-white dark:bg-ink-800 border-r border-slate-200 dark:border-ink-600 flex flex-col items-center py-3 gap-1 z-40';
    let html = '<a href="/" title="Voltar à Suíte" class="w-10 h-10 rounded-xl bg-gradient-to-br from-pink-500 to-rose-500 text-white font-bold flex items-center justify-center shadow mb-2 hover:scale-105 transition">A</a>';
    items.forEach((it) => {
      if (it.admin && !showAdmin) return;
      const active = isActive(it.href);
      html += '<a href="' + it.href + '" title="' + it.label + '" class="w-10 h-10 rounded-xl flex items-center justify-center transition '
        + (active ? 'bg-pink-50 text-pink-600 dark:bg-pink-900/30 dark:text-pink-300'
                  : 'text-slate-400 hover:bg-slate-100 hover:text-pink-600 dark:hover:bg-ink-700') + '">' + svg(it.icon) + '</a>';
    });
    rail.innerHTML = html;
    document.body.appendChild(rail);
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
      // não-admin tentando abrir página de config -> volta pras conversas
      const cur = items.find((i) => isActive(i.href));
      if (cur && cur.admin && !isAdmin) { location.href = '/atendimento.html'; return; }
      build(isAdmin);
    } catch (e) { /* silencioso */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
