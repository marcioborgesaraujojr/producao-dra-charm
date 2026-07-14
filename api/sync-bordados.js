// /api/sync-bordados.js
// Vercel Serverless Function — sincroniza pedidos com bordado da Loja Integrada
// Env vars necessárias (Vercel dashboard):
//   LI_API_KEY           — Chave de API da loja (20 chars)
//   LI_APPLICATION_KEY   — Chave de Aplicação (recebida por email da LI)
//   SUPABASE_URL         — https://wwytzoyeibekhstinott.supabase.co
//   SUPABASE_SERVICE_KEY — Service role key (NÃO a anon)
//   SYNC_SECRET          — Token opcional pra proteger o endpoint (query ?token=)

import { createClient } from '@supabase/supabase-js';

const LI_API_BASE = 'https://api.awsli.com.br/api/v1';
const SKU_LOGOMARCA = 'U4UDXDTVP';
const SKU_PERSONALIZACAO = 'QGH2F6NFR';

function auth(){
  return `chave_api ${process.env.LI_API_KEY} chave_aplicacao ${process.env.LI_APPLICATION_KEY}`;
}

async function liFetch(path, params = {}){
  const url = new URL(LI_API_BASE + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { Authorization: auth(), Accept: 'application/json' }
  });
  if (!r.ok){
    const txt = await r.text();
    throw new Error(`LI ${r.status}: ${txt.slice(0,200)}`);
  }
  return r.json();
}

async function listOrders(dateStart, dateEnd){
  // A LI aceita filtros ISO. data_criacao_gte / data_criacao_lte
  const all = [];
  let offset = 0;
  const limit = 50;
  while (true){
    const j = await liFetch('/pedido/', {
      limit, offset,
      data_inicio: dateStart,
      data_fim: dateEnd,
    });
    const orders = j.objects || j.results || j.pedidos || [];
    all.push(...orders);
    if (!orders.length || orders.length < limit) break;
    offset += limit;
    if (offset > 500) break; // safety
  }
  return all;
}

async function getOrderDetail(id){
  return liFetch(`/pedido/${id}/`);
}

// Mapa cor site → hex (mesmo do parser da extensão)
const COR_HEX = {
  'marinho':'#0a1e3a','prata':'#c0c0c0','dourado':'#b8860b','bege':'#c8b088',
  'branco':'#ffffff','chumbo':'#4a4a4a','preto':'#000000','pink':'#ff3c6f','rosa claro':'#f5a9c0'
};

