// Status internos (idênticos ao painel do cademeupedido) + mapa p/ Loja Integrada.
export const STATUSES = {
  criado:              { label: 'Criado',                 color: '#9e9e9e' },
  pago:                { label: 'Pago',                   color: '#3f51b5' },
  em_separacao:        { label: 'Em Separação',           color: '#7e57c2' },
  faturado:            { label: 'Faturado',               color: '#00897b' },
  enviado:             { label: 'Enviado',                color: '#1e88e5' },
  aguardando_retirada: { label: 'Aguardando Retirada',    color: '#f9a825' },
  atrasado:            { label: 'Atrasado',               color: '#e53935' },
  entregue:            { label: 'Entregue',               color: '#43a047' },
  devolvido:           { label: 'Devolvido ao Remetente', color: '#8d6e63' },
  cancelado:           { label: 'Cancelado',              color: '#616161' },
};
export const STATUS_ORDER = Object.keys(STATUSES);
export const FINAL_STATUSES = new Set(['entregue', 'cancelado', 'devolvido']);

// Ajuste estes códigos com os da SUA conta (GET /pedido/situacao na API da LI).
export const LI_STATUS_MAP = {
  criado: 4, pago: 5, em_separacao: 6, faturado: 7, enviado: 8,
  entregue: 9, cancelado: 10, atrasado: 8, aguardando_retirada: 8, devolvido: 10,
};
export const LI_TO_INTERNAL = { 4: 'criado', 5: 'pago', 6: 'em_separacao', 7: 'faturado', 8: 'enviado', 9: 'entregue', 10: 'cancelado' };

// Mapa de status do cademeupedido -> interno (para MIGRAÇÃO dos 13,5k pedidos).
// Confirmado ao vivo na API deles.
export const CMP_STATUS_TO_INTERNAL = {
  1: 'criado', 2: 'pago', 3: 'em_separacao', 4: 'faturado', 5: 'enviado',
  6: 'atrasado', 7: 'entregue', 8: 'cancelado', 9: 'cancelado', 10: 'aguardando_retirada', 11: 'devolvido',
};

// Nome da transportadora (Bling/cademeupedido/LI) -> chave interna.
// Fonte de eventos por chave:
//   correios -> CWS | jt -> URL pública | melhorenvio -> API ME
//   total -> Total Express | local -> confirmação do motoboy (sem rastreio externo)
//   sem -> sem transportadora (nada a rastrear)
export function carrierKey(nome = '') {
  const n = nome.toLowerCase();
  if (/j&?t/.test(n)) return 'jt';
  if (/correios|pac|sedex/.test(n)) return 'correios';
  if (/melhor.?envio/.test(n)) return 'melhorenvio';
  if (/total\s*express/.test(n)) return 'total';
  if (/sem\s*transportadora/.test(n)) return 'sem';
  // Entrega Pessoalmente / Retirar na loja / balcão -> retirada (as meninas confirmam)
  if (/retir|pessoal|na loja|balc[aã]o/.test(n)) return 'retirada';
  // Motoboy / Personalizada / entrega própria -> motoboy (o entregador confirma)
  if (/motoboy|personaliz|entrega própria|entrega propria|própria|propria|local/.test(n)) return 'motoboy';
  return 'correios';
}

// Chaves de transportadora com confirmação manual (motoboy/retirada), sem rastreio externo.
export const LOCAL_CARRIERS = new Set(['motoboy', 'retirada', 'local']);
