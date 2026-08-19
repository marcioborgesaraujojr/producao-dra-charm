// api/disparos-log.js
// Lê o log de disparos dos gatilhos (at_disparos_log) para a aba "Fila de envios".
//
// Por que existe: a tabela tem RLS ligada e NENHUMA política — de propósito, porque só a
// API escreve nela. Consequência: se a página tentar ler direto do navegador, o PostgREST
// devolve lista vazia sem erro, e a fila aparece zerada mesmo com evento chegando. Então a
// leitura passa por aqui, com a service role, restrita a quem está logado na suíte.
//
// GET /api/disparos-log?loja=loja_integrada&limite=300
//   -> { itens: [...], loja, semColuna: bool }

async function callerEmail(token){
  if(!token) return null;
  try{
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token }
    });
    const j = await r.json();
    return (j && j.email) ? String(j.email).toLowerCase() : null;
  }catch(e){ return null; }
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const quem = await callerEmail(token);
  if(!quem) return res.status(403).json({ error: 'Sessão inválida. Faça login na suíte.' });

  const loja = String(req.query.loja || '').trim();
  const limite = Math.min(parseInt(req.query.limite, 10) || 300, 1000);

  const H = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  const base = process.env.SUPABASE_URL + '/rest/v1/at_disparos_log'
             + '?select=id,evento_key,loja,telefone,pedido,template_name,status,detalhe,created_at'
             + '&order=created_at.desc&limit=' + limite;

  // Com filtro de loja. Se a coluna ainda não existir no banco, cai pra sem filtro e avisa.
  let url = base + (loja ? '&loja=eq.' + encodeURIComponent(loja) : '');
  let r = await fetch(url, { headers: H });
  let semColuna = false;

  if(!r.ok && loja){
    let t = ''; try{ t = await r.text(); }catch(e){}
    if(/loja/i.test(t)){
      semColuna = true;
      r = await fetch(base, { headers: H });
    }
  }
  if(!r.ok){
    let t = ''; try{ t = await r.text(); }catch(e){}
    return res.status(500).json({ error: 'Não consegui ler o log: ' + (t || r.status) });
  }

  const itens = await r.json();
  return res.status(200).json({ itens: Array.isArray(itens) ? itens : [], loja, semColuna });
}
