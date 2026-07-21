// api/chat.js — Assistente IA (Claude) com ferramentas sobre os dados reais do Grupo Aragão.
// Roda um loop agêntico: o Claude decide quais ferramentas chamar (quadros, cards/facções,
// oficina, estoque, vendas), a função executa as consultas no Supabase/storage e devolve os
// resultados, até o Claude montar a resposta final. A chave da Anthropic fica só no servidor.
//
// Env necessárias (Vercel): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (já existem),
// ANTHROPIC_API_KEY (nova). Opcional: ANTHROPIC_MODEL (default claude-opus-4-8).

import { getAnthropicKey } from '../lib/licfg.js';

export const config = { maxDuration: 60 };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const STORAGE = SB_URL + '/storage/v1/object/public/reposicao-data/reposicao/';
const ADMIN_EMAIL = 'marcioborgesaraujojr@gmail.com';

async function sb(path, opts = {}) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  return { status: r.status, j };
}
async function validUser(token) {
  if (!token) return null;
  try { const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } }); const j = await r.json(); return (j && j.id) ? j : null; } catch (e) { return null; }
}
async function acharQuadro(q) {
  const boards = (await sb('boards?select=id,name')).j || [];
  const s = String(q || '').toLowerCase();
  return boards.find(b => b.id === q) || boards.find(b => (b.name || '').toLowerCase() === s) || boards.find(b => (b.name || '').toLowerCase().includes(s)) || null;
}

