// Sistema de Ocorrências — réplica do cademeupedido.
// O sistema abre uma ocorrência automaticamente conforme os eventos de
// rastreio / status, notifica o cliente por e-mail e guarda comentários.
import * as sb from './supabase.js';
import { sendEmail, ocorrenciaHtml, isConfigured } from './email.js';
export { isConfigured };   // re-exporta para uso via `import * as oc`

// Tipos (mesma lista do cademeupedido).
export const TIPOS = [
  'Acareação da entrega', 'Destinatário ausente', 'Destinatário desconhecido',
  'Destinatário mudou-se', 'Endereço não localizado', 'Entrega atrasada',
  'Expedição atrasada', 'Faturamento atrasado', 'Extravio',
  'Pedido recusado na entrega', 'Devolução', 'Aguardando Retirada',
  'Objeto retido na fiscalização', 'CEP não atendido', 'Problemas diversos',
];

// Tipos que devem notificar o cliente por e-mail quando abertos automaticamente.
const NOTIFICA_CLIENTE = new Set([
  'Destinatário ausente', 'Destinatário desconhecido', 'Destinatário mudou-se',
  'Endereço não localizado', 'Entrega atrasada', 'Pedido recusado na entrega',
  'Devolução', 'Aguardando Retirada', 'CEP não atendido', 'Extravio',
]);

// Descrição de evento de rastreio -> tipo de ocorrência (ou null se nada a abrir).
export function tipoFromEvento(desc = '') {
  const d = String(desc).toLowerCase();
  if (/ausente/.test(d)) return 'Destinatário ausente';
  if (/desconhecid/.test(d)) return 'Destinatário desconhecido';
  if (/mudou[- ]?se|mudou/.test(d)) return 'Destinatário mudou-se';
  if (/endere[çc]o.*(insuficiente|incorret|n[ãa]o\s*localiz|errad|incompl)|n[ãa]o\s*localizad/.test(d)) return 'Endereço não localizado';
  if (/recusad/.test(d)) return 'Pedido recusado na entrega';
  if (/cep\b.*(n[ãa]o|fora|inv[áa]lid)|n[ãa]o\s*atendid/.test(d)) return 'CEP não atendido';
  if (/aguardando retirada|dispon[ií]vel para retirada|retirar na (ag[êe]ncia|unidade)/.test(d)) return 'Aguardando Retirada';
  if (/extravi/.test(d)) return 'Extravio';
  if (/fiscaliza|retid|al[fâ]ndeg|tributa/.test(d)) return 'Objeto retido na fiscalização';
  if (/devolv|retornad|remetente/.test(d)) return 'Devolução';
  if (/roubo|avaria|sinistr|danificad/.test(d)) return 'Problemas diversos';
  return null;
}

// Lista ocorrências de um pedido (mais recente primeiro).
export async function listByOrder(orderId) {
  return sb.select('cmp_ocorrencias', { where: `order_id=eq.${orderId}`, order: 'criada_em.desc' });
}

// Existe alguma ocorrência aberta (não fechada) desse tipo?
async function abertaDoTipo(orderId, tipo) {
  const rows = await sb.select('cmp_ocorrencias', { where: `order_id=eq.${orderId}`, order: 'criada_em.desc' });
  return rows.find((o) => o.tipo === tipo && o.status !== 'fechada') || null;
}

function comentario(autor, texto) {
  return { autor, texto: String(texto || ''), em: new Date().toISOString() };
}

// Abre uma ocorrência (não duplica tipo já aberto). Opcionalmente notifica cliente.
// Retorna { ocorrencia, criada:boolean, email }.
export async function abrir(order, tipo, { auto = false, comentarioSistema = null, notificar = null } = {}) {
  if (!TIPOS.includes(tipo)) tipo = 'Problemas diversos';
  const existente = await abertaDoTipo(order.id, tipo);
  if (existente) {
    // já existe: apenas acrescenta comentário do sistema, se houver
    if (comentarioSistema) {
      const coms = Array.isArray(existente.comentarios) ? existente.comentarios : [];
      coms.push(comentario('sistema', comentarioSistema));
      await sb.update('cmp_ocorrencias', `id=eq.${existente.id}`, { comentarios: coms, updated_at: new Date().toISOString() });
    }
    return { ocorrencia: existente, criada: false };
  }
  const coms = [];
  coms.push(comentario('sistema', comentarioSistema || `Ocorrência aberta ${auto ? 'automaticamente' : 'manualmente'}: ${tipo}.`));
  const row = await sb.insert('cmp_ocorrencias', {
    order_id: order.id, tipo, status: 'aberta', auto,
    nota_fiscal: order.nota_fiscal || null, comentarios: coms,
  });
  // marca no pedido que há ocorrência (usado nos filtros/etiquetas)
  await sb.update('cmp_orders', `id=eq.${order.id}`, { ocorrencia: tipo, updated_at: new Date().toISOString() }).catch(() => {});

  // notificação ao cliente
  let email = { sent: false, reason: 'não solicitado' };
  const deveNotificar = notificar == null ? (auto && NOTIFICA_CLIENTE.has(tipo)) : notificar;
  if (deveNotificar && order.cliente_email) {
    email = await sendEmail({ to: order.cliente_email, subject: `Atualização do seu pedido #${order.numero || ''}`, html: ocorrenciaHtml(order, tipo, comentarioSistema) });
    if (email.sent) {
      const coms2 = [...coms, comentario('sistema', `Cliente notificado por e-mail (${order.cliente_email}).`)];
      await sb.update('cmp_ocorrencias', `id=eq.${row.id}`, { notif_cliente: true, notif_cliente_em: new Date().toISOString(), comentarios: coms2, updated_at: new Date().toISOString() });
      row.notif_cliente = true; row.comentarios = coms2;
    }
  }
  return { ocorrencia: row, criada: true, email };
}

