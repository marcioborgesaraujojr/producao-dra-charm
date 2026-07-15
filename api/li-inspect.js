const LI = 'https://api.awsli.com.br';
async function liGet(path){
  const app=process.env.LI_CHAVE_APLICACAO, api=process.env.LI_CHAVE_API;
  const u=new URL(path.startsWith('http')?path:LI+path);
  u.searchParams.set('chave_api',api); u.searchParams.set('chave_aplicacao',app);
  const r=await fetch(u.toString(),{headers:{Accept:'application/json'}});
  let j=null; try{ j=await r.json(); }catch(e){}
  return {status:r.status, j};
}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  try{
    const lst=await liGet('/v1/pedido/?limit=4&order_by=-data_criacao');
    const objs=(lst.j&&lst.j.objects)||[];
    const out=[];
    for(const o of objs){
      if(!o.resource_uri) continue;
      const det=await liGet(o.resource_uri); const d=det.j||{};
      let firstItem=null;
      if(d.itens && d.itens.length){
        const it=d.itens[0];
        firstItem={ keys:Object.keys(it), sample:it };
      }
      out.push({
        numero:d.numero,
        topKeys:Object.keys(d),
        situacao: d.situacao,
        itensCount: d.itens? d.itens.length : null,
        firstItem
      });
    }
    res.status(200).json({out});
  }catch(e){ res.status(500).json({error:e.message}); }
}
