// Teste READ-ONLY da conexão com a Loja Integrada.
// Valida as chaves e revela os códigos de situação reais da conta.
// Protegido por CMP_CRON_SECRET. Não escreve nada.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const secret = process.env.CMP_CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: 'não autorizado' });

  const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
  const auth = `chave_api ${process.env.LI_CHAVE_API} chave_aplicacao ${process.env.LI_CHAVE_APLICACAO}`;

  async function li(path) {
    const r = await fetch(base + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, raw: json ? null : text.slice(0, 400) };
  }

  const out = { base, temChaveApi: !!process.env.LI_CHAVE_API, temChaveApp: !!process.env.LI_CHAVE_APLICACAO };

  // 1) pedidos (também revela situações reais e a estrutura)
  try {
    const p = await li('/pedido?limit=20');
    out.pedido_status = p.status;
    const objs = p.json?.objects || p.json?.results || (Array.isArray(p.json) ? p.json : []);
    out.total_meta = p.json?.meta?.total_count ?? null;
    out.amostra_qtd = objs.length;
    out.situacoes_encontradas = [...new Map(objs.map((o) => {
      const s = o.situacao || {};
      return [s.codigo ?? o.situacao_id, { codigo: s.codigo ?? o.situacao_id, nome: s.nome || s.label }];
    })).values()];
    if (objs[0]) {
      const o = objs[0];
      out.campos_pedido = Object.keys(o);
      const envio = (o.envios && o.envios[0]) || {};
      out.exemplo = {
        numero: o.numero, situacao: o.situacao,
        forma_envio: envio.forma_envio_nome || o.forma_envio_nome,
        objeto_rastreio: envio.objeto || o.codigo_rastreio || null,
        itens_qtd: (o.itens || o.items || []).length,
        sku_exemplo: (o.itens || o.items || [])[0]?.sku || null,
        tem_cliente: !!o.cliente, tem_endereco: !!o.endereco_entrega,
      };
    } else {
      out.pedido_raw = p.raw;
    }
  } catch (e) { out.pedido_erro = e.message; }

  // 2) tenta listar as situações oficiais (endpoint pode variar)
  for (const path of ['/situacao', '/pedido/situacao', '/situacao_pedido']) {
    try {
      const s = await li(path);
      if (s.status === 200 && s.json) {
        out.situacao_endpoint = path;
        const list = s.json.objects || s.json.results || s.json;
        out.situacoes_oficiais = (Array.isArray(list) ? list : []).map((x) => ({ codigo: x.codigo ?? x.id, nome: x.nome || x.label }));
        break;
      }
    } catch {}
  }

  return res.status(200).json(out);
}
