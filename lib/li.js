// Adaptador Loja Integrada (API v1) — servidor a servidor.
import { LI_STATUS_MAP, LI_TO_INTERNAL, carrierKey } from './statusmap.js';
import { getLIKeys } from './licfg.js';

const BASE = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
const MODE = (process.env.LI_MODE || 'mock').toLowerCase();          // mock | live
const SYNC = (process.env.LI_SYNC_STATUS || 'true') !== 'false';

// A API v1 da Loja Integrada (Tastypie) autentica por QUERY PARAMS
// (?chave_api=..&chave_aplicacao=..) e exige barra final nos recursos.
async function liFetch(path, opts = {}) {
  const u = new URL(path.startsWith('http') ? path : `${BASE}${path}`);
  const _k = await getLIKeys();
  u.searchParams.set('chave_api', _k.api || '');
  u.searchParams.set('chave_aplicacao', _k.app || '');
  const res = await fetch(u.toString(), {
    ...opts,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`LI ${res.status} ${path}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.status === 204 ? null : res.json();
}

function guessCarrier(nome = '') { return carrierKey(nome); }
function normalize(p) {
  const cli = p.cliente || {};
  const end = p.endereco_entrega || {};
  const envio = (p.envios && p.envios[0]) || {};
  const itens = p.itens || [];
  return {
    li_id: String(p.numero || p.id),
    numero: String(p.numero || p.id),
    nota_fiscal: p.nota_fiscal || '',
    cliente_nome: cli.nome || '',
    cliente_email: (cli.email || '').toLowerCase(),
    cliente_cpf: (cli.cpf || cli.cnpj || '').replace(/\D/g, ''),
    destino: [end.cidade, end.estado].filter(Boolean).join('/'),
    uf: end.estado || '',
    preco: Number(p.valor_total || 0),
    transportadora: guessCarrier(envio.forma_envio_nome || ''),
    servico: envio.forma_envio_nome || '',
    tracking_code: envio.objeto || '',
    skus: itens.map((i) => i.sku || i.produto?.sku || '').filter(Boolean),
    status: LI_TO_INTERNAL[p.situacao?.codigo ?? p.situacao_id] || 'criado',
    criado_em: p.data_criacao || new Date().toISOString(),
    raw: p,
  };
}

export async function fetchOrders({ limit = 50 } = {}) {
  if (MODE !== 'live') return mockOrders();
  const data = await liFetch(`/pedido/?limit=${limit}`);
  return (data.objects || data.results || data || []).map(normalize);
}

export async function updateOrderStatus(liId, internalStatus) {
  const situacao = LI_STATUS_MAP[internalStatus];
  if (!situacao) return { skipped: true };
  if (MODE !== 'live' || !SYNC) return { mock: true, situacao };
  await liFetch(`/pedido/${liId}/situacao`, { method: 'PUT', body: JSON.stringify({ codigo: situacao }) });
  return { ok: true, situacao };
}

export async function updateTrackingCode(liId, code, url = '') {
  if (MODE !== 'live') return { mock: true };
  await liFetch(`/pedido/${liId}/rastreamento`, { method: 'PUT', body: JSON.stringify({ codigo: code, url }) });
  return { ok: true };
}

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
export function mockOrders() {
  return [
    { li_id: '100234', numero: '100234', nota_fiscal: '000.123', cliente_nome: 'Ana Souza', cliente_email: 'ana.souza@email.com', cliente_cpf: '12345678900', destino: 'São Paulo/SP', uf: 'SP', preco: 189.9, transportadora: 'correios', servico: 'PAC', tracking_code: 'AA123456785BR', skus: ['ANEL-OURO-01'], status: 'enviado', criado_em: daysAgo(12), raw: {} },
    { li_id: '100235', numero: '100235', nota_fiscal: '000.124', cliente_nome: 'Bruno Lima', cliente_email: 'bruno.lima@email.com', cliente_cpf: '98765432100', destino: 'Rio de Janeiro/RJ', uf: 'RJ', preco: 349.0, transportadora: 'correios', servico: 'SEDEX', tracking_code: 'BB987654321BR', skus: ['COLAR-BORD-05'], status: 'enviado', criado_em: daysAgo(20), raw: {} },
    { li_id: '100236', numero: '100236', nota_fiscal: '000.125', cliente_nome: 'Carla Dias', cliente_email: 'carla.dias@email.com', cliente_cpf: '11122233344', destino: 'Guarulhos/SP', uf: 'SP', preco: 79.9, transportadora: 'local', servico: 'Personalizada', tracking_code: '', skus: ['PULSEIRA-03'], status: 'enviado', criado_em: daysAgo(4), raw: {} },
    { li_id: '100237', numero: '100237', nota_fiscal: '000.126', cliente_nome: 'Diego Alves', cliente_email: 'diego.alves@email.com', cliente_cpf: '55566677788', destino: 'Belo Horizonte/MG', uf: 'MG', preco: 259.5, transportadora: 'melhorenvio', servico: 'Melhor Envio - Jadlog', tracking_code: 'ME77788899900', skus: ['ANEL-PERS-09'], status: 'enviado', criado_em: daysAgo(2), raw: {} },
    { li_id: '100238', numero: '100238', nota_fiscal: '000.127', cliente_nome: 'Elaine Rocha', cliente_email: 'elaine.rocha@email.com', cliente_cpf: '99988877766', destino: 'Curitiba/PR', uf: 'PR', preco: 129.0, transportadora: 'correios', servico: 'PAC', tracking_code: 'CC111222333BR', skus: ['GARGANTILHA-07'], status: 'pago', criado_em: daysAgo(1), raw: {} },
  ];
}

export default { fetchOrders, updateOrderStatus, updateTrackingCode, mockOrders };
