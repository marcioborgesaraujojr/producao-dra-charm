/* ============================================================
   BOTÃO "VOLTAR À SUÍTE" — padrão único pra TODOS os apps.
   Injeta, no lado DIREITO do cabeçalho (junto dos ícones de
   ação, igual ao quadro de Produção), um botão com o ícone de
   4 quadradinhos (grade da Suíte) que leva pra "/".
   - Idempotente (não duplica).
   - Combina com o estilo dos outros ícones de cada app.
   - Carregado automaticamente pelo nav.js e pelo suite-user.js.
   ============================================================ */
(function(){
  "use strict";
  if (window.__dcSuiteBack) return; window.__dcSuiteBack = true;

  var GRID = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
           + '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>'
           + '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  // estilo padrão (igual ao do quadro de Produção), caso o app não tenha um ícone de referência
  var FALLBACK_CLS = 'p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:text-pink-500 transition-colors flex items-center justify-center flex-shrink-0';

  function makeBtn(cls){
    var a = document.createElement('a');
    a.id = 'suiteGridBtn';
    a.href = '/';
    a.title = 'Voltar à Suíte';
    a.setAttribute('aria-label', 'Voltar à Suíte');
    a.className = cls;
    a.innerHTML = GRID;
    return a;
  }
  function cleanCls(el){ return (el && el.className ? String(el.className) : '').replace(/\bhidden\b/g, '').trim(); }

  function inject(){
    try{
      if (document.getElementById('suiteGridBtn')) return true;
      var header = document.querySelector('header');
      if (!header) return false;

      var left  = header.firstElementChild;
      var right = header.lastElementChild;
      if (!right) return false;

      // garante hover no ícone do app (identidade, à esquerda)
      if (left) {
        var appIcon = left.querySelector('a, button');
        if (appIcon && !/hover:scale-/.test(appIcon.className)) appIcon.className += ' hover:scale-105 transition';
      }

      if (right !== left && right.tagName === 'DIV') {
        // grupo de ações à direita: entra como PRIMEIRO ícone do grupo (junto dos demais)
        var ref = right.querySelector('button, a');
        var btn = makeBtn(ref ? cleanCls(ref) : FALLBACK_CLS);
        right.insertBefore(btn, right.firstChild);
      } else {
        // lado direito "solto" (um controle sem div em volta, ex.: whatsapp)
        var loose = (right !== left && /^(BUTTON|A)$/.test(right.tagName)) ? right : null;
        var btn2 = makeBtn(loose ? cleanCls(loose) : FALLBACK_CLS);
        btn2.style.marginLeft = 'auto';   // empurra pra direita, junto do(s) controle(s) seguinte(s)
        if (loose) header.insertBefore(btn2, loose);
        else header.appendChild(btn2);
      }
      return true;
    } catch (e) { return false; }
  }

  function boot(){
    if (inject()) return;
    var tries = 0;
    var iv = setInterval(function(){ tries++; if (inject() || tries > 20) clearInterval(iv); }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
