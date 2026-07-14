// /api/li-test.js
// Endpoint pra testar se as credenciais da LI funcionam e ver o SHAPE dos dados
// Uso: GET /api/li-test?pedido=236845

export default async function handler(req, res){
  const num = req.query.pedido;
  const auth = `chave_api ${process.env.LI_API_KEY} chave_aplicacao ${process.env.LI_APPLICATION_KEY}`;

  try {
    if (num){
      // Testa detalhe de 1 pedido
      const r = await fetch(`https://api.awsli.com.br/api/v1/pedido/${num}/`, {
        headers: { Authorization: auth, Accept: 'application/json' }
      });
      const j = await r.json();
      return res.status(200).json({ok: r.ok, status: r.status, order: j});
    }
    // Lista últimos pedidos
    const r = await fetch('https://api.awsli.com.br/api/v1/pedido/?limit=3', {
      headers: { Authorization: auth, Accept: 'application/json' }
    });
    const j = await r.json();
    return res.status(200).json({ok: r.ok, status: r.status, sample: j});
  } catch(e){
    return res.status(500).json({ok: false, error: e.message});
  }
}
