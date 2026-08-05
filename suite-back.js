/* ============================================================
   BOTÃO "VOLTAR À SUÍTE" — padrão único pra TODOS os apps.
   Injeta, ao lado do ícone do app no cabeçalho, um botão com o
   ícone de 4 quadradinhos (grade da Suíte) que leva pra "/".
   - Idempotente (não duplica).
   - Não mexe no ícone do app (identidade) além de garantir o hover.
   - Carregado automaticamente pelo nav.js e pelo suite-user.js, e
     incluído direto nas páginas que não usam nenhum dos dois.
   ============================================================ */
(function(){
  "use strict";
  if (window.__dcSuiteBack) return; window.__dcSuiteBack = true;

  var GRID = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
           + '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>'
           + '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

  function inject(){
    try{
      if (document.getElementById('suiteGridBtn')) return true;
      var header = document.querySelector('header');
      if (!header) return false;

      // grupo da esquerda (onde fica o ícone do app + título)
      var left = header.firstElementChild;
      if (!left || left.tagName !== 'DIV') { var d = header.querySelector('div'); if (d) left = d; }
      if (!left) left = header;

      // primeiro controle interativo = ícone do app
      var appIcon = left.querySelector('a, button');

      // garante hover no ícone do app (identidade "viva")
      if (appIcon && !/hover:scale-/.test(appIcon.className)) {
        appIcon.className += ' hover:scale-105 transition';
      }

      var btn = document.createElement('a');
      btn.id = 'suiteGridBtn';
      btn.href = '/';
      btn.title = 'Voltar à Suíte';
      btn.setAttribute('aria-label', 'Voltar à Suíte');
      btn.className = 'w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 '
                    + 'hover:text-pink-500 hover:bg-slate-100 dark:hover:bg-ink-700 transition flex-shrink-0';
      btn.innerHTML = GRID;

      if (appIcon && appIcon.parentNode) {
        appIcon.insertAdjacentElement('afterend', btn);
      } else {
        left.insertBefore(btn, left.firstChild);
      }
      return true;
    } catch (e) { return false; }
  }

  function boot(){
    if (inject()) return;
    // alguns apps montam o cabeçalho depois — tenta de novo por um tempinho
    var tries = 0;
    var iv = setInterval(function(){
      tries++;
      if (inject() || tries > 20) clearInterval(iv);
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
