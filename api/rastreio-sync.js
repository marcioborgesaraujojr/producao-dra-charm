// Cron da Vercel: roda o ciclo de monitoramento (importa + rastreia + regras).
// Protegido por CMP_CRON_SECRET. A Vercel Cron chama com header Authorization.
import { runCycle } from '../lib/engine.js';

export const config = { maxDuration: 60 };

// Teste READ-ONLY da Loja Integrada (?probe=li) — valida chaves e revela
// os códigos de situação reais da conta. Não escreve nada.
async function liGet(path) {
  const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
  const u = new URL(path.startsWith('http') ? path : base + path);
  u.searchParams.set('chave_api', process.env.LI_CHAVE_API || '');
  u.searchParams.set('chave_aplicacao', process.env.LI_CHAVE_APLICACAO || '');
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

// Explora um pedido específico (por número) para mapear obs + itens + personalização.
async function probeOrder(numero) {
  const out = { numero };
  const lst = await liGet(`/pedido/?numero=${numero}`);
  out.list_status = lst.status;
  const o = (lst.json?.objects || [])[0];
  if (!o) { out.achou = false; return out; }
  out.campos = Object.keys(o);
  out.obs = o.observacoes || o.obs || o.observacao || o.mensagem || null;
  // buscar itens: geralmente sub-recurso /pedido_item/?pedido=<id> ou embutido
  let itens = o.itens || o.items || [];
  if ((!itens || !itens.length) && o.id) {
    const it = await liGet(`/pedido_item/?pedido=${o.id}&limit=50`);
    out.item_status = it.status;
    itens = it.json?.objects || [];
  }
  out.itens = (itens || []).map((i) => ({
    campos: Object.keys(i),
    sku: i.sku, nome: i.nome, quantidade: i.quantidade,
    obs: i.observacao || i.obs || i.personalizacao || null,
    personalizacoes: i.personalizacoes || i.customizacoes || null,
  }));
  return out;
}

async function probeLI(numero) {
  if (numero) return probeOrder(numero);
  const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
  const u = new URL(base + '/pedido/');
  u.searchParams.set('chave_api', process.env.LI_CHAVE_API || '');
  u.searchParams.set('chave_aplicacao', process.env.LI_CHAVE_APLICACAO || '');
  u.searchParams.set('limit', '20');
  const out = {};
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  out.status = r.status;
  let j = null; try { j = await r.json(); } catch {}
  const objs = j?.objects || j?.results || (Array.isArray(j) ? j : []);
  out.total = j?.meta?.total_count ?? null;
  out.amostra = objs.length;
  // códigos de situação reais (para o mapa)
  out.situacoes = [...new Map(objs.map((o) => {
    const s = o.situacao || {}; const cod = s.codigo ?? s.id ?? o.situacao_id;
    return [cod, { codigo: cod, nome: s.nome || s.label || null }];
  })).values()];
  if (objs[0]) {
    const o = objs[0];
    out.campos = Object.keys(o);
    // detectar estrutura de envio/rastreio e itens
    const envio = (o.envios && o.envios[0]) || o.envio || {};
    out.campos_envio = Object.keys(envio);
    const item = (o.itens || o.items || [])[0] || {};
    out.campos_item = Object.keys(item);
    out.exemplo = {
      numero: o.numero, situacao_cod: (o.situacao || {}).codigo, situacao_nome: (o.situacao || {}).nome,
      forma_envio: envio.forma_envio_nome || envio.nome || o.forma_envio_nome,
      objeto: envio.objeto || envio.codigo_rastreio || o.codigo_rastreio || null,
      sku: item.sku || item.produto?.sku || null,
      tem_cliente: !!o.cliente, tem_endereco: !!(o.endereco_entrega || o.enderecoEntrega),
    };
  }
  return out;
}

export default async function handler(req, res) {
  const secret = process.env.CMP_CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.secret;
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (secret && !isVercelCron && provided !== secret) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  try {
    if (req.query.probe === 'li') return res.status(200).json(await probeLI(req.query.numero));
    const result = await runCycle();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
