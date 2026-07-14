export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const app = process.env.LI_CHAVE_APLICACAO, api = process.env.LI_CHAVE_API;
  if(!app || !api) return res.status(500).json({error:'sem credenciais LI'});
  let path = (req.query && req.query.path) || '/v1/pedido/';
  if(!path.startsWith('/')) path = '/' + path;
  try{
    const u = new URL('https://api.awsli.com.br' + path);
    u.searchParams.set('chave_api', api);
    u.searchParams.set('chave_aplicacao', app);
    Object.keys(req.query||{}).forEach(function(k){ if(k!=='path' && k!=='t') u.searchParams.set(k, req.query[k]); });
    const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
    const text = await r.text();
    let data; try{ data = JSON.parse(text); }catch(e){ data = { raw: text.slice(0,1200) }; }
    res.status(200).json({ status: r.status, data });
  }catch(e){ res.status(500).json({ error: e.message }); }
}
