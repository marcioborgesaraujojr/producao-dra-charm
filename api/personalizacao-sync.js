import { getLIKeys } from '../lib/licfg.js';
const LI = 'https://api.awsli.com.br';
const PERSO_LIST = '7c4cd407-c2b0-4a16-b802-acd29f996ca8';
// SKUs dos "acréscimos" de personalização (igual à extensão)
const SKU_LOGOMARCA = 'U4UDXDTVP';
const SKU_PERSONALIZACAO = 'QGH2F6NFR';
const SKIP_SKUS = new Set([SKU_LOGOMARCA, SKU_PERSONALIZACAO]);

async function liGet(path){
  const _k=await getLIKeys(); const app=_k.app, api=_k.api;
  const u=new URL(path.startsWith('http')?path:LI+path);
  u.searchParams.set('chave_api',api); u.searchParams.set('chave_aplicacao',app);
  const r=await fetch(u.toString(),{headers:{Accept:'application/json'}});
  let j=null; try{ j=await r.json(); }catch(e){}
  return {status:r.status, j};
}

// Extrai todos os campos "-- Label: valor" do cliente_obs num objeto plano (first-wins), igual à extensão
function parseFields(obs){
  const fields={};
  if(!obs) return fields;
  for(const raw of String(obs).split(/\r?\n/)){
    const m=raw.trim().match(/^--\s*([^:]+):\s*(.*)$/);
    if(m){
      const k=m[1].trim().toLowerCase().replace(/\*/g,'').replace(/\.$/,'').trim();
      const v=m[2].trim();
      if(k && fields[k]===undefined) fields[k]=v;
    }
  }
  return fields;
}

