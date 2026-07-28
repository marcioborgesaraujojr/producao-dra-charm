/* ============================================================
   TEMA CENTRAL — Suíte Dra. Charm
   Edite as cores e a fonte AQUI. Vale para todos os apps que
   carregam este arquivo (logo depois do Tailwind CDN).
   ============================================================ */
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Rosa da marca (500 = cor principal, 600 = versão escura)
        pink: {
          50:  '#fff1f4',
          100: '#ffe1e8',
          200: '#ffc9d6',
          300: '#ff9db4',
          400: '#ff6b90',
          500: '#ff3c6f',
          600: '#ec2560',
          700: '#c81a4e',
          900: '#7a1030'
        },
        // Tons escuros (fundo/superfícies no modo escuro)
        ink: { 900: '#0b1220', 800: '#111827', 700: '#1f2937', 600: '#374151' },
        // Cor de destaque (segue o rosa da marca)
        accent: { DEFAULT: '#ff3c6f', 600: '#ec2560' }
      },
      // Fonte padrão da suíte
      fontFamily: {
        sans: ['Poppins', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif']
      }
    }
  }
};
