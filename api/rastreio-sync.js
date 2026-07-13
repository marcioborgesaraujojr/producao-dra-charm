// Cron da Vercel: roda o ciclo de monitoramento (importa + rastreia + regras).
// Protegido por CMP_CRON_SECRET. A Vercel Cron chama com header Authorization.
import { runCycle } from '../lib/engine.js';

export const config = { maxDuration: 60 };

// Teste READ-ONLY da Loja Integrada (?probe=li) — valida chaves e revela
// os códigos de situação reais da conta. Não escreve nada.
async function probeLI() {
  const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
  const auth = `chave_api ${process.env.LI_CHAVE_API} chave_aplicacao ${process.env.LI_CHAVE_APLICACAO}`;
  const call = async (path) => {
    const r = await fetch(base + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, raw: j ? null : t.slice(0, 300) };
  };
  const out = { base, temChaveApi: !!process.env.LI_CHAVE_API, temChaveApp: !!process.env.LI_CHAVE_APLICACAO };
  const p = await call('/pedido?limit=20');
  out.pedido_status = p.status;
  if (p.raw) out.pedido_raw = p.raw;
  const objs = p.json?.objects || p.json?.results || (Array.isArray(p.json) ? p.json : []);
  out.total_meta = p.json?.meta?.total_count ?? null;
  out.amostra_qtd = objs.length;
  out.situacoes = [...new Map(objs.map((o) => { const s = o.situacao || {}; return [s.codigo ?? o.situacao_id, { codigo: s.codigo ?? o.situacao_id, nome: s.nome || s.label }]; })).values()];
  if (objs[0]) {
    const o = objs[0]; const envio = (o.envios && o.envios[0]) || {};
    out.campos_pedido = Object.keys(o);
    out.exemplo = { numero: o.numero, situacao: o.situacao, forma_envio: envio.forma_envio_nome || o.forma_envio_nome, objeto: envio.objeto || o.codigo_rastreio || null, sku: (o.itens || o.items || [])[0]?.sku || null, tem_cliente: !!o.cliente, tem_endereco: !!o.endereco_entrega };
  }
  for (const path of ['/situacao', '/pedido/situacao', '/situacao_pedido']) {
    const s = await call(path);
    if (s.status === 200 && s.json) { out.situacao_endpoint = path; const l = s.json.objects || s.json.results || s.json; out.situacoes_oficiais = (Array.isArray(l) ? l : []).map((x) => ({ codigo: x.codigo ?? x.id, nome: x.nome || x.label })); break; }
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
    if (req.query.probe === 'li') return res.status(200).json(await probeLI());
    const result = await runCycle();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
