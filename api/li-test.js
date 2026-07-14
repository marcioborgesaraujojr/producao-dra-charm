export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const app = process.env.LI_CHAVE_APLICACAO, api = process.env.LI_CHAVE_API;
  if(!app || !api) return res.status(500).json({error:'sem credenciais LI'});
  const path = (req.query && req.query.path) || 'pedido/search';
  const qs = (req.query && req.query.qs) || '';
  const url = 'https://api.awsli.com.br/v1/' + path + (qs ? ('?'+qs) : '');
  try{
    const r = await fetch(url, { headers: { 'Authorization': 'chave_api ' + api + ' chave_aplicacao ' + app, 'Content-Type':'application/json' } });
    const text = await r.text();
    let data; try{ data = JSON.parse(text); }catch(e){ data = { raw: text.slice(0,1200) }; }
    res.status(200).json({ status: r.status, url, data });
  }catch(e){ res.status(500).json({ error: e.message }); }
}
