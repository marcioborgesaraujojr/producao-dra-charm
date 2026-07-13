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

// Explora um pedido recente para mapear obs + itens + personalização (bordado).
async function probeOrder(numero) {
  const out = { alvo: numero || 'recentes' };
  // pega pedidos recentes; procura o alvo ou o primeiro com itens
  const lst = await liGet(`/pedido/?limit=10&order_by=-data_criacao`);
  out.list_status = lst.status;
  let objs = lst.json?.objects || [];
  const codOf = (x) => (x.situacao && (x.situacao.codigo || x.situacao)) || '';
  let o = numero ? objs.find((x) => String(x.numero) === String(numero)) : null;
  if (!o) o = objs.find((x) => /enviado/i.test(codOf(x)));
  // se nenhum recente está ENVIADO, busca especificamente enviados (tenta filtros)
  if (!o) {
    for (const f of ['situacao__codigo=pedido_enviado', 'situacao=pedido_enviado']) {
      const en = await liGet(`/pedido/?${f}&limit=3`);
      if (en.status === 200 && (en.json?.objects || []).length) { o = en.json.objects[0]; out.filtro_enviado = f; break; }
    }
  }
  if (!o) o = objs[0];
  if (!o) { out.achou = false; out.list_raw = JSON.stringify(lst.json).slice(0, 200); return out; }
  out.numero = o.numero;
  out.campos = Object.keys(o);
  out.obs = o.observacoes ?? o.obs ?? o.observacao ?? o.mensagem ?? o.observacao_interna ?? null;
  // DETALHE do pedido (via resource_uri) — onde ficam envios/rastreio
  if (o.resource_uri) {
    const det = await liGet(o.resource_uri);
    out.detalhe_status = det.status;
    const d = det.json || {};
    out.detalhe_campos = Object.keys(d);
    const envios = d.envios || d.envio || [];
    out.envios = (Array.isArray(envios) ? envios : [envios]).map((e) => ({
      campos: Object.keys(e || {}),
      objeto: e?.objeto ?? e?.codigo_rastreio ?? e?.rastreio ?? null,
      forma: e?.forma_envio_nome ?? e?.forma_envio ?? e?.nome ?? null,
      url_rastreio: e?.url_rastreamento ?? e?.url ?? null,
    }));
    out.rastreio_top = d.codigo_rastreio ?? d.rastreio ?? null;
  }
  // itens embutidos ou via sub-recurso
  let itens = o.itens || o.items || [];
  out.itens_inline = itens.length;
  if ((!itens.length) && o.id) {
    for (const p of [`/pedido_item/?pedido=${o.id}&limit=50`, `/pedido/${o.id}/itens/`, `/pedido/${o.id}/`]) {
      const it = await liGet(p);
      if (it.status === 200 && it.json) { out.item_endpoint = p; itens = it.json.objects || it.json.itens || []; if (itens.length) break; }
    }
  }
  out.itens = (itens || []).slice(0, 6).map((i) => ({
    campos: Object.keys(i), sku: i.sku, nome: i.nome, qtd: i.quantidade,
    obs: i.observacao ?? i.obs ?? null, person: i.personalizacoes ?? i.personalizacao ?? i.customizacoes ?? null,
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
