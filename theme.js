/* ============================================================
   TEMA CENTRAL — Suíte Dra. Charm
   Edite as cores e a fonte AQUI. Vale para todos os apps que
   carregam este arquivo (logo depois do Tailwind CDN).

   Como usar as cores nas classes do Tailwind:
     bg-pink-500, text-pink-600, border-pink-400   (rosa da marca)
     bg-brand2-500                                 (secundária/roxo)
     bg-success-500, text-warning-600, bg-danger-500, text-info-600
   ============================================================ */
/* Por que dentro de try: `tailwind` só existe se o CDN tiver carregado. Se ele demorar,
   cair ou for bloqueado, `tailwind.config = …` estoura ReferenceError na PRIMEIRA linha e
   mata o arquivo inteiro — as abas, o aviso de versão nova, tudo. Com o try, o Tailwind
   pode faltar que o resto do tema continua de pé. */
try {
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* ---- Cor PRINCIPAL da marca (rosa) ---- */
        pink: {
          50:'#fff1f4', 100:'#ffe1e8', 200:'#ffc9d6', 300:'#ff9db4',
          400:'#ff6b90', 500:'#ff3c6f', 600:'#ec2560', 700:'#c81a4e', 900:'#7a1030'
        },

        /* ---- Cor SECUNDÁRIA da marca (roxo — realces/detalhes) ---- */
        brand2: {
          50:'#f5f3ff', 100:'#ede9fe', 400:'#a78bfa', 500:'#8b5cf6', 600:'#7c3aed', 700:'#6d28d9'
        },

        /* ---- Cores SEMÂNTICAS (estados) ---- */
        success: { 50:'#ecfdf5', 500:'#10b981', 600:'#059669', 700:'#047857' }, // verde (ok, WhatsApp)
        warning: { 50:'#fffbeb', 500:'#f59e0b', 600:'#d97706', 700:'#b45309' }, // amarelo (aviso)
        danger:  { 50:'#fff1f2', 500:'#f43f5e', 600:'#e11d48', 700:'#be123c' }, // vermelho (perigo/cancelar)
        info:    { 50:'#eff6ff', 500:'#3b82f6', 600:'#2563eb', 700:'#1d4ed8' }, // azul (informação)

        /* ---- Tons ESCUROS (fundo/superfícies no modo escuro) ---- */
        ink: { 900:'#0b1220', 800:'#111827', 700:'#1f2937', 600:'#374151' },

        /* ---- Cor de destaque (segue o rosa da marca) ---- */
        accent: { DEFAULT:'#ff3c6f', 600:'#ec2560' }
      },

      /* ---- Fonte padrão da suíte ---- */
      fontFamily: {
        sans: ['Poppins', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif']
      }
    }
  }
};
} catch (e) { /* sem Tailwind: segue o baile, o CSS abaixo não depende dele */ }

/* ============================================================
   INTERAÇÃO CENTRAL — hovers/estados iguais em TODOS os apps.
   Um só lugar. Se mudar a marca, muda aqui e vale pra tudo.
   Como usar nas classes/CSS de qualquer app:
     var(--dc-pink-50)   -> fundo do hover rosa (bem clarinho)
     var(--dc-pink-600)  -> texto/realce do hover rosa
     var(--dc-pink-200)  -> borda do hover rosa
     var(--dc-lift)      -> sombra "saltar" ao passar o mouse (cards)
   Classes prontas (funcionam em qualquer app que carrega o theme.js):
     .dc-lift        -> card clicável ganha leve 3D no hover
     .dc-refreshing  -> gira o ícone (setinhas) enquanto atualiza
   ============================================================ */
