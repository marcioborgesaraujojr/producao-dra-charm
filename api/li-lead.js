// api/li-lead.js
// Cria um LEAD (cliente) na Loja Integrada a partir de um agendamento — SEM duplicar email.
//
// Fluxo:
//   1) valida o TOKEN do agendamento (via RPC ag_get_link, a mesma da página);
//   2) checa o espelho local li_clientes pelo EMAIL;
//        - se JÁ existe  -> não faz nada (já é cliente/lead);
//        - se NÃO existe -> POST /v1/cliente/ na LI e grava no espelho.
//
// ⚠️ Este endpoint ESCREVE na Loja Integrada (cria cliente). É chamado pela
// página pública do agendamento, por isso valida o token antes de qualquer coisa.
import { getLIKeys } from '../lib/licfg.js';
const LI  = 'https://api.awsli.com.br/v1';
const SB  = process.env.SUPABASE_URL;
const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY;

function normEmail(e){ return String(e||'').trim().toLowerCase(); }
const emailOk = (e)=> /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function sbRpc(name, args){
  const r = await fetch(SB+'/rest/v1/rpc/'+name, {
    method:'POST',
    headers:{ apikey:SRV, Authorization:'Bearer '+SRV, 'Content-Type':'application/json' },
    body: JSON.stringify(args)
  });
  let j=null; try{ j=await r.json(); }catch(e){}
  return { status:r.status, j };
}
async function espelhoBusca(email){
  const r = await fetch(SB+'/rest/v1/li_clientes?email=eq.'+encodeURIComponent(email)+'&select=email,li_id', {
    headers:{ apikey:SRV, Authorization:'Bearer '+SRV } });
  const j = await r.json().catch(()=>[]);
  return (Array.isArray(j) && j.length) ? j[0] : null;
}
async function espelhoInsere(row){
  await fetch(SB+'/rest/v1/li_clientes?on_conflict=email', {
    method:'POST',
    headers:{ apikey:SRV, Authorization:'Bearer '+SRV, 'Content-Type':'application/json',
              Prefer:'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row])
  });
}
async function liCriaCliente({ nome, email, telefone, cpf }){
  const _k = await getLIKeys();
  const u = new URL(LI+'/cliente/');   // barra final obrigatória
  u.searchParams.set('chave_api', _k.api||'');
  u.searchParams.set('chave_aplicacao', _k.app||'');
  const corpo = { nome, email };
  if (cpf) corpo.cpf = cpf;
  if (telefone) corpo.telefone_principal = telefone;
  const r = await fetch(u.toString(), {
    method:'POST',
    headers:{ Accept:'application/json', 'Content-Type':'application/json' },
    body: JSON.stringify(corpo)
  });
  let j=null; try{ j=await r.json(); }catch(e){}
  // Tastypie normalmente devolve 201 e o recurso criado (com id / resource_uri)
  return { status:r.status, j };
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','content-type');
  if (req.method !== 'POST') return res.status(405).json({ error:'use POST' });

  let b = req.body; if (typeof b === 'string'){ try{ b = JSON.parse(b); }catch(e){ b = {}; } }
  b = b || {};
  const token    = b.token || '';
  const nome     = String(b.nome||'').trim();
  const email    = normEmail(b.email);
  const telefone = String(b.telefone||'').replace(/\D/g,'') || null;
  const cpf      = String(b.cpf||'').replace(/\D/g,'') || null;
  const debug    = b.debug === true;   // no teste manual, retorna detalhe da resposta da LI

  if (!token) return res.status(400).json({ error:'sem token' });
  if (!emailOk(email)) return res.status(400).json({ error:'email invalido' });

  // 1) valida o token do agendamento (mesma RPC que a página usa)
  const link = await sbRpc('ag_get_link', { p_token: token });
  if (link.status>=400 || !link.j) return res.status(401).json({ error:'token invalido' });

  // 2) já está no espelho? -> não duplica
  const existe = await espelhoBusca(email);
  if (existe) return res.status(200).json({ ok:true, resultado:'ja_existe', li_id: existe.li_id||null });

  // 3) cria na LI
  const criado = await liCriaCliente({ nome, email, telefone, cpf });
  if (criado.status >= 300){
    // LI recusou (pode ser email já cadastrado numa janela de sync). Reporta.
    return res.status(200).json({
      ok:false, resultado:'li_recusou', status:criado.status,
      detalhe: debug ? criado.j : ((criado.j && (criado.j.error||criado.j.error_message)) || null)
    });
  }
  const novo = criado.j || {};
  // 4) grava no espelho pra não recriar depois
  await espelhoInsere({ email, li_id: novo.id||null, cpf, nome: nome||null });
  return res.status(200).json({ ok:true, resultado:'criado', li_id: novo.id||null, detalhe: debug ? novo : undefined });
}
