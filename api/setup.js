export default function handler(req, res) {
  const id = process.env.BLING_CLIENT_ID;
  // Callback da PRÓPRIA produção (salva o token no Edge Config que as funções leem).
  const redirect = encodeURIComponent("https://producao-dra-charm.vercel.app/api/callback");
  const url = "https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=" + id + "&redirect_uri=" + redirect + "&state=setup";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar Bling</title></head>
  <body style="font-family:sans-serif;padding:2rem;max-width:520px;margin:0 auto;text-align:center">
  <h2>Conectar ao Bling</h2>
  <p>Clique para autorizar o acesso aos seus produtos e pedidos no Bling:</p>
  <a href="${url}" style="display:inline-block;background:#1a7f5a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;margin-top:1rem">Autorizar no Bling</a>
  <p style="margin-top:1.5rem;font-size:12px;color:#888">Você será redirecionado de volta automaticamente após autorizar.<br>
  Callback: producao-dra-charm.vercel.app/api/callback</p>
  </body></html>`);
}