(function(){
  try {
    var css = ''
      + ':root{'
      +   '--dc-pink:#ff3c6f;--dc-pink-600:#ec2560;--dc-pink-700:#c81a4e;'
      +   '--dc-pink-50:#fff1f4;--dc-pink-100:#ffe1e8;--dc-pink-200:#ffc9d6;--dc-pink-300:#ff9db4;'
      +   '--dc-lift:0 4px 12px rgba(15,23,42,.10);'
      + '}'
      /* Fonte única em TODO o sistema: campos/botões herdam a Poppins do body
         (input/textarea/select/button não herdam font-family sozinhos → sem isso, cada campo virava uma fonte diferente). */
      + 'input,textarea,select,button{font-family:inherit}'
      /* Barra de rolagem SEMPRE reservada. Sem isso, ir de uma tela curta (Visão geral)
         pra uma comprida (Gatilhos, Fila) fazia a página inteira pular ~15px pro lado —
         a "tremidazinha" que aparecia só ao trocar de página. */
      + 'html{overflow-y:scroll}'
      /* card clicável: leve 3D no hover (mesmo efeito em todo lugar) */
      + '.dc-lift{transition:transform .16s ease, box-shadow .16s ease}'
      + '.dc-lift:hover{box-shadow:var(--dc-lift)}'
      /* girar o ícone de atualizar enquanto carrega */
      + '@keyframes dc-spin{to{transform:rotate(360deg)}}'
      + '.dc-refreshing svg{animation:dc-spin .7s linear infinite}'
      /* ====== PADRÃO DAS ABAS (dc-tab) ======
         UM desenho de aba pra suíte inteira: texto simples com sublinhado rosa na
         escolhida. É o desenho do painel de Lojas, que é a página mais usada — as
         outras é que vieram atrás.

         Histórico pra não repetir o erro: isto já foi "pílula branca com a ativa em
         rosa sólido". Ficou parecendo botão, e como o lojas.html continuou desenhando
         a aba dele na mão, a suíte passou a ter DOIS desenhos de aba ao mesmo tempo.
         Agora o lojas.html usa esta classe também. Se for mudar aba, muda AQUI e
         pronto — não desenhar aba na mão em página nenhuma.

         Uso: <div class="dc-tabs"><div class="dc-tab" data-on="1">Nome</div>…</div>
         Aceita data-on="1" ou data-active="1" pra marcar a aba escolhida. */
      + '.dc-tabs{display:flex;flex-wrap:wrap;gap:4px;align-items:center;'
      +   'border-bottom:1px solid #e2e8f0;padding-bottom:1px}'
      + '.dark .dc-tabs{border-bottom-color:#374151}'
      + '.dc-tab{padding:8px 12px;font-size:13px;font-weight:600;line-height:1.2;cursor:pointer;'
      +   'white-space:nowrap;background:none;border:none;border-bottom:2px solid transparent;'
      +   'border-radius:8px 8px 0 0;color:#64748b;transition:color .12s,border-color .12s}'
      + '.dark .dc-tab{color:#94a3b8}'
      + '.dc-tab:hover{color:var(--dc-pink-600)}'
      + '.dc-tab[data-on="1"],.dc-tab[data-active="1"]{color:var(--dc-pink-600);border-bottom-color:var(--dc-pink)}'
      + '.dark .dc-tab[data-on="1"],.dark .dc-tab[data-active="1"]{color:#ff9db4}'
      /* ====== ATALHO / FILTRO (dc-chip) ======
         Pra botãozinho de filtro rápido (7 / 15 / 30 dias). NÃO é aba: aba troca a tela,
         chip só muda um parâmetro. Usar .dc-tab aqui deixava um risco horizontal solto
         no meio do formulário. */
      + '.dc-chip{padding:7px 12px;border-radius:10px;font-size:12px;font-weight:600;line-height:1.2;'
      +   'cursor:pointer;white-space:nowrap;border:1px solid #e2e8f0;background:#fff;color:#64748b;'
      +   'transition:background .12s,color .12s,border-color .12s}'
      + '.dark .dc-chip{background:#1f2937;border-color:#374151;color:#94a3b8}'
      + '.dc-chip:hover{color:var(--dc-pink-600);border-color:var(--dc-pink-200);background:var(--dc-pink-50)}'
      + '.dark .dc-chip:hover{background:rgba(255,60,111,.16);color:#ff9db4;border-color:transparent}'
      + '.dc-chip[data-on="1"]{background:var(--dc-pink);border-color:var(--dc-pink);color:#fff}'
      /* ====== TABELA (dc: .tb / .tb-h / .tb-l / .cel) ======
         Lista com colunas, do jeito do Notificações: cabeçalho cinza, linhas separadas,
         e campos que parecem texto até você clicar. Usada nas perguntas e situações do
         Chatbot e nas Etiquetas do Pipelines.

         Mora AQUI porque já nasceu duas vezes: o CSS ficou dentro do chatbot.html e,
         quando a tela de Etiquetas usou as mesmas classes, ela apareceu sem grid
         nenhum — tudo empilhado numa coluna só.

         A linha aceita `style="grid-template-columns:…"` pra ajustar as colunas. */
      + '.tb{border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff}'
      + '.dark .tb{border-color:#334155;background:#111827}'
      + '.tb-h,.tb-l{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr) 30px;gap:10px;align-items:start}'
      + '.tb-h{padding:8px 12px;background:#f8fafc;font-size:11px;font-weight:700;color:#64748b;'
      +   'text-transform:uppercase;letter-spacing:.03em}'
      + '.dark .tb-h{background:#0f172a;color:#94a3b8}'
      + '.tb-l{padding:8px 12px;border-top:1px solid #eef2f7}'
      + '.dark .tb-l{border-top-color:#1f2937}'
      + '.tb-l:hover{background:#fafbfc}.dark .tb-l:hover{background:#0f172a}'
      /* campo dentro da linha: parece texto, vira campo quando clica */
      + '.cel{width:100%;font-size:13px;line-height:1.45;padding:6px 8px;border-radius:8px;'
      +   'border:1px solid transparent;background:transparent;color:inherit;resize:none;'
      +   'overflow:hidden;font-family:inherit;display:block}'
      + '.cel:hover{border-color:#e2e8f0}.dark .cel:hover{border-color:#334155}'
      + '.cel:focus{outline:none;border-color:var(--dc-pink);background:#fff}.dark .cel:focus{background:#1f2937}'
      + '.cel::placeholder{color:#cbd5e1}'
      + '.tb-x{background:none;border:none;color:#cbd5e1;cursor:pointer;padding:8px 0 0 0;line-height:0}'
      + '.tb-x:hover{color:#f43f5e}'
      + '@media (max-width:700px){'
      +   '.tb-h{display:none}'
      +   '.tb-l{grid-template-columns:minmax(0,1fr) 30px!important;gap:4px}'
      +   '.tb-l .cel:first-child{font-weight:600}'
      + '}'
      /* Esconder painel de aba. `hidden` sozinho não basta: uma classe de display do
         Tailwind (.grid, .flex) tem a MESMA especificidade e carrega depois, então
         ganha — a aba trocava e o painel antigo continuava na tela por baixo. */
      + '[data-painel][hidden]{display:none!important}';
    var s = document.createElement('style');
    s.id = 'dc-ui';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  } catch(e){}
})();

