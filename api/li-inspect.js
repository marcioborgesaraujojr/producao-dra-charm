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
      let produtoInfo=null;
      if(d.itens && d.itens.length){
        const it = d.itens.find(x=>x && x.produto && !/acr[eé]scimo/i.test(x.nome||'')) || d.itens[0];
        if(it && it.produto){
          const p=await liGet(it.produto); const pj=p.j||{};
          const imgs = pj.imagens || null;
          produtoInfo = {
            itemNome: it.nome,
            produtoKeys: Object.keys(pj),
            imagensType: Array.isArray(imgs)?('array['+imgs.length+']'):(typeof imgs),
            firstImagem: Array.isArray(imgs)? imgs[0] : imgs,
            imagem_principal: pj.imagem_principal || null
          };
        }
      }
      out.push({ numero:d.numero, situacao: d.situacao&&d.situacao.codigo, itensCount: d.itens? d.itens.length : null, produtoInfo });
    }
    res.status(200).json({out});
  }catch(e){ res.status(500).json({error:e.message}); }
}