export async function comentar(ocId, texto, autor = 'usuario') {
  const oc = await sb.selectOne('cmp_ocorrencias', { where: `id=eq.${ocId}` });
  if (!oc) return null;
  const coms = Array.isArray(oc.comentarios) ? oc.comentarios : [];
  coms.push(comentario(autor, texto));
  await sb.update('cmp_ocorrencias', `id=eq.${ocId}`, { comentarios: coms, updated_at: new Date().toISOString() });
  return { ...oc, comentarios: coms };
}

export async function tratativa(ocId) {
  const oc = await sb.selectOne('cmp_ocorrencias', { where: `id=eq.${ocId}` });
  if (!oc) return null;
  const coms = Array.isArray(oc.comentarios) ? oc.comentarios : [];
  coms.push(comentario('sistema', 'Tratativa iniciada.'));
  await sb.update('cmp_ocorrencias', `id=eq.${ocId}`, { status: 'tratativa', comentarios: coms, updated_at: new Date().toISOString() });
  return { ...oc, status: 'tratativa', comentarios: coms };
}

export async function fechar(ocId) {
  const oc = await sb.selectOne('cmp_ocorrencias', { where: `id=eq.${ocId}` });
  if (!oc) return null;
  const coms = Array.isArray(oc.comentarios) ? oc.comentarios : [];
  coms.push(comentario('sistema', 'Ocorrência fechada.'));
  await sb.update('cmp_ocorrencias', `id=eq.${ocId}`, { status: 'fechada', fechada_em: new Date().toISOString(), comentarios: coms, updated_at: new Date().toISOString() });
  // se não há mais ocorrências abertas, limpa a etiqueta do pedido
  const abertas = await sb.select('cmp_ocorrencias', { where: `order_id=eq.${oc.order_id}&status=neq.fechada`, limit: 1 });
  if (!abertas.length) await sb.update('cmp_orders', `id=eq.${oc.order_id}`, { ocorrencia: null }).catch(() => {});
  return { ...oc, status: 'fechada' };
}

// Notifica o cliente manualmente sobre uma ocorrência existente.
export async function notificarCliente(ocId) {
  const oc = await sb.selectOne('cmp_ocorrencias', { where: `id=eq.${ocId}` });
  if (!oc) return null;
  const order = await sb.selectOne('cmp_orders', { where: `id=eq.${oc.order_id}` });
  if (!order?.cliente_email) return { sent: false, reason: 'pedido sem e-mail do cliente' };
  const ultimoCom = (Array.isArray(oc.comentarios) ? oc.comentarios : []).filter((c) => c.autor === 'usuario').slice(-1)[0]?.texto || null;
  const email = await sendEmail({ to: order.cliente_email, subject: `Atualização do seu pedido #${order.numero || ''}`, html: ocorrenciaHtml(order, oc.tipo, ultimoCom) });
  if (email.sent) {
    const coms = Array.isArray(oc.comentarios) ? oc.comentarios : [];
    coms.push(comentario('sistema', `Cliente notificado por e-mail (${order.cliente_email}).`));
    await sb.update('cmp_ocorrencias', `id=eq.${ocId}`, { notif_cliente: true, notif_cliente_em: new Date().toISOString(), comentarios: coms, updated_at: new Date().toISOString() });
  }
  return email;
}

// Marca manualmente a transportadora como notificada (não há integração real — é registro).
export async function notifTransportadora(ocId) {
  const oc = await sb.selectOne('cmp_ocorrencias', { where: `id=eq.${ocId}` });
  if (!oc) return null;
  const coms = Array.isArray(oc.comentarios) ? oc.comentarios : [];
  coms.push(comentario('sistema', 'Transportadora notificada sobre a ocorrência.'));
  await sb.update('cmp_ocorrencias', `id=eq.${ocId}`, { notif_transportadora: true, comentarios: coms, updated_at: new Date().toISOString() });
  return { ...oc, notif_transportadora: true, comentarios: coms };
}

// Chamado pelo engine após atualizar rastreio/status: abre ocorrência conforme evento/estado.
export async function autoFromOrder(order, latestEvento) {
  const out = [];
  // 1) por descrição do último evento de rastreio
  if (latestEvento?.descricao) {
    const tipo = tipoFromEvento(latestEvento.descricao);
    if (tipo) {
      const r = await abrir(order, tipo, { auto: true, comentarioSistema: `${latestEvento.status || ''}${latestEvento.local ? ' - [' + latestEvento.local + ']' : ''} ${latestEvento.descricao}`.trim() });
      if (r.criada) out.push(tipo);
    }
  }
  // 2) por status do pedido
  if (order.status === 'atrasado') {
    const r = await abrir(order, 'Entrega atrasada', { auto: true, comentarioSistema: 'O pedido ultrapassou o prazo de entrega previsto.' });
    if (r.criada) out.push('Entrega atrasada');
  }
  if (order.status === 'devolvido') {
    const r = await abrir(order, 'Devolução', { auto: true, comentarioSistema: 'O pedido está retornando ao remetente.' });
    if (r.criada) out.push('Devolução');
  }
  if (order.status === 'aguardando_retirada') {
    const r = await abrir(order, 'Aguardando Retirada', { auto: true, comentarioSistema: 'O pedido está disponível para retirada.' });
    if (r.criada) out.push('Aguardando Retirada');
  }
  return out;
}

export default { TIPOS, tipoFromEvento, listByOrder, abrir, comentar, tratativa, fechar, notificarCliente, notifTransportadora, autoFromOrder, isConfigured };