/* ============================================================
   AVISO DE VERSÃO NOVA — quando sai um deploy, aparece o banner
   "Nova versão disponível" com o botão Atualizar. QUEM DECIDE A HORA
   DE RECARREGAR É O USUÁRIO. A Vercel preenche /api/version com o
   hash do commit a cada deploy (automático).

   ATENÇÃO: NÃO voltar a recarregar sozinho. A versão antiga deste arquivo
   chamava location.reload() ao detectar deploy novo sempre que a aba
   ganhava foco e ninguém estava digitando — o atendimento perdia a
   conversa aberta no meio do atendimento ao cliente (reclamação real
   da equipe, 19/08/2026). Quem está lendo uma conversa não está com o
   cursor num campo, então a trava de "está digitando" não protegia.

   Este é o ÚNICO lugar que trata isso — vale para todos os apps que
   carregam o theme.js. Não duplicar em página nenhuma.
   ============================================================ */
(function(){
  var loaded = null, avisado = false;

  function mostrarAviso(){
    if (avisado || document.getElementById('updBanner')) return;
    avisado = true;
    var b = document.createElement('div');
    b.id = 'updBanner';
    b.setAttribute('style','position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:12px;background:#0f172a;color:#fff;padding:11px 14px 11px 16px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.28);font-family:Poppins,system-ui,sans-serif;font-size:13px;max-width:92vw;animation:updIn .35s ease');
    var txt = document.createElement('span');
    txt.style.cssText = 'display:inline-flex;align-items:center;gap:8px';
    txt.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"/></svg><span>Nova versão disponível</span>';
    var btn = document.createElement('button');
    btn.textContent = 'Atualizar';
    btn.setAttribute('style','background:#22c55e;color:#06280f;border:none;border-radius:9px;padding:7px 14px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit');
    btn.onclick = function(){ try { location.reload(); } catch(e){} };
    var x = document.createElement('button');
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="width:12px;height:12px;display:block"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    x.setAttribute('title','Depois');
    x.setAttribute('style','background:none;border:none;color:#94a3b8;font-size:14px;cursor:pointer;padding:2px 4px;line-height:1');
    x.onclick = function(){ var e = document.getElementById('updBanner'); if (e) e.remove(); };
    b.appendChild(txt); b.appendChild(btn); b.appendChild(x);
    (document.body || document.documentElement).appendChild(b);
    if (!document.getElementById('updKf')){
      var st = document.createElement('style'); st.id = 'updKf';
      st.textContent = '@keyframes updIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}';
      document.head.appendChild(st);
    }
  }

  function check(){
    fetch('/api/version', { cache:'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        var v = (j && j.v) || null;
        if (!v) return;
        if (loaded === null){ loaded = v; return; }   // 1ª leitura: versão que o usuário carregou
        if (v !== loaded) mostrarAviso();
      })
      .catch(function(){});
  }

  try {
    setInterval(check, 60000);
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) check(); });
    window.addEventListener('focus', check);
    check();
  } catch(e){}
})();
