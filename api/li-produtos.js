// api/li-produtos.js
// Lista os MODELOS (produtos) da Loja Integrada pra alimentar o campo "Modelo"
// da Rastreabilidade do Acabamento.
//
// Auth: usuário logado da suíte (Bearer) OU ?secret=<LI_SYNC_SECRET>.
// Retorna { modelos: [...nomes distintos], total, parcial }.

import { getLIKeys } from '../lib/licfg.js';

const LI  = 'https://api.awsli.com.br';
const SB  = process.env.SUPABASE_URL;
const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function liGet(path){
  const _k = await getLIKeys(); const app = _k.app, api = _k.api;
  const u = new URL(path.startsWith('http') ? path : LI + path);
  u.searchParams.set('chave_api', api || '');
  u.searchParams.set('chave_aplicacao', app || '');
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
async function validUser(token){
  if(!token) return null;
  try{ const r = await fetch(SB + '/auth/v1/user', { headers:{ apikey: SRV, Authorization: 'Bearer ' + token } });
    const j = await r.json(); return (j && j.id) ? j.id : null; }catch(e){ return null; }
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = (req.query && req.query.secret) || '';
  const token  = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const okSecret = process.env.LI_SYNC_SECRET && secret === process.env.LI_SYNC_SECRET;
  const uid = okSecret ? 'cron' : await validUser(token);
  if (!uid) return res.status(403).json({ error: 'Sessão inválida. Faça login na suíte.' });

  // Itens que NÃO são modelo de peça — não aparecem na lista do Acabamento.
  const EXCLUIR = /^acr[eé]scimo\b|embalagem|\bteste\b/i;

  try {
    const LIMIT = 100; let offset = 0, total = null, pages = 0;
    const pais = new Set(), todos = new Set();
    while (pages < 50) {
      const r = await liGet('/v1/produto/?limit=' + LIMIT + '&offset=' + offset);
      if (r.status !== 200 || !r.j) {
        if (pages === 0) return res.status(502).json({ error: 'A Loja Integrada não respondeu (confira as chaves da loja).', status: r.status });
        break;
      }
      const meta = r.j.meta || {};
      if (total === null && typeof meta.total_count === 'number') total = meta.total_count;
      const objs = r.j.objects || r.j.results || [];
      if (!objs.length) break;
      for (const p of objs) {
        let nome = String((p && p.nome) || '').trim();
        if (!nome) continue;
        // Colapsa variações de tamanho: "Vestido X TAMANHO :G" -> "Vestido X"
        nome = nome.split(/\s*TAMANHO\s*:/i)[0].trim();
        if (!nome) continue;
        // Esconde itens que não são modelo de peça (acréscimos, embalagem, testes)
        if (EXCLUIR.test(nome)) continue;
        todos.add(nome);
        const pai = p ? p.produto_pai : undefined;
        if (pai == null || pai === '') pais.add(nome);   // produto "base" = modelo
      }
      offset += LIMIT; pages++;
      if (total !== null && offset >= total) break;
    }
    let lista = [...pais];
    if (lista.length < 3) lista = [...todos];            // se a loja não usa variação, usa todos
    lista.sort((a, b) => a.localeCompare(b, 'pt'));
    return res.status(200).json({ modelos: lista, total, parcial: pages >= 50 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
