// api/li-cliente.js
// PROBE (só leitura) — valida se dá pra achar o cliente na Loja Integrada pelo CPF.
// Uso: /api/li-cliente?probe=1&cpf=00000000000  (precisa estar logado na suíte)
// NÃO cria nada na LI. A criação de cliente/lead fica pra etapa seguinte, com confirmação.
import { getLIKeys } from '../lib/licfg.js';
const LI = 'https://api.awsli.com.br';

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
  try{ const r=await fetch(process.env.SUPABASE_URL+'/auth/v1/user',{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:'Bearer '+token}}); const j=await r.json(); return (j&&j.id)?j.id:null; }catch(e){ return null; }
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','authorization, content-type');
  const q = req.query||{};
  const uid = await validUser((req.headers.authorization||'').replace('Bearer ',''));
  if(!uid) return res.status(401).json({error:'precisa estar logado (probe restrito)'});

  // count=1: quantos clientes existem na loja (pra saber se dá pra espelhar no nosso banco).
  if(q.count==='1'){
    const r = await liGet('/v1/cliente/?limit=1');
    const meta = (r.j && r.j.meta) || {};
    // também mede quanto tempo leva puxar uma página cheia (limit=50)
    const r2 = await liGet('/v1/cliente/?limit=50');
    const pag = (r2.j && (r2.j.objects||r2.j.results)) || [];
    return res.status(200).json({
      ok:true, status:r.status,
      total_clientes: (typeof meta.total_count==='number') ? meta.total_count : null,
      limitePorPagina: meta.limit || null,
      tamanhoPaginaTeste: pag.length,
      meta
    });
  }

  // schema=1: pergunta pra própria LI quais métodos o recurso "cliente" aceita (só leitura, não cria nada).
  if(q.schema==='1'){
    const sc = await liGet('/v1/cliente/schema/');
    const s = sc.j || {};
    return res.status(200).json({
      ok:true, status: sc.status,
      metodos_lista: s.allowed_list_http_methods || null,     // se tiver "post" => dá pra CRIAR cliente
      metodos_item:  s.allowed_detail_http_methods || null,   // "put"/"patch" => dá pra editar
      campos: s.fields ? Object.keys(s.fields) : null,
      erro: sc.status>=400 ? (s.error_message||JSON.stringify(s).slice(0,160)) : null
    });
  }

  // checkemail=<email>: testa se a busca por email FUNCIONA de verdade (pra dedup).
  // Só leitura. Retorna se o filtro foi respeitado (todos os retornados batem com o email pedido).
  if(q.checkemail){
    const email = String(q.checkemail).trim().toLowerCase();
    const e = encodeURIComponent(email);
    // testa varias sintaxes de filtro do Tastypie pra ver se ALGUMA restringe de verdade
    const variantes = [
      'email='+e, 'email__exact='+e, 'email__iexact='+e,
      'q='+e, 'search='+e, 'busca='+e
    ];
    const testes = [];
    for(const v of variantes){
      const r = await liGet('/v1/cliente/?'+v+'&limit=5');
      const objs = (r.j && (r.j.objects||r.j.results)) || [];
      const emails = objs.map(o => String(o.email||'').toLowerCase());
      const todosBatem = emails.length>0 && emails.every(x => x===email);
      testes.push({
        filtro: v.split('=')[0],
        status: r.status,
        achou: objs.length,
        restringiu: todosBatem,       // true => filtro respeitado
        erro: r.status>=400 ? (r.j && (r.j.error_message||JSON.stringify(r.j).slice(0,120))) : null
      });
    }
    const algumFunciona = testes.find(t => t.restringiu);
    return res.status(200).json({
      ok:true, emailPedido: email,
      dedupPossivel: !!algumFunciona,
      filtroQueFunciona: algumFunciona ? algumFunciona.filtro : null,
      testes
    });
  }

  let cpf = String(q.cpf||'').replace(/\D/g,'');
  let cpfOrigem = 'informado';
  // auto=1: pega o CPF de um pedido recente da própria LI (pra auto-testar sem manusear CPF de ninguém)
  if(!cpf && q.auto==='1'){
    try{
      const lst = await liGet('/v1/pedido/?limit=8&order_by=-data_criacao');
      for(const o of (lst.j && lst.j.objects || [])){
        let d = o; if(o.resource_uri){ const dd=await liGet(o.resource_uri); d=dd.j||o; }
        let cli = d.cliente; if(typeof cli==='string' && cli.startsWith('/api')){ const cr=await liGet(cli); cli=cr.j||{}; }
        const doc = String((cli&&(cli.cpf||cli.cnpj))||'').replace(/\D/g,'');
        if(doc){ cpf=doc; cpfOrigem='pedido '+d.numero; break; }
      }
    }catch(e){}
  }
  if(!cpf) return res.status(400).json({error:'informe ?cpf= (ou use ?auto=1)'});

  // Tastypie: testa alguns filtros comuns pra ver qual a LI aceita.
  const tentativas = [
    '/v1/cliente/?cpf='+cpf+'&limit=3',
    '/v1/cliente/?cnpj='+cpf+'&limit=3',
    '/v1/cliente/?documento='+cpf+'&limit=3',
    '/v1/cliente/?cpf_cnpj='+cpf+'&limit=3',
  ];
  const resultados = [];
  for(const path of tentativas){
    try{
      const r = await liGet(path);
      const objs = (r.j && (r.j.objects||r.j.results)) || [];
      resultados.push({
        filtro: path.replace('/v1/cliente/?','').replace('&limit=3',''),
        status: r.status,
        achou: Array.isArray(objs) ? objs.length : 0,
        campos: (objs[0] ? Object.keys(objs[0]) : null),
        amostra: objs[0] ? { nome:objs[0].nome, email:objs[0].email, cpf:objs[0].cpf, cnpj:objs[0].cnpj, telefones: objs[0].telefones||objs[0].telefone||null } : null,
        erro: (r.status>=400) ? (r.j && (r.j.error_message||r.j.error||JSON.stringify(r.j).slice(0,160))) : null
      });
    }catch(e){ resultados.push({ filtro:path, erro:e.message }); }
  }
  return res.status(200).json({ ok:true, cpf: cpf.slice(0,3)+'...'+cpf.slice(-2), cpfOrigem, resultados });
}