// Monta um bordado a partir dos campos já parseados de um bloco (raw = texto do bloco pra achar URL de imagem)
function buildBordadoFromFields(f, raw){
  let corHex=null, corNome=null;
  if(f['cores']){
    const cm=f['cores'].match(/^(#?[0-9a-fA-F]{3,8})\s*-\s*(.+)$/);
    if(cm){ corHex=cm[1].startsWith('#')?cm[1]:('#'+cm[1]); corNome=cm[2].trim(); }
    else corNome=f['cores'];
  }
  let imgUrl = f['fazer upload da imagem'] || null;
  if(!imgUrl){ const m=String(raw||'').match(/https?:\/\/[^\s\n\])]+\.(?:jpg|jpeg|png|pdf|svg|gif)/i); if(m) imgUrl=m[0]; }
  const linha1 = f['linha 1'] || null;
  const linha2 = f['linha 2'] || f['linha 3'] || null;
  const hasLinhas = !!(linha1 || linha2);
  // Opção que o cliente escolheu/PAGOU (ex: "Sim (Nome, Profissão e Logomarca)"). É o sinal mais confiável
  // do tipo do que a imagem — o upload do logo às vezes não vem (bug de cache), mas a opção fica registrada.
  let opTxt = '';
  for(const k in f){ if(/^op[çc]/i.test(k)) opTxt += ' ' + f[k]; }
  const optLogo = /logo/i.test(opTxt);
  const optNome = /nome|profiss/i.test(opTxt);
  const wantLogo = optLogo || !!imgUrl;
  const wantNome = optNome || hasLinhas;
  let tipo = null;
  if(wantLogo && wantNome) tipo='ambos';
  else if(wantLogo) tipo='logomarca';
  else if(wantNome) tipo='nome_profissao';
  // Pagou/escolheu logo mas a imagem não veio no pedido => precisa confirmar com o cliente e anexar a logo.
  const logoPendente = wantLogo && !imgUrl;
  return {
    tipo,
    linha1, linha2,
    corHex, corNome,
    fonte: f['tipo de letra'] || null,
    lado: f['lados'] || f['lado'] || null,
    imagem: imgUrl,
    logoPendente,
    detalhes: f['detalhes do bordado (opcional)'] || f['detalhes do bordado'] || null
  };
}
// Bordado "do card" (nível pedido, first-wins) — mantém o tipo do pedido pra compatibilidade
function buildBordado(tipoOrder, obs){
  const b = buildBordadoFromFields(parseFields(obs), obs);
  b.tipo = tipoOrder;
  return b;
}
// Bordado de CADA SKU: mapa sku(minúsculo) -> LISTA de bordados (um por bloco "** sku [..] **").
// É lista (não 1 objeto) porque o MESMO sku pode aparecer várias vezes com bordados diferentes
// (ex: 1 produto, 2 unidades, 2 nomes distintos). Antes o 2º bloco sobrescrevia o 1º e sumia 1 bordado.
function parseBordadoBySku(obs){
  const map={};
  const block=String(obs||'');
  const skuMatches=[...block.matchAll(/\*\*\s*([^\s\[*]+)[^*]*\*\*/g)];
  for(let i=0;i<skuMatches.length;i++){
    const sku=skuMatches[i][1].trim().toLowerCase();
    const start=skuMatches[i].index+skuMatches[i][0].length;
    const end=(i+1<skuMatches.length)?skuMatches[i+1].index:block.length;
    const content=block.slice(start,end);
    const f=parseFields(content);
    if(Object.keys(f).length===0) continue; // bloco sem bordado
    (map[sku] || (map[sku]=[])).push(buildBordadoFromFields(f, content));
  }
  return map;
}

function tamanhoOf(variacao){
  if(!variacao || typeof variacao!=='object') return null;
  for(const k of Object.keys(variacao)){ if(/tamanho/i.test(k)){ const v=variacao[k]; if(v && v.nome) return String(v.nome).trim(); } }
  const first=Object.values(variacao)[0];
  return (first && first.nome) ? String(first.nome).trim() : null;
}

// Descobre quais SKUs têm bordado de verdade: no cliente_obs, o SKU aparece como "** sku [..] **"
// e só é bordado se tiver ao menos 1 campo "-- Campo:" logo abaixo dele (igual à extensão).
function computeBordadoSkus(obs){
  const set=new Set();
  const block=String(obs||'');
  const skuMatches=[...block.matchAll(/\*\*\s*([^\s\[*]+)[^*]*\*\*/g)];
  for(let i=0;i<skuMatches.length;i++){
    const sku=skuMatches[i][1].trim().toLowerCase();
    const start=skuMatches[i].index+skuMatches[i][0].length;
    const end=(i+1<skuMatches.length)?skuMatches[i+1].index:block.length;
    const content=block.slice(start,end);
    if(/--\s+\S[^:]*:/.test(content)) set.add(sku);
  }
  return set;
}

function isSkipItem(it){
  const sku=String(it.sku||'').toUpperCase();
  const nome=String(it.nome||'');
  return SKIP_SKUS.has(sku) || /acr[eé]scimo|embalagem|personaliza/i.test(nome);
}

function pickImg(pj){
  const imgs = pj.imagens || pj.imagem || [];
  const f = (Array.isArray(imgs)?imgs[0]:imgs) || null;
  if(!f) return { url: pj.imagem_principal||null, keys:null };
  if(typeof f==='string') return { url:f, keys:'string' };
  const url = f.thumbnail || f['64x64'] || f.pequena || f.media || f.grande || f.url || f.imagem || f.src || f.caminho || null;
  return { url, keys:Object.keys(f) };
}

// Monta produtos com foto (excluindo os itens de acréscimo). Imagem vem do produto_pai (variação não tem imagem).
async function buildProdutos(itens, cache, obs){
  const out=[]; let dbg=null;
  const bset=computeBordadoSkus(obs);
  const bySku=parseBordadoBySku(obs);      // sku -> [bordado, ...]
  const expandido=new Set();               // evita expandir o mesmo sku 2x (caso venha em 2 linhas)
  for(const it of (itens||[])){
    if(!it || isSkipItem(it)) continue;
    const ref = it.produto_pai || it.produto;
    let imagem_url=null, keys=null;
    if(ref){
      if(cache[ref]!==undefined){ imagem_url=cache[ref].url; keys=cache[ref].keys; }
      else {
        try{ const p=await liGet(ref); const r=pickImg(p.j||{}); imagem_url=r.url; keys=r.keys; }catch(e){}
        cache[ref]={url:imagem_url, keys};
      }
    }
    if(!dbg) dbg={ ref: ref||null, keys };
    const skuLc=String(it.sku||'').toLowerCase();
    const qtd=Math.round(parseFloat(it.quantidade||'1'))||1;
    const blocks=bySku[skuLc]||[];
    const base={ sku: it.sku||null, nome: it.nome||'', bordado: bset.has(skuLc), tamanho: tamanhoOf(it.variacao), imagem_url };
    // Mesmo SKU com VÁRIOS bordados (ex: 2 unidades, 2 nomes diferentes) => 1 produto por bordado,
    // dividindo a quantidade. Assim o card mostra as 2 personalizações e os 2 produtos.
    if(blocks.length>=2 && !expandido.has(skuLc)){
      expandido.add(skuLc);
      const N=blocks.length, per=Math.floor(qtd/N), rem=qtd-per*N;
      for(let k=0;k<N;k++){ out.push({ ...base, qtd: Math.max(1, per+(k<rem?1:0)), bordadoInfo: blocks[k] }); }
    } else {
      // 1 bloco (ou sku já expandido numa linha anterior): comportamento normal.
      out.push({ ...base, qtd, bordadoInfo: expandido.has(skuLc) ? null : (blocks[0]||null) });
    }
  }
  return { produtos: out, dbg };
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
  // Modo "buscar 1 pedido" (só leitura): puxa cliente + produtos da LI pra criar card manual.
  if (q.lookup==='1'){
    const uid = await validUser((req.headers.authorization||'').replace('Bearer ',''));
    if(!uid) return res.status(401).json({error:'precisa estar logado'});
    const num=String(q.numero||'').trim().replace(/[^0-9]/g,'');
    if(!num) return res.status(400).json({error:'informe o número do pedido'});
    try{
      let d=null;
      const r=await liGet('/v1/pedido/?numero='+encodeURIComponent(num)+'&limit=1');
      const o=(r.j&&r.j.objects&&r.j.objects[0])||null;
      if(o&&o.resource_uri){ const dd=await liGet(o.resource_uri); d=dd.j||o; }
      else { const dr=await liGet('/v1/pedido/'+num+'/'); if(dr.status>=200&&dr.status<300) d=dr.j; }
      if(!d || !d.itens) return res.status(404).json({error:'Pedido '+num+' não encontrado na Loja Integrada'});
      const cliente=(d.cliente&&(d.cliente.nome||d.cliente.email))||null;
      const rb=await buildProdutos(d.itens, {}, d.cliente_obs);
      return res.status(200).json({ ok:true, numero:num, cliente, produtos: rb.produtos||[] });
    }catch(e){ return res.status(500).json({error:e.message}); }
  }
  const commit = q.commit==='1';
  const backfill = q.backfill==='1';
  const bearer=(req.headers.authorization||'').replace('Bearer ','');
  let userId = null;
  let auth = (q.key && q.key===process.env.CMP_CRON_SECRET);
  if(commit && !auth){ userId = await validUser(bearer); auth = !!userId; }
  if(commit && !auth) return res.status(401).json({error:'precisa estar logado pra sincronizar'});
  const limit=Math.min(parseInt(q.limit||'120',10),300);
  // Janela de datas (igual à extensão). O UI manda data_inicio/data_fim.
  let de=q.data_inicio||q.de||null, ate=q.data_fim||q.ate||null;
  // Em execução automática (cron/commit) sem datas, usa janela dos últimos 4 dias por segurança.
  if(commit && !de && !ate){ const now=new Date(); de=new Date(now.getTime()-4*86400000).toISOString().slice(0,10); ate=now.toISOString().slice(0,10); }
  const deT = de ? Date.parse(de+'T00:00:00') : null;
  const ateT = ate ? Date.parse(ate+'T23:59:59') : null;
  const usaData = (deT!==null || ateT!==null);

  // ===== Varredura "mover enviados": guiada pelos CARDS (não pela data de criação) =====
  // Pega os cards parados nas colunas de bordado, consulta a situação ATUAL de cada pedido na LI
  // e move os enviados/entregues pra "Bordado Concluído". Cobre pedidos antigos (o pedido é
  // enviado dias depois de criado, então a varredura por data de criação não os alcança).
  // Paginado (offset/limit) pra não estourar o tempo da função nem o rate limit da LI.
  if(q.movershipped==='1'){
    try{
      const off=parseInt(q.offset||'0',10);
      const lim=Math.min(parseInt(q.limit||'25',10),40);
      const enviadoRx = s => /enviad|entreg|despach|transito|trânsito|transporte|postad/i.test(String(s||'').toLowerCase());
      const pl = await sbREST('GET','lists?select=board_id&id=eq.'+PERSO_LIST);
      const boardId=(pl.j&&pl.j[0]&&pl.j[0].board_id)||null;
      if(!boardId) return res.status(200).json({movershipped:true, erro:'board de Personalização não encontrado'});
      const cl = await sbREST('GET','lists?select=id,name&board_id=eq.'+boardId+'&archived=eq.false');
      const persoLists=cl.j||[];
      const concl = persoLists.find(l=>/expedid|finaliz/i.test(l.name)) || persoLists.find(l=>/conclu/i.test(l.name));
      if(!concl) return res.status(200).json({movershipped:true, erro:'coluna "Expedido/Finalizado" não encontrada', colunas:persoLists.map(l=>l.name)});
      const outrasIds = persoLists.filter(l=>l.id!==concl.id).map(l=>l.id);
      if(!outrasIds.length) return res.status(200).json({movershipped:true, checked:0, shipped:0, moved:0, nextOffset:0, temMais:false, total:0, coluna:concl.name});
      // total de cards a conferir (só na 1ª página, pra alimentar a barra de progresso)
      let total=null;
      if(off===0){ const tc=await sbREST('GET','cards?select=id&archived=eq.false&pedido_numero=not.is.null&list_id=in.('+outrasIds.join(',')+')&limit=2000'); total=(tc.j||[]).length; }
      const sel = await sbREST('GET','cards?select=id,pedido_numero,list_id&archived=eq.false&pedido_numero=not.is.null&list_id=in.('+outrasIds.join(',')+')&order=pedido_numero.desc&limit='+lim+'&offset='+off);
      const cards=sel.j||[];
      let checked=0, shipped=0, moved=0, err=null; const amostra=[];
      for(const cd of cards){
        checked++;
        const num=String(cd.pedido_numero); let sitTxt='';
        try{
          const r=await liGet('/v1/pedido/?numero='+encodeURIComponent(num)+'&limit=1');
          const o=(r.j&&r.j.objects&&r.j.objects[0])||null; let d=null;
          if(o&&o.resource_uri){ const dd=await liGet(o.resource_uri); d=dd.j||o; }
          else { const dr=await liGet('/v1/pedido/'+num+'/'); if(dr.status>=200&&dr.status<300) d=dr.j; }
          if(d){ const sit=d.situacao; if(sit){ if(typeof sit==='string'){ try{ const sd=await liGet(sit); sitTxt=((sd.j&&(sd.j.codigo||sd.j.nome))||''); }catch(e){} } else sitTxt=(sit.codigo||sit.nome||sit.situacao||''); } }
        }catch(e){}
        if(enviadoRx(sitTxt)){
          shipped++;
          if(commit){ const mv=await sbREST('PATCH','cards?id=eq.'+cd.id,{list_id:concl.id, position:Date.now()}); if(mv.status>=200&&mv.status<300) moved++; else err=mv.j; }
          else moved++;
          if(amostra.length<12) amostra.push({num, situacao:sitTxt});
        }
      }
      return res.status(200).json({movershipped:true, dryrun:!commit, coluna:concl.name, offset:off, total, checked, shipped, moved, nextOffset:off+cards.length, temMais:cards.length===lim, err, amostra});
    }catch(e){ return res.status(500).json({movershipped:true, error:e.message, stack:String(e.stack||'').slice(0,300)}); }
  }

  // Backfill completo: percorre os cards de personalização que ainda estão SEM produtos,
  // busca o pedido na LI pelo número e preenche pedido_produtos (cobre pedidos antigos).
  if(q.fullbackfill==='1'){
    try{
      const force=q.force==='1';
      const fbLimit=Math.min(parseInt(q.fbLimit||'12',10),25);
      const fbOffset=parseInt(q.fbOffset||'0',10);
      const filtro = force ? 'bordado_tipo=not.is.null&pedido_numero=not.is.null'
                           : 'bordado_tipo=not.is.null&pedido_numero=not.is.null&pedido_produtos=is.null';
      const sel=await sbREST('GET','cards?select=id,pedido_numero&'+filtro+'&order=pedido_numero.desc&limit='+fbLimit+'&offset='+fbOffset);
      const cards=sel.j||[];
      const totResp=await sbREST('GET','cards?select=pedido_numero&'+filtro);
      const total=(totResp.j||[]).length;
      const imgCache={}; const results=[]; let updated=0, updErr=null;
      for(const cd of cards){
        const num=String(cd.pedido_numero); let d=null;
        try{
          const r=await liGet('/v1/pedido/?numero='+encodeURIComponent(num)+'&limit=1');
          const o=(r.j&&r.j.objects&&r.j.objects[0])||null;
          if(o&&o.resource_uri){ const dd=await liGet(o.resource_uri); d=dd.j||o; }
          else { const dr=await liGet('/v1/pedido/'+num+'/'); if(dr.status>=200&&dr.status<300) d=dr.j; }
        }catch(e){}
        if(!d || !d.itens){ results.push({num, found:false}); continue; }
        const rb=await buildProdutos(d.itens, imgCache, d.cliente_obs);
        const prod=(rb.produtos&&rb.produtos.length)?rb.produtos:null;
        if(commit && (force || prod)){ const up=await sbREST('PATCH','cards?id=eq.'+cd.id, {pedido_produtos:prod}); if(up.status>=200&&up.status<300) updated++; else updErr=up.j; }
        results.push({num, found:true, nProd:(rb.produtos||[]).length, comBordado:(rb.produtos||[]).filter(p=>p.bordado).length});
      }
      const nextOffset = force ? (fbOffset+cards.length) : 0;
      return res.status(200).json({fullbackfill:true, force, commit, processados:cards.length, updated, total, fbOffset, nextOffset, restam:(force? Math.max(0,total-nextOffset) : (total-cards.length)), updErr, results});
    }catch(e){ return res.status(500).json({error:e.message, stack:String(e.stack||'').slice(0,300)}); }
  }

  try{
    const candidatos=[]; let pagina=0; let scanned=0; const perPage=50;
    const maxScan = usaData ? 3000 : limit;   // com janela de datas, varre tudo no período
    let paraLoop=false;
    while(scanned<maxScan && !paraLoop){
      const off=pagina*perPage;
      const lst=await liGet('/v1/pedido/?limit='+perPage+'&offset='+off+'&order_by=-data_criacao');
      const objs=(lst.j&&lst.j.objects)||[]; if(!objs.length) break;
      for(const o of objs){ scanned++;
        if(usaData){
          const dc = o.data_criacao ? Date.parse(o.data_criacao) : null;
          if(dc!==null){
            if(deT!==null && dc<deT){ paraLoop=true; break; }   // ordenado desc: passou do início => para
            if(ateT!==null && dc>ateT) continue;                // mais novo que o fim => pula
          }
        }
        if(!o.resource_uri) continue;
        const det=await liGet(o.resource_uri); const d=det.j||{};
        // Detecta pedido de personalização pelo SKU dos itens (igual à extensão)
        const skus=(d.itens||[]).map(it=>String(it.sku||'').toUpperCase());
        const hasLogo=skus.includes(SKU_LOGOMARCA);
        const hasPerso=skus.includes(SKU_PERSONALIZACAO);
        if(!hasLogo && !hasPerso) continue;
        const tipoOrder = (hasLogo&&hasPerso)?'ambos':(hasLogo?'logomarca':'nome_profissao');
        // Situação
        let sitTxt='';
        const sit=d.situacao;
        if(sit){ if(typeof sit==='string'){ try{ const sd=await liGet(sit); sitTxt=((sd.j&&(sd.j.codigo||sd.j.nome))||''); }catch(e){} } else { sitTxt=(sit.codigo||sit.nome||sit.situacao||''); } }
        const b=buildBordado(tipoOrder, d.cliente_obs);
        candidatos.push({ numero:String(d.numero), id_li:d.id, cliente:(d.cliente&&(d.cliente.nome||d.cliente.email))||null, b, situacao:String(sitTxt||'?'), itens:d.itens, obs:d.cliente_obs });
      }
      if(objs.length<perPage) break; pagina++;
    }
    // Regra de status: pago (ou além) => card. efetuado/aguardando pagamento/cancelado/devolvido => sem card (e apaga se existir)
    const semCard = s => { const t=String(s||'').toLowerCase(); return /cancel|devolv|efetuad|estorn|charge|disputa|an[aá]lise|reembols/.test(t) || (/aguardando/.test(t)&&/pag/.test(t)) || /pagamento\s*pendente|pendente\s*pagamento/.test(t) || /novo\s*pedido/.test(t); };
    const nums=[...new Set(candidatos.map(c=>c.numero))];
    let existSet=new Set();
    if(nums.length){ const ex=await sbREST('GET','cards?select=pedido_numero&pedido_numero=in.('+nums.join(',')+')'); (ex.j||[]).forEach(x=>existSet.add(String(x.pedido_numero))); }
    const seen={}; const toCreate=[]; const toDelete=[]; const toUpdate=[]; let comBordadoValidos=0;
    for(const c of candidatos){
      if(seen[c.numero]) continue; seen[c.numero]=1;
      const deveTer = !semCard(c.situacao);
      const temCard = existSet.has(c.numero);
      if(deveTer) comBordadoValidos++;
      if(deveTer && !temCard) toCreate.push(c);
      else if(!deveTer && temCard) toDelete.push(c.numero);
      else if(deveTer && temCard && backfill) toUpdate.push(c);
    }
    const imgCache={};
    for(const c of toCreate){ const r=await buildProdutos(c.itens, imgCache, c.obs); c.produtos=r.produtos; c._dbg=r.dbg; }
    for(const c of toUpdate){ const r=await buildProdutos(c.itens, imgCache, c.obs); c.produtos=r.produtos; c._dbg=r.dbg; }
    const rows=toCreate.map(c=>({
      list_id:PERSO_LIST, title:(c.cliente||('Pedido '+c.numero)), position:Date.now(), created_by:userId,
      pedido_numero:c.numero, pedido_cliente:c.cliente,
      bordado_tipo:c.b.tipo, bordado_linha1:c.b.linha1, bordado_linha2:c.b.linha2,
      bordado_cor_hex:c.b.corHex, bordado_cor_nome:c.b.corNome, bordado_fonte:c.b.fonte, bordado_lado:c.b.lado,
      bordado_imagem_url:c.b.imagem, bordado_detalhes:c.b.detalhes,
      pedido_produtos: (c.produtos && c.produtos.length) ? c.produtos : null,
      pedido_url: c.id_li?('https://app.lojaintegrada.com.br/painel/pedido/'+c.id_li+'/detalhar'):null
    }));
    let inserted=0, insErr=null, deleted=0, delErr=null, updated=0, updErr=null;
    if(commit && rows.length){ const ins=await sbREST('POST','cards',rows); if(ins.status>=200&&ins.status<300){ inserted=(ins.j||[]).length; } else { insErr=ins.j; } }
    if(commit && toDelete.length){ for(const num of toDelete){ const dl=await sbREST('DELETE','cards?pedido_numero=eq.'+num); if(dl.status>=200&&dl.status<300){ deleted++; } else { delErr=dl.j; } } }
    if(commit && backfill && toUpdate.length){
      for(const c of toUpdate){
        const patch={
          bordado_tipo:c.b.tipo, bordado_linha1:c.b.linha1, bordado_linha2:c.b.linha2,
          bordado_cor_hex:c.b.corHex, bordado_cor_nome:c.b.corNome, bordado_fonte:c.b.fonte, bordado_lado:c.b.lado,
          bordado_imagem_url:c.b.imagem, bordado_detalhes:c.b.detalhes,
          pedido_produtos:(c.produtos&&c.produtos.length)?c.produtos:null
        };
        const up=await sbREST('PATCH','cards?pedido_numero=eq.'+c.numero, patch);
        if(up.status>=200&&up.status<300){ updated++; } else { updErr=up.j; }
      }
    }
    // ===== Regra: pedido ENVIADO/ENTREGUE na LI => move o card pra "Bordado Concluído" =====
    // Roda a cada sync (retroativo). Antes só existia no webhook, que dependia de evento novo da LI
    // e ainda procurava uma coluna "Expedido" que não existe no board (por isso pedidos enviados
    // como o 238862 ficavam parados na coluna de bordado).
    const enviadoRx = s => /enviad|entreg|despach|transito|trânsito|transporte|postad/i.test(String(s||'').toLowerCase());
    let movedConcluido=0, moveErr=null, concluidoListId=null, moveDbg=null;
    try{
      const pl = await sbREST('GET','lists?select=board_id&id=eq.'+PERSO_LIST);
      const persoBoardId = (pl.j && pl.j[0] && pl.j[0].board_id) || null;
      if(persoBoardId){
        const cl = await sbREST('GET','lists?select=id,name&board_id=eq.'+persoBoardId+'&archived=eq.false');
        const persoLists = cl.j || [];
        const concl = persoLists.find(l=>/expedid|finaliz/i.test(l.name)) || persoLists.find(l=>/conclu/i.test(l.name));
        concluidoListId = concl ? concl.id : null;
        moveDbg = { board:persoBoardId, colConcluido: concl?concl.name:null };
        if(concluidoListId){
          const listIdSet = new Set(persoLists.map(l=>l.id));
          const enviadoNums = [...new Set(candidatos.filter(c=>enviadoRx(c.situacao) && existSet.has(c.numero)).map(c=>c.numero))];
          if(enviadoNums.length){
            const cr = await sbREST('GET','cards?select=id,list_id,pedido_numero&archived=eq.false&pedido_numero=in.('+enviadoNums.join(',')+')');
            const cardsE = cr.j || [];
            const byNum={};
            cardsE.forEach(x=>{ const cur=byNum[x.pedido_numero]; if(!cur || (listIdSet.has(x.list_id) && !listIdSet.has(cur.list_id))) byNum[x.pedido_numero]=x; });
            for(const num of enviadoNums){
              const card = byNum[num]; if(!card) continue;
              if(!listIdSet.has(card.list_id)) continue;      // card não é do board de Personalização
              if(card.list_id === concluidoListId) continue;   // já está em Concluído
              if(commit){
                const mv = await sbREST('PATCH','cards?id=eq.'+card.id, { list_id:concluidoListId, position:Date.now() });
                if(mv.status>=200&&mv.status<300) movedConcluido++; else moveErr=mv.j;
              } else { movedConcluido++; }
            }
          }
        }
      }
    }catch(e){ moveErr=String(e.message||e); }

    const jaExistem=[...new Set(candidatos.filter(c=>existSet.has(c.numero)).map(c=>c.numero))].length;
    res.status(200).json({
      dryrun:!commit, varridos:scanned, comBordado:candidatos.length, comBordadoValidos, criaria:toCreate.length, apagaria:toDelete.length, atualizaria:toUpdate.length, jaExistem, inserted, deleted, updated, insErr, delErr, updErr,
      moveuConcluido:movedConcluido, moveErr, moveDbg,
      amostraCriar: toCreate.slice(0,5).map(c=>({numero:c.numero, situacao:c.situacao, tipo:c.b.tipo, fonte:c.b.fonte, produtosCount:(c.produtos||[]).length, produtoSample:(c.produtos||[])[0], imgDbg:c._dbg})),
      amostraApagar: toDelete.slice(0,10)
    });
  }catch(e){ res.status(500).json({error:e.message, stack:String(e.stack||'').slice(0,300)}); }
}
