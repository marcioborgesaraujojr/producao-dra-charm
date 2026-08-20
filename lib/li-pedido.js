// lib/li-pedido.js — busca UM pedido na Loja Integrada pelo número.
//
// Por que existe: o robô não tinha como responder "já bordou?", "já saiu?", "cadê meu
// pedido?" — e improvisava. A cliente Kauany perguntou "já personalizou?" e ele
// respondeu "Nunca personalizei", porque leu como pergunta pessoal.
//
// A tabela cmp_orders (do app de rastreio) seria a fonte ideal, mas está vazia — aquele
// app ainda está em construção. Então a gente vai direto na Loja Integrada, que é a
// fonte da verdade de qualquer jeito.
//
// Só LEITURA. Nunca escreve nada na loja.

import { getLIKeys } from './licfg.js';

const LI = 'https://api.awsli.com.br';

async function liGet(caminho, params) {
  const k = await getLIKeys();
  const u = new URL(caminho.startsWith('http') ? caminho : LI + caminho);
  Object.entries(params || {}).forEach(([c, v]) => { if (v != null && v !== '') u.searchParams.set(c, v); });
  u.searchParams.set('chave_api', k.api || '');
  u.searchParams.set('chave_aplicacao', k.app || '');
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);          // o robô não pode ficar pendurado
  try {
    const r = await fetch(u.toString(), { headers: { Accept: 'application/json' }, signal: c.signal });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, j };
  } catch (e) {
    return { status: 0, j: null, erro: e.name === 'AbortError' ? 'tempo esgotado' : e.message };
  } finally { clearTimeout(t); }
}

// A LI não documenta um jeito só de procurar por número, e o formato mudou entre versões.
// Em vez de chutar um, a gente tenta os caminhos conhecidos na ordem e para no primeiro
// que devolver pedido. Assim, se um deixar de funcionar, os outros seguram.
const CAMINHOS = [
  { via: 'search',  path: '/v1/pedido/search', chave: 'numero' },
  { via: 'lista',   path: '/v1/pedido',        chave: 'numero' },
  { via: 'direto',  path: '/v1/pedido/:n' }
];

function primeiroPedido(j) {
  if (!j) return null;
  if (Array.isArray(j.objects) && j.objects.length) return j.objects[0];   // formato tastypie da LI
  if (Array.isArray(j.results) && j.results.length) return j.results[0];
  if (Array.isArray(j) && j.length) return j[0];
  if (j.numero || j.id) return j;
  return null;
}

/* Resume o pedido no MÍNIMO que serve pra responder a cliente.
   De propósito não devolve endereço, CPF, telefone nem valor item a item: isso ia parar
   dentro do prompt do modelo, e não tem por que mandar dado pessoal pra lá pra responder
   "já saiu?". */
function resumir(p) {
  if (!p) return null;
  const sit = p.situacao || {};
  const envios = Array.isArray(p.envios) ? p.envios : [];
  const env = envios[0] || {};
  const itens = (Array.isArray(p.itens) ? p.itens : []).slice(0, 12).map(i => ({
    nome: i.nome || (i.produto && i.produto.nome) || '',
    sku: i.sku || '',
    qtd: i.quantidade || 1,
    // personalização/bordado costuma vir como "personalizacao" ou nas observações do item
    personalizacao: i.personalizacao || i.observacao || null
  }));
  return {
    numero: String(p.numero || p.id || ''),
    situacao: sit.nome || p.situacao_nome || null,
    situacao_codigo: sit.codigo || null,
    feito_em: p.data_criacao || p.criado_em || null,
    pago_em: p.data_pagamento || null,
    enviado_em: p.data_envio || env.data_envio || null,
    transportadora: env.forma_envio_nome || env.nome || null,
    codigo_rastreio: env.objeto || null,
    prazo_envio: env.prazo != null ? env.prazo : null,
    tem_personalizacao: itens.some(i => i.personalizacao),
    itens
  };
}

/**
 * Busca o pedido pelo número. Devolve { ok, pedido, via } ou { ok:false, motivo }.
 * NUNCA lança: quem chama é o robô, e falha de consulta não pode derrubar a resposta.
 */
export async function buscarPedidoLI(numero) {
  const n = String(numero || '').replace(/\D/g, '');
  if (!n) return { ok: false, motivo: 'sem numero' };

  let ultimoStatus = 0, ultimoErro = null;
  for (const c of CAMINHOS) {
    const path = c.path.includes(':n') ? c.path.replace(':n', n) : c.path;
    const params = c.chave ? { [c.chave]: n, limit: 1 } : {};
    const { status, j, erro } = await liGet(path, params);
    ultimoStatus = status; if (erro) ultimoErro = erro;
    if (status === 200) {
      const p = primeiroPedido(j);
      if (p) {
        const r = resumir(p);
        // confere que veio o pedido PEDIDO, e não o primeiro da lista da loja
        if (!r.numero || r.numero.replace(/\D/g, '') === n) return { ok: true, pedido: r, via: c.via };
      }
    }
    if (status === 401 || status === 403) return { ok: false, motivo: 'chaves da Loja Integrada recusadas' };
  }
  return { ok: false, motivo: ultimoErro || ('nao encontrado (ultimo status ' + ultimoStatus + ')') };
}

/* Vira texto pro prompt. Curto de propósito: cada linha aqui é token em toda resposta. */
export function pedidoEmTexto(p) {
  if (!p) return '';
  const l = [];
  l.push('numero: ' + p.numero);
  if (p.situacao)          l.push('situacao: ' + p.situacao);
  if (p.feito_em)          l.push('feito em: ' + String(p.feito_em).slice(0, 10));
  if (p.pago_em)           l.push('pago em: ' + String(p.pago_em).slice(0, 10));
  if (p.enviado_em)        l.push('enviado em: ' + String(p.enviado_em).slice(0, 10));
  if (p.transportadora)    l.push('envio: ' + p.transportadora);
  if (p.codigo_rastreio)   l.push('codigo de rastreio: ' + p.codigo_rastreio);
  l.push('tem personalizacao/bordado: ' + (p.tem_personalizacao ? 'sim' : 'nao'));
  if (p.itens && p.itens.length)
    l.push('itens: ' + p.itens.map(i => i.qtd + 'x ' + i.nome + (i.personalizacao ? (' (' + i.personalizacao + ')') : '')).join('; '));
  return l.join('\n');
}
