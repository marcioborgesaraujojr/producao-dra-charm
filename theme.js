/* ============================================================
   TEMA CENTRAL — Suíte Dra. Charm
   Edite as cores e a fonte AQUI. Vale para todos os apps que
   carregam este arquivo (logo depois do Tailwind CDN).

   Como usar as cores nas classes do Tailwind:
     bg-pink-500, text-pink-600, border-pink-400   (rosa da marca)
     bg-brand2-500                                 (secundária/roxo)
     bg-success-500, text-warning-600, bg-danger-500, text-info-600
   ============================================================ */
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
      /* card clicável: leve 3D no hover (mesmo efeito em todo lugar) */
      + '.dc-lift{transition:transform .16s ease, box-shadow .16s ease}'
      + '.dc-lift:hover{box-shadow:var(--dc-lift)}'
      /* girar o ícone de atualizar enquanto carrega */
      + '@keyframes dc-spin{to{transform:rotate(360deg)}}'
      + '.dc-refreshing svg{animation:dc-spin .7s linear infinite}';
    var s = document.createElement('style');
    s.id = 'dc-ui';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  } catch(e){}
})();