// ===================== Ferramentas expostas ao Claude =====================
const TOOLS = [
  { name: 'listar_quadros', description: 'Lista os quadros (boards) do sistema, com id e nome. Ex.: Produção, Corte e Tecidos, Personalização, Marketing, Atendimento.', input_schema: { type: 'object', properties: {} } },
  { name: 'detalhar_quadro', description: 'Dado o nome (ou id) de um quadro, retorna as colunas (etapas de produção) e as facções (etiquetas) daquele quadro.', input_schema: { type: 'object', properties: { quadro: { type: 'string', description: 'nome ou id do quadro' } }, required: ['quadro'] } },
  { name: 'buscar_cards', description: 'Busca os cards (ordens de corte) de um quadro. Retorna por card: título, pedido, cliente, facção, coluna/etapa, grade cortada (PP..XG), grade entregue pela oficina (PP..XG), qtd na oficina, peças boas/falhas, data de coleta e prazo (due_date). Filtra por facção e/ou por coluna. Por padrão traz só os NÃO finalizados. Use para saber o que cada facção tem em produção e em que etapa está.', input_schema: { type: 'object', properties: { quadro: { type: 'string' }, faccao: { type: 'string', description: 'nome (ou parte) da facção/etiqueta' }, coluna: { type: 'string', description: 'nome (ou parte) da coluna/etapa' }, incluir_finalizados: { type: 'boolean' } }, required: ['quadro'] } },
  { name: 'consultar_estoque', description: 'Consulta o estoque atual (Bling). Retorna produtos com saldo total, quantas grades/tamanhos estão zerados (furo) e o saldo por tamanho. Filtra por busca (nome/sku) e por tipo (Scrub/Jaleco/Touca...). apenas_furos=true traz só os que têm algum tamanho zerado. Use para saber o que precisa repor.', input_schema: { type: 'object', properties: { busca: { type: 'string' }, tipo: { type: 'string' }, apenas_furos: { type: 'boolean' }, limite: { type: 'number' } } } },
  { name: 'resumo_vendas', description: 'Resumo de vendas por período a partir do painel de vendas (Loja Integrada). Retorna faturamento total e por dia no intervalo. Datas no formato AAAA-MM-DD. Se não passar datas, usa os últimos 30 dias.', input_schema: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' } } } },
];

async function execTool(name, input) {
  input = input || {};
  if (name === 'listar_quadros') {
    const r = await sb('boards?select=id,name&order=created_at');
    return (r.j || []).map(b => ({ id: b.id, nome: b.name }));
  }
  if (name === 'detalhar_quadro') {
    const board = await acharQuadro(input.quadro);
    if (!board) return { erro: 'quadro não encontrado' };
    const [lists, labels] = await Promise.all([
      sb('lists?select=id,name,position&board_id=eq.' + board.id + '&archived=eq.false&order=position'),
      sb('labels?select=id,name,color&board_id=eq.' + board.id + '&order=name'),
    ]);
    return { quadro: board.name, colunas: (lists.j || []).map(l => l.name), faccoes: (labels.j || []).map(l => l.name) };
  }
  if (name === 'buscar_cards') {
    const board = await acharQuadro(input.quadro);
    if (!board) return { erro: 'quadro não encontrado' };
    const lists = (await sb('lists?select=id,name&board_id=eq.' + board.id + '&archived=eq.false&order=position')).j || [];
    const listById = {}; lists.forEach(l => listById[l.id] = l.name);
    let listIds = lists.map(l => l.id);
    if (input.coluna) { const lc = String(input.coluna).toLowerCase(); const match = lists.filter(l => (l.name || '').toLowerCase().includes(lc)); if (match.length) listIds = match.map(l => l.id); }
    if (!listIds.length) return { cards: [] };
    const labels = (await sb('labels?select=id,name&board_id=eq.' + board.id)).j || [];
    const labelById = {}; labels.forEach(l => labelById[l.id] = l.name);
    const cols = 'id,title,pedido_numero,pedido_cliente,list_id,situacao,due_date,qtd_oficina,qtd_pcs_boas,qtd_pcs_falhas,data_coleta_oficina,tam_pp,tam_p,tam_m,tam_g,tam_gg,tam_xg,tam_pp_of,tam_p_of,tam_m_of,tam_g_of,tam_gg_of,tam_xg_of,card_labels(label_id)';
    const cr = await sb('cards?select=' + cols + '&archived=eq.false&list_id=in.(' + listIds.join(',') + ')&limit=3000');
    let cards = cr.j || [];
    const finalRx = /finaliz|conclu|estoque|expedi|entreg/i;
    if (!input.incluir_finalizados) cards = cards.filter(c => !finalRx.test(listById[c.list_id] || ''));
    if (input.faccao) { const fc = String(input.faccao).toLowerCase(); cards = cards.filter(c => (c.card_labels || []).some(cl => (labelById[cl.label_id] || '').toLowerCase().includes(fc))); }
    const grade = (c, suf) => { const g = { PP: c['tam_pp' + suf] || 0, P: c['tam_p' + suf] || 0, M: c['tam_m' + suf] || 0, G: c['tam_g' + suf] || 0, GG: c['tam_gg' + suf] || 0, XG: c['tam_xg' + suf] || 0 }; g.total = g.PP + g.P + g.M + g.G + g.GG + g.XG; return g; };
    return {
      quadro: board.name, total_encontrados: cards.length,
      cards: cards.slice(0, 500).map(c => ({
        titulo: c.title, pedido: c.pedido_numero, cliente: c.pedido_cliente,
        faccao: (c.card_labels || []).map(cl => labelById[cl.label_id]).filter(Boolean).join(', ') || '(sem facção)',
        etapa: listById[c.list_id],
        grade_cortada: grade(c, ''), grade_oficina: grade(c, '_of'),
        qtd_oficina: c.qtd_oficina || 0, boas: c.qtd_pcs_boas || 0, falhas: c.qtd_pcs_falhas || 0,
        data_coleta_oficina: c.data_coleta_oficina || null, prazo: c.due_date || null, situacao: c.situacao || null
      }))
    };
  }
  if (name === 'consultar_estoque') {
    let est = null; try { const r = await fetch(STORAGE + 'estoque.json?t=' + Date.now()); if (r.ok) est = await r.json(); } catch (e) {}
    if (!est || !est.produtos) return { erro: 'estoque indisponível' };
    let prods = est.produtos.slice();
    if (input.tipo) { const tp = String(input.tipo).toLowerCase(); prods = prods.filter(p => (p.nome || '').toLowerCase().includes(tp)); }
    if (input.busca) { const toks = String(input.busca).toLowerCase().split(/\s+/).filter(Boolean); prods = prods.filter(p => { const hay = ((p.nome || '') + ' ' + (p.sku_base || '')).toLowerCase(); return toks.every(t => hay.includes(t)); }); }
    if (input.apenas_furos) prods = prods.filter(p => (p.grades_zeradas || 0) > 0);
    const lim = Math.min(input.limite || 80, 200);
    return {
      atualizado_em: est.atualizado_em || null, total_encontrados: prods.length,
      produtos: prods.slice(0, lim).map(p => ({ nome: p.nome, sku: p.sku_base, saldo_total: p.saldo_total, grades_zeradas: p.grades_zeradas, tamanhos: (p.tamanhos || []).map(t => ({ tam: t.tamanho, saldo: t.saldo })) }))
    };
  }
  if (name === 'resumo_vendas') {
    let vd = null; try { const r = await fetch(STORAGE + 'vendas.json?t=' + Date.now()); if (r.ok) vd = await r.json(); } catch (e) {}
    const dias = (vd && (vd.dias || vd)) || {};
    const chaves = Object.keys(dias).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    let de = input.de, ate = input.ate;
    if (!de && !ate && chaves.length) { ate = chaves[chaves.length - 1]; const d = new Date(ate + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 29); de = d.toISOString().slice(0, 10); }
    const dentro = chaves.filter(k => (!de || k >= de) && (!ate || k <= ate));
    let total = 0, pedidos = 0; const porDia = {};
    dentro.forEach(k => { const d = dias[k] || {}; const fat = Number(d.faturamento || d.valor || d.total || 0); const ped = Number(d.pedidos || d.qtd || 0); total += fat; pedidos += ped; porDia[k] = { faturamento: fat, pedidos: ped }; });
    return { periodo: { de: de || dentro[0], ate: ate || dentro[dentro.length - 1] }, faturamento_total: Math.round(total * 100) / 100, pedidos_total: pedidos, dias: porDia };
  }
  return { erro: 'ferramenta desconhecida: ' + name };
}

const SYSTEM = `Você é o assistente de produção e gestão do Grupo Aragão (marca Dra. Charm), uma confecção de jalecos, scrubs e toucas com bordado personalizado.
Você responde ao gestor usando os DADOS REAIS dos sistemas, através das ferramentas. Sempre que a pergunta envolver produção, facções, oficina, estoque, pedidos ou vendas, USE as ferramentas para buscar os números reais antes de responder — NUNCA invente dados.

Contexto do fluxo:
- Cada card é uma ordem de corte (OC). As "facções" são as costureiras/equipes que produzem (são as etiquetas do quadro de Produção).
- "grade cortada" = o que saiu do corte (PP..XG). "grade oficina" = o que a facção já entregou. As colunas do quadro são as etapas (ex.: Costurando, Acabamento, Finalizado).
- O estoque é o saldo de produtos acabados no Bling; "furo"/"grades zeradas" indica tamanhos que precisam repor.

Ao recomendar uma sequência/ordem de produção por facção, considere e explique: prazos (due_date) mais próximos primeiro; furos de estoque (produtos zerados que precisam de reposição urgente); o que já está mais adiantado nas etapas; e o volume/carga de cada facção. Seja prático e priorize itens acionáveis (o que começar primeiro e por quê).

Responda em português do Brasil, claro e direto. Use listas ou tabelas quando ajudar a leitura. Se algum dado necessário não estiver disponível nas ferramentas, diga isso honestamente em vez de inventar.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'método não permitido' });
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = await validUser(token);
  if (!user) return res.status(401).json({ error: 'precisa estar logado' });
  const email = (user.email || '').toLowerCase();
  if (email !== ADMIN_EMAIL) {
    const pf = (await sb('profiles?select=access&id=eq.' + user.id)).j;
    const acc = (pf && pf[0] && pf[0].access) || {};
    if (acc.assistente !== true) return res.status(403).json({ error: 'sem acesso ao assistente' });
  }
  const ANTHROPIC_KEY = await getAnthropicKey();
  if (!ANTHROPIC_KEY) return res.status(200).json({ reply: '⚠️ O assistente ainda não está ativado. Cole sua chave da Anthropic em Configurações da Suíte → Conexões & Integrações → Claude / Anthropic → "Colar chave" (ou configure ANTHROPIC_API_KEY na Vercel).' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  let messages = incoming.filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({ role: m.role, content: m.content }));
  if (!messages.length) return res.status(200).json({ reply: 'Manda sua pergunta que eu busco nos dados.' });

  const callClaude = async (msgs) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, tools: TOOLS, messages: msgs })
    });
    return { status: r.status, j: await r.json() };
  };

  try {
    let guard = 0;
    const ferramentasUsadas = [];
    while (guard++ < 7) {
      const resp = await callClaude(messages);
      if (resp.status >= 400) return res.status(200).json({ reply: 'Erro na API da Anthropic: ' + JSON.stringify(resp.j && (resp.j.error || resp.j)).slice(0, 400) });
      const msg = resp.j;
      messages.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason === 'tool_use') {
        const results = [];
        for (const block of (msg.content || [])) {
          if (block.type === 'tool_use') {
            ferramentasUsadas.push(block.name);
            let out; try { out = await execTool(block.name, block.input); } catch (e) { out = { erro: String(e.message || e) }; }
            results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out).slice(0, 80000) });
          }
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return res.status(200).json({ reply: text || '(sem resposta)', ferramentas: [...new Set(ferramentasUsadas)] });
    }
    return res.status(200).json({ reply: 'Não consegui concluir — a pergunta exigiu muitas buscas seguidas. Tenta reformular de forma mais específica.' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
