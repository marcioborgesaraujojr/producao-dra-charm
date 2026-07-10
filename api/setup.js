export default function handler(req, res) {
  const id = process.env.BLING_CLIENT_ID;
    const redirect = encodeURIComponent("https://cep-validador-indol.vercel.app/api/callback");
      const url = "https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=" + id + "&redirect_uri=" + redirect + "&state=setup";
        res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;max-width:500px;margin:0 auto;text-align:center">
        <h2>CEP Validador — Configuracao</h2>
        <p>Clique no botao para autorizar acesso aos seus pedidos no Bling:</p>
        <a href="${url}" style="display:inline-block;background:#1a7f5a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;margin-top:1rem">
          Autorizar no Bling
          </a>
          <p style="margin-top:1.5rem;font-size:12px;color:#888">Voce sera redirecionado de volta automaticamente apos autorizar.</p>
          </body></html>`);
          }
