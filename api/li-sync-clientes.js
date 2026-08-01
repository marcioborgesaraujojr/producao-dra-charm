// api/li-sync-clientes.js
// ESPELHO dos clientes da Loja Integrada no nosso banco (tabela li_clientes),
// pra checar duplicidade de EMAIL antes de criar um lead no agendamento.
// ⚠️ SÓ LÊ da LI e ESCREVE no NOSSO banco (Supabase). Não cria/edita nada na LI.
//
// Como funciona: pagina o recurso /v1/cliente da LI (que ignora filtros, mas
// pagina normal por offset) e faz upsert em li_clientes usando o EMAIL como
// chave única. É "chunked/resumável": cada chamada avança um pedaço e guarda
// a posição em li_sync_state, então dá pra rodar em loop (carga inicial) ou
// via cron (manutenção) sem estourar o tempo do serverless.
//
// Auth: usuário logado da suíte (pra rodar manual) OU ?secret=<LI_SYNC_SECRET> (pra cron).
import { getLIKeys } from '../lib/licfg.js';
const LI  = 'https://api.awsli.com.br';
const SB  = process.env.SUPABASE_URL;
const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function liGet(path){
  const _k = await getLIKeys(); const app=_k.app, api=_k.api;
  const u = new URL(path.startsWith('http') ? path : LI+path);
  u.searchParams.set('chave_api', api); u.searchParams.set('chave_aplicacao', app);
  const r = await fetch(u.toString(), { headers:{ Accept:'application/json' } });
  let j=null; try{ j=await r.json(); }catch(e){}
  return { status:r.status, j };
}
async function validUser(token){
  if(!token) return null;
  try{
    const r = await fetch(SB+'/auth/v1/user',{headers:{apikey:SRV, Authorization:'Bearer '+token}});
    const j = await r.json(); return (j&&j.id)?j.id:null;
  }catch(e){ return null; }
}
async function sbGetState(){
  try{
    const r = await fetch(SB+'/rest/v1/li_sync_state?id=eq.1&select=pos,total,ultimo_full',
      { headers:{ apikey:SRV, Authorization:'Bearer '+SRV } });
    const j = await r.json(); return (j&&j[0]) || { pos:0, total:null };
  }catch(e){ return { pos:0, total:null }; }
}
async function sbSetState(patch){
  await fetch(SB+'/rest/v1/li_sync_state?id=eq.1', {
    method:'PATCH',
    headers:{ apikey:SRV, Authorization:'Bearer '+SRV, 'Content-Type':'application/json', Prefer:'return=minimal' },
    body: JSON.stringify({ ...patch, atualizado_em: new Date().toISOString() })
  });
}
async function sbUpsert(rows){
  if(!rows.length) return 200;
  const r = await fetch(SB+'/rest/v1/li_clientes?on_conflict=email', {
    method:'POST',
    headers:{ apikey:SRV, Authorization:'Bearer '+SRV, 'Content-Type':'application/json',
              Prefer:'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  return r.status;
}
function normEmail(e){ return String(e||'').trim().toLowerCase(); }

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','authorization, content-type');
  const q = req.query||{};

  // autorização: logado na suíte OU secret (cron)
  const uid = await validUser((req.headers.authorization||'').replace('Bearer ',''));
  const secretOk = !!process.env.LI_SYNC_SECRET && q.secret === process.env.LI_SYNC_SECRET;
  if(!uid && !secretOk) return res.status(401).json({ error:'nao autorizado' });

  const LIMIT = 50;  // tamanho de página na LI (Tastypie costuma capar aqui)
  const paginasPorChamada = Math.min(Math.max(parseInt(q.paginas||'12',10)||12, 1), 40);

  const st  = await sbGetState();
  let pos   = (q.reset==='1') ? 0 : (st.pos||0);
  let total = (q.reset==='1') ? null : (st.total ?? null);
  let lidos=0, gravados=0, fim=false, erroLI=null;

  for(let i=0;i<paginasPorChamada;i++){
    const r = await liGet('/v1/cliente/?limit='+LIMIT+'&offset='+pos);
    if(r.status>=400){ erroLI = r.status; break; }
    const meta = (r.j && r.j.meta) || {};
    if(total===null && typeof meta.total_count==='number') total = meta.total_count;
    const objs = (r.j && (r.j.objects||r.j.results)) || [];
    if(!objs.length){ fim = true; break; }

    // monta linhas, ignora sem email, e deduplica por email DENTRO do batch
    // (Postgres recusa upsert com a mesma chave repetida no mesmo payload)
    const porEmail = {};
    for(const o of objs){
      const email = normEmail(o.email);
      if(!email) continue;
      porEmail[email] = {
        email,
        li_id: o.id || null,
        cpf: String(o.cpf||'').replace(/\D/g,'') || null,
        nome: o.nome || null
      };
    }
    const rows = Object.values(porEmail);
    await sbUpsert(rows);
    lidos += objs.length; gravados += rows.length; pos += LIMIT;
    if(total!==null && pos>=total){ fim = true; break; }
  }

  const patch = { pos: fim?0:pos, total };
  if(fim) patch.ultimo_full = new Date().toISOString();
  await sbSetState(patch);

  return res.status(200).json({
    ok:true, lidos, gravados, offsetAtual: fim?0:pos, total,
    terminou: fim, erroLI
  });
}