function parseOrderForBordado(o){
  const items = o.itens || [];
  const skus = items.map(i => i.sku || i.produto_sku || '').map(s => (s||'').toString());
  const hasLogo = skus.some(s => s.toUpperCase() === SKU_LOGOMARCA);
  const hasPerso = skus.some(s => s.toUpperCase() === SKU_PERSONALIZACAO);
  if (!hasLogo && !hasPerso) return null;

  let tipo = null;
  if (hasLogo && hasPerso) tipo = 'ambos';
  else if (hasLogo) tipo = 'logomarca';
  else tipo = 'nome_profissao';

  // Filtro de status inválido
  const situ = ((o.situacao && (o.situacao.nome || o.situacao)) || '').toString().toLowerCase();
  if (/cancelad|devolvid|chargeback|disputa|análise|analise|aguardando pgto|solicitad/.test(situ)) return null;

  // Cliente
  const clienteObj = o.cliente || o.dados_cliente || {};
  const cliente = clienteObj.nome || clienteObj.razao_social || o.nome_cliente || '';

  // Personalização: tenta ler das opcoes/variacao/campos_customizados dos itens
  // O formato exato varia — abaixo tenta múltiplas chaves comuns
  let linha1 = null, linha2 = null, corNome = null, corHex = null, fonte = null, lado = null, imagemUrl = null, detalhes = null;
  const persoItems = items.filter(i => {
    const sku = ((i.sku||'')+'').toUpperCase();
    return sku === SKU_LOGOMARCA || sku === SKU_PERSONALIZACAO;
  });
  for (const it of persoItems){
    const opts = it.opcoes || it.personalizacao || it.customizacoes || it.campos_customizados || it.variacoes || [];
    const optArr = Array.isArray(opts) ? opts : (opts && typeof opts === 'object' ? Object.entries(opts).map(([k,v]) => ({nome:k, valor:v})) : []);
    for (const opt of optArr){
      const nome = ((opt.nome || opt.chave || opt.pergunta || '')+'').toLowerCase();
      const val = ((opt.valor || opt.resposta || opt.texto || opt.value || '')+'').trim();
      if (!val) continue;
      if (/linha\s*1|nome/.test(nome) && !linha1) linha1 = val;
      else if (/linha\s*2|profiss/.test(nome) && !linha2) linha2 = val;
      else if (/cores?|cor\b/.test(nome) && !corNome){
        const m = val.match(/^(#[0-9a-fA-F]{3,8})-(.+)$/);
        if (m){ corHex = m[1]; corNome = m[2].trim(); }
        else { corNome = val; corHex = COR_HEX[val.toLowerCase()] || null; }
      }
      else if (/letra|fonte/.test(nome) && !fonte) fonte = val;
      else if (/lado|local/.test(nome) && !lado) lado = val;
      else if (/upload|imagem|arquivo/.test(nome) && !imagemUrl) imagemUrl = val;
      else if (/detalhe|observa/.test(nome) && !detalhes) detalhes = val;
    }
  }

  // Produtos do pedido (exclui SKUs de bordado + embalagem)
  const skusSkip = new Set([SKU_LOGOMARCA, SKU_PERSONALIZACAO, 'embalagem-de-presente_hidden']);
  const produtos = items
    .filter(i => !skusSkip.has(((i.sku||'')+'').toUpperCase()))
    .filter(i => !/Acréscimo|Embalagem/i.test(i.nome || i.produto_nome || ''))
    .map(i => ({
      nome: i.nome || i.produto_nome || '',
      sku: (i.sku||'')+'',
      tamanho: (i.variacao_nome || i.variacao || '').toString(),
      qtd: parseInt(i.quantidade || i.qtd || 1),
      imagem_url: i.imagem || i.imagem_url || null,
      // marca bordado nas peças que estão citadas na personalização
      bordado: false, // se a API entregar SKUs bordados, ajusta aqui
    }));

  return {
    pedido_numero: (o.numero || o.id || o.pedido_id || '').toString(),
    pedido_cliente: cliente,
    pedido_url: `https://app.lojaintegrada.com.br/painel/pedido/${o.numero || o.id}/detalhar`,
    bordado_tipo: tipo,
    bordado_linha1: linha1,
    bordado_linha2: linha2,
    bordado_cor_hex: corHex,
    bordado_cor_nome: corNome,
    bordado_fonte: fonte,
    bordado_lado: lado,
    bordado_imagem_url: imagemUrl,
    bordado_detalhes: detalhes,
    pedido_produtos: produtos.length ? produtos : null,
  };
}

function calcPrazoBordado(tipo){
  // 5 dias úteis pra nome/profissão, 10 pra logomarca/ambos
  const dias = (tipo === 'logomarca' || tipo === 'ambos') ? 10 : 5;
  const d = new Date();
  let count = 0;
  while (count < dias){
    d.setDate(d.getDate()+1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return d.toISOString().slice(0,10);
}

export default async function handler(req, res){
  // Proteção opcional
  const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (process.env.SYNC_SECRET && token !== process.env.SYNC_SECRET){
    return res.status(401).json({ok: false, error: 'unauthorized'});
  }

  const dateStart = req.query.data_inicio || new Date(Date.now() - 24*60*60*1000).toISOString().slice(0,10);
  const dateEnd = req.query.data_fim || new Date().toISOString().slice(0,10);

  const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // 1) Lista pedidos do período
    const orders = await listOrders(dateStart, dateEnd);

    // 2) Filtra os que têm bordado (checa SKUs de items)
    const withBordado = orders.filter(o => {
      const skus = (o.itens || []).map(i => (i.sku||'').toString().toUpperCase());
      return skus.includes(SKU_LOGOMARCA) || skus.includes(SKU_PERSONALIZACAO);
    });

    // 3) Se o list já não trouxer todos os detalhes, busca detalhe individual
    const parsed = [];
    for (let i = 0; i < withBordado.length; i += 5){
      const batch = withBordado.slice(i, i+5);
      const results = await Promise.all(batch.map(async o => {
        try {
          // Se o list já trouxe opcoes nos items, evita a chamada extra
          const hasOpts = (o.itens || []).some(it => it.opcoes || it.personalizacao || it.campos_customizados);
          const full = hasOpts ? o : await getOrderDetail(o.id || o.numero);
          return parseOrderForBordado(full);
        } catch(e){ return null; }
      }));
      parsed.push(...results.filter(Boolean));
    }

    // 4) Encontra o board Personalização + lista "Novo Pedido" + labels
    const [{data: boards}, {data: allLists}, {data: allLabels}] = await Promise.all([
      supa.from('boards').select('id, name'),
      supa.from('lists').select('id, name, board_id'),
      supa.from('labels').select('id, name, board_id'),
    ]);
    const persoBoard = boards.find(b => (b.name||'').toLowerCase().includes('personaliza'));
    if (!persoBoard) throw new Error('Board Personalização não encontrado');
    const persoLists = allLists.filter(l => l.board_id === persoBoard.id);
    const novoList = persoLists.find(l => /novo/i.test(l.name)) || persoLists[0];
    const persoLabels = allLabels.filter(l => l.board_id === persoBoard.id);
    const labelByType = {
      logomarca: persoLabels.find(l => /logo/i.test(l.name))?.id,
      nome_profissao: persoLabels.find(l => /nome/i.test(l.name))?.id,
      ambos: persoLabels.find(l => /ambos/i.test(l.name))?.id,
    };

    // 5) Batch: 1 SELECT existentes + updates paralelos + insert em massa
    const nums = parsed.map(p => p.pedido_numero);
    const {data: existingCards} = await supa.from('cards').select('id, pedido_numero').in('pedido_numero', nums);
    const existingByNum = {};
    for (const c of (existingCards||[])) existingByNum[c.pedido_numero] = c.id;

    const toUpdate = [], toInsert = [];
    for (const p of parsed){
      const payload = {
        pedido_cliente: p.pedido_cliente,
        pedido_url: p.pedido_url,
        bordado_tipo: p.bordado_tipo,
        bordado_linha1: p.bordado_linha1,
        bordado_linha2: p.bordado_linha2,
        bordado_cor_hex: p.bordado_cor_hex,
        bordado_cor_nome: p.bordado_cor_nome,
        bordado_fonte: p.bordado_fonte,
        bordado_lado: p.bordado_lado,
        bordado_imagem_url: p.bordado_imagem_url,
        bordado_detalhes: p.bordado_detalhes,
        pedido_produtos: p.pedido_produtos,
      };
      if (existingByNum[p.pedido_numero]){
        toUpdate.push({id: existingByNum[p.pedido_numero], ...payload});
      } else {
        toInsert.push({
          list_id: novoList.id,
          title: `#${p.pedido_numero} · ${p.pedido_cliente || 'Sem nome'}`,
          position: Date.now() + toInsert.length,
          due_date: calcPrazoBordado(p.bordado_tipo),
          pedido_numero: p.pedido_numero,
          _tipo: p.bordado_tipo,
          ...payload,
        });
      }
    }

    let created = 0, updated = 0;
    if (toUpdate.length){
      for (let i=0; i<toUpdate.length; i+=20){
        const batch = toUpdate.slice(i, i+20);
        const results = await Promise.all(batch.map(u => {
          const {id, ...rest} = u;
          return supa.from('cards').update(rest).eq('id', id);
        }));
        updated += results.filter(r => !r.error).length;
      }
    }
    if (toInsert.length){
      const inserts = toInsert.map(({_tipo, ...c}) => c);
      const {data: newCards, error: insErr} = await supa.from('cards').insert(inserts).select();
      if (!insErr && newCards){
        created = newCards.length;
        const labelInserts = [];
        for (let i=0; i<newCards.length; i++){
          const labelId = labelByType[toInsert[i]._tipo];
          if (labelId) labelInserts.push({card_id: newCards[i].id, label_id: labelId});
        }
        if (labelInserts.length) await supa.from('card_labels').insert(labelInserts);
      }
    }

    return res.status(200).json({
      ok: true,
      period: {start: dateStart, end: dateEnd},
      totals: {liOrders: orders.length, withBordado: parsed.length, created, updated},
    });
  } catch(e){
    return res.status(500).json({ok: false, error: e.message});
  }
}
