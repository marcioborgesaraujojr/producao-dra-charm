/* ============================================================
   BOTÃO "VOLTAR À SUÍTE" — padrão único pra TODOS os apps.
   Injeta, no lado DIREITO do cabeçalho (junto dos ícones de
   ação, igual ao quadro de Produção), um botão com o ícone de
   4 quadradinhos (grade da Suíte) que leva pra "/".
   - Estilo FIXO e igual em todos os apps (cinza, hover rosa).
   - Remove o botãozinho redundante de "voltar" que alguns apps
     tinham no lado direito usando o logo "a" (icone-app.png).
   - Idempotente. Carregado pelo nav.js e pelo suite-user.js.
   ============================================================ */
(function(){
  "use strict";
  if (window.__dcSuiteBack) return; window.__dcSuiteBack = true;

  var GRID = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
           + '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>'
           + '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  // estilo ÚNICO do botão (mesmo do quadro de Produção) — não copia estilo de vizinho
  var STD_CLS = 'p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:text-pink-500 transition-colors flex items-center justify-center flex-shrink-0';

  function makeBtn(){
    var a = document.createElement('a');
    a.id = 'suiteGridBtn';
    a.href = '/';
    a.title = 'Voltar à Suíte';
    a.setAttribute('aria-label', 'Voltar à Suíte');
    a.className = STD_CLS;
    a.innerHTML = GRID;
    return a;
  }

  function inject(){
    try{
      if (document.getElementById('suiteGridBtn')) return true;
      var header = document.querySelector('header');
      if (!header) return false;

      var left = header.firstElementChild;

      // garante hover no ícone do app (identidade, à esquerda)
      if (left) {
        var appIcon = left.querySelector('a, button');
        if (appIcon && !/hover:scale-/.test(appIcon.className)) appIcon.className += ' hover:scale-105 transition';
      }

      // remove o "voltar" redundante que usa o logo "a" (icone-app.png) — menos o ícone de identidade da esquerda
      Array.prototype.forEach.call(header.querySelectorAll('button, a'), function(el){
        if (el.id === 'suiteGridBtn') return;
        if (left && left.contains(el)) return;               // preserva a identidade à esquerda
        if (el.querySelector('img[src*="icone-app"]')) el.remove();
      });

      // recalcula o lado direito depois da limpeza
      var right = header.lastElementChild;
      if (!right) return false;

      var btn = makeBtn();
      if (right !== left && right.tagName === 'DIV') {
        // grupo de ações à direita: entra como PRIMEIRO ícone do grupo
        right.insertBefore(btn, right.firstChild);
      } else {
        // lado direito "solto" (um controle sem div em volta) ou só o grupo da esquerda
        var loose = (right !== left && /^(BUTTON|A)$/.test(right.tagName)) ? right : null;
        btn.style.marginLeft = 'auto';
        if (loose) header.insertBefore(btn, loose);
        else header.appendChild(btn);
      }
      return true;
    } catch (e) { return false; }
  }

  // ---- PADRÃO ÚNICO DAS "CAIXINHAS BRANCAS" (igual ao Workflows) ----
  // Borda fina/clarinha, fundo branco sólido e SEM sombra em repouso.
  // (o realce 3D no hover dos cards clicáveis continua, quando o app tiver.)
  function injectCardStyle(){
    if (document.getElementById('dcSuiteCards')) return;
    // OBS: o :not(.tab) é essencial. Sem ele, este "vidro" pintava de branco também os
    // botões de aba (que usam rounded-xl+border+bg-white) e a aba ATIVA ficava branco no branco.
    var css =
      '.card:not(.tab),.rounded-2xl.border.bg-white:not(.tab),.rounded-xl.border.bg-white:not(.tab){'
        + 'background:rgba(255,255,255,.82)!important;-webkit-backdrop-filter:blur(8px)!important;backdrop-filter:blur(8px)!important;'
        + 'box-shadow:none!important;border-color:#eef2f7!important;}'
      + 'html.dark .card:not(.tab),html.dark .rounded-2xl.border.dark\\:bg-ink-800:not(.tab),html.dark .rounded-xl.border.dark\\:bg-ink-800:not(.tab){'
        + 'background:rgba(31,41,55,.72)!important;box-shadow:none!important;border-color:#334155!important;}'
      // ---- PADRÃO ÚNICO DAS ABAS (vale pra todos os apps da suíte) ----
      // Aba ativa = pílula rosa da marca com texto branco. Antes cada app tinha um jeito
      // (rosa no Agendamento, roxo no Acabamento) — agora é igual em tudo.
      + '.tab{transition:background .15s,color .15s,border-color .15s;font-weight:600;cursor:pointer}'
      + '.tab.tab-on,.tab[data-on="1"]{background:#ff3c6f!important;color:#fff!important;border-color:#ff3c6f!important}'
      + '.tab.tab-on svg,.tab[data-on="1"] svg{color:#fff!important;stroke:currentColor}'
      + '.tab:not(.tab-on):not([data-on="1"]){color:#64748b!important;background:rgba(255,255,255,.82)!important;border-color:#eef2f7!important}'
      + 'html.dark .tab:not(.tab-on):not([data-on="1"]){color:#94a3b8!important;background:rgba(31,41,55,.72)!important;border-color:#334155!important}'
      + '.tab:not(.tab-on):not([data-on="1"]):hover{color:#ff3c6f!important;background:#fff1f5!important;border-color:#ffc2d4!important}'
      + 'html.dark .tab:not(.tab-on):not([data-on="1"]):hover{color:#f9a8c4!important;background:rgba(255,60,111,.12)!important}';
    var st = document.createElement('style');
    st.id = 'dcSuiteCards';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function boot(){
    injectCardStyle();
    if (inject()) return;
    var tries = 0;
    var iv = setInterval(function(){ tries++; if (inject() || tries > 20) clearInterval(iv); }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
