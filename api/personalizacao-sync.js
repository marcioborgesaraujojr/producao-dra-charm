const LI = 'https://api.awsli.com.br';
const PERSO_LIST = '7c4cd407-c2b0-4a16-b802-acd29f996ca8';
async function liGet(path){
  const app=process.env.LI_CHAVE_APLICACAO, api=process.env.LI_CHAVE_API;
  const u=new URL(path.startsWith('http')?path:LI+path);
  u.searchParams.set('chave_api',api); u.searchParams.set('chave_aplicacao',app);
  const r=await fetch(u.toString(),{headers:{Accept:'application/json'}});
  let j=null; try{ j=await r.json(); }catch(e){}
  return {status:r.status, j};
}
function parseBordado(obs){
  if(!obs) return [];
  const lines=obs.split(/\r?\n/); const blocks=[]; let cur=null;
  for(const raw of lines){
    const m=raw.trim().match(/^--\s*([^:]+):\s*(.*)$/);
    if(m){ const label=m[1].trim().toLowerCase().replace(/\*/g,'').trim(); const val=m[2].trim();
      if(cur && cur[label]!==undefined){ blocks.push(cur); cur=null; }
      if(!cur) cur={}; cur[label]=val; }
  }
  if(cur) blocks.push(cur);
  return blocks.map(f=>{
    const l1=f['linha 1']||f['linha1']||'', l2=f['linha 2']||'', l3=f['linha 3']||'';
    const hasPerso=!!(l1||l2||l3);
    const tipo=hasPerso?'nome_profissao':(/logo/i.test(JSON.stringify(f))?'logomarca':null);
    const corRaw=f['cores']||f['cor']||'';
    let corHex=null, corNome=corRaw;
    const cm=corRaw.match(/^(#?[0-9a-fA-F]{6})\s*-\s*(.+)$/);
    if(cm){ corHex=cm[1].startsWith('#')?cm[1]:('#'+cm[1]); corNome=cm[2].trim(); }
    return { tipo, linha1:l1, linha2:l2||l3, fonte:f['tipo de letra']||null, corHex, corNome:corNome||null, lado:f['lados']||f['lado']||null };
  }).filter(b=>b.linha1||b.linha2||b.tipo);
}
async function sbREST(method, path, body){
  const url=process.env.SUPABASE_URL+'/rest/v1/'+path;
  const h={'apikey':process.env.SUPABASE_SERVICE_ROLE_KEY,'Authorization':'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'};
  if(method!=='GET') h['Prefer']='return=representation';
  const r=await fetch(url,{method,headers:h,body:body?JSON.stringify(body):undefined});
  let j=null; try{ j=await r.json(); }catch(e){}
  return {status:r.status, j};
}
async function validUser(token){
  if(!token) return null;
  try{ const r=await fetch(process.env.SUPABASE_URL+'/auth/v1/user',{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:'Bearer '+token}}); const j=await r.json(); return (j && j.id) ? j.id : null; }catch(e){ return null; }
}
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  const q=req.query||{};
  const commit = q.commit==='1';
  const bearer=(req.headers.authorization||'').replace('Bearer ','');
  let userId = null;
  let auth = (q.key && q.key===process.env.CMP_CRON_SECRET);
  if(commit && !auth){ userId = await validUser(bearer); auth = !!userId; }
  if(commit && !auth) return res.status(401).json({error:'precisa estar logado pra sincronizar'});
  const limit=Math.min(parseInt(q.limit||'120',10),200);
  try{
    const candidatos=[]; let pagina=0; let scanned=0; const perPage=50;
    while(scanned<limit){
      const off=pagina*perPage;
      const lst=await liGet('/v1/pedido/?limit='+perPage+'&offset='+off+'&order_by=-data_criacao');
      const objs=(lst.j&&lst.j.objects)||[]; if(!objs.length) break;
      for(const o of objs){ scanned++; if(!o.resource_uri) continue;
        const det=await liGet(o.resource_uri); const d=det.j||{};
        // pula pedidos cancelados/devolvidos (situacao pode vir como objeto ou resource_uri)
        let sitTxt='';
        const sit=d.situacao;
        if(sit){ if(typeof sit==='string'){ try{ const sd=await liGet(sit); sitTxt=((sd.j&&(sd.j.codigo||sd.j.nome))||''); }catch(e){} } else { sitTxt=(sit.codigo||sit.nome||sit.situacao||''); } }
        if(/cancel|devolv/i.test(String(sitTxt))) continue;
        const blocks=parseBordado(d.cliente_obs); if(!blocks.length) continue;
        const b=blocks[0];
        candidatos.push({ numero:String(d.numero), id_li:d.id, cliente:(d.cliente&&(d.cliente.nome||d.cliente.email))||null, b, qtd:blocks.length, situacao:String(sitTxt||'?') });
      }
      if(objs.length<perPage) break; pagina++;
    }
    const nums=[...new Set(candidatos.map(c=>c.numero))];
    let existentes=[];
    if(nums.length){ const ex=await sbREST('GET','cards?select=pedido_numero&pedido_numero=in.('+nums.join(',')+')'); existentes=(ex.j||[]).map(x=>String(x.pedido_numero)); }
    const seen={}; const novos=candidatos.filter(c=>{ if(existentes.includes(c.numero)||seen[c.numero]) return false; seen[c.numero]=1; return true; });
    const rows=novos.map(c=>({
      list_id:PERSO_LIST, title:(c.cliente||('Pedido '+c.numero)), position:Date.now(), created_by:userId,
      pedido_numero:c.numero, pedido_cliente:c.cliente,
      bordado_tipo:c.b.tipo, bordado_linha1:c.b.linha1||null, bordado_linha2:c.b.linha2||null,
      bordado_cor_hex:c.b.corHex, bordado_cor_nome:c.b.corNome, bordado_fonte:c.b.fonte, bordado_lado:c.b.lado,
      pedido_url: c.id_li?('https://app.lojaintegrada.com.br/painel/pedido/'+c.id_li+'/detalhar'):null
    }));
    let inserted=0, insErr=null;
    if(commit && rows.length){ const ins=await sbREST('POST','cards',rows); if(ins.status>=200&&ins.status<300){ inserted=(ins.j||[]).length; } else { insErr=ins.j; } }
    res.status(200).json({ dryrun:!commit, varridos:scanned, comBordado:candidatos.length, jaExistem:candidatos.length-novos.length, criaria:novos.length, inserted, insErr, amostra: novos.slice(0,6).map(c=>({numero:c.numero, situacao:c.situacao, cliente:c.cliente?'ok':null, tipo:c.b.tipo, cor:c.b.corNome, fonte:c.b.fonte, lado:c.b.lado})) });
  }catch(e){ res.status(500).json({error:e.message}); }
}
