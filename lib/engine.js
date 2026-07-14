// Ciclo de monitoramento: importa da LI -> rastreia -> status -> SLA/acareação
// -> regras -> sincroniza status na LI. Adaptado para Supabase (Postgres).
import * as sb from './supabase.js';
import * as li from './li.js';
import { track } from './tracking.js';
import { matchRule } from './rules.js';
import { FINAL_STATUSES } from './statusmap.js';
import { autoFromOrder } from './ocorrencias.js';

const BASE_URL = process.env.PUBLIC_BASE_URL || '';

function addBusinessDays(dateStr, n) {
  const d = new Date(dateStr); let a = 0;
  while (a < n) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) a++; }
  return d.toISOString();
}
function hashEvent(e) { return `${e.data || ''}|${(e.descricao || '').slice(0, 60)}`; }

async function alertInternal(subject, lines) {
  const hook = process.env.ALERT_WEBHOOK;
  if (!hook) { console.log('[alerta]', subject, lines.join(' | ')); return; }
  try {
    await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `${subject}\n${lines.join('\n')}` }) });
  } catch (e) { console.log('[alerta:falha]', e.message); }
}

async function setStatus(order, newStatus, source, actions, { forceSync = false } = {}) {
  if (order.status === newStatus) return false;
  await sb.update('cmp_orders', `id=eq.${order.id}`, { status: newStatus, updated_at: new Date().toISOString() });
  await sb.insert('cmp_status_history', { order_id: order.id, from_status: order.status, to_status: newStatus, source }, { returning: false });
  actions.push(`status: ${order.status} -> ${newStatus} (${source})`);
  order.status = newStatus;
  const syncable = ['enviado', 'entregue', 'cancelado', 'aguardando_retirada'];
  if (forceSync || syncable.includes(newStatus)) {
    try { const r = await li.updateOrderStatus(order.li_id, newStatus); actions.push(`LI sync -> situação ${r.situacao ?? '?'}${r.mock ? ' (mock)' : ''}`); }
    catch (e) { actions.push(`falha LI sync: ${e.message}`); }
  }
  return true;
}

export async function processOrder(orderId) {
  let order = await sb.selectOne('cmp_orders', { where: `id=eq.${orderId}` });
  if (!order) return { skipped: true };
  const actions = [];
  const before = order.status;
  let latestEvento = null;

  // 1) Rastreio
  if (order.tracking_code && order.transportadora !== 'motoboy' && !FINAL_STATUSES.has(order.status)) {
    const r = await track(order);
    if (r.found) {
      const existing = await sb.select('cmp_events', { columns: 'hash', where: `order_id=eq.${orderId}` });
      const have = new Set(existing.map((x) => x.hash));
      const fresh = r.events.map((e) => ({ order_id: orderId, data: e.data || null, status: e.status || '', descricao: e.descricao || '', local: e.local || '', hash: hashEvent(e) }))
        .filter((e) => !have.has(e.hash));
      if (fresh.length) await sb.insert('cmp_events', fresh, { returning: false });
      const latest = r.events[0];
      latestEvento = latest || null;
      const patch = { last_tracked_at: new Date().toISOString() };
      if (latest) patch.ocorrencia = latest.descricao;
      if (!order.data_envio && r.events.length) patch.data_envio = r.events[r.events.length - 1].data || order.criado_em;
      if (r.forecast && !order.prazo_entrega) patch.prazo_entrega = r.forecast;
      await sb.update('cmp_orders', `id=eq.${orderId}`, patch);
      Object.assign(order, patch);
      if (fresh.length) actions.push(`${fresh.length} novo(s) evento(s)`);
      if (r.delivered) await setStatus(order, 'entregue', 'rastreio', actions);
      else if (r.returned) await setStatus(order, 'devolvido', 'rastreio', actions);
      else if (r.awaitingPickup) await setStatus(order, 'aguardando_retirada', 'rastreio', actions);
    } else if (r.error) actions.push(`erro rastreio: ${r.error}`);
  }

  // 2) Prazo
  if (!order.prazo_entrega && (order.data_envio || order.status === 'enviado')) {
    const prazo = addBusinessDays(order.data_envio || order.criado_em, Number(process.env.DEFAULT_PRAZO_DIAS || 8));
    await sb.update('cmp_orders', `id=eq.${orderId}`, { prazo_entrega: prazo });
    order.prazo_entrega = prazo;
  }

  // 3) SLA + acareação
  if (!FINAL_STATUSES.has(order.status) && order.prazo_entrega) {
    const late = Date.now() > new Date(order.prazo_entrega).getTime();
    if (late && order.status !== 'atrasado') await setStatus(order, 'atrasado', 'sla', actions);
    if (late && order.transportadora === 'correios' && !order.acareacao_aberta) {
      await sb.update('cmp_orders', `id=eq.${orderId}`, { acareacao_aberta: true, acareacao_em: new Date().toISOString() });
      order.acareacao_aberta = true;
      actions.push('acareação aberta');
      await alertInternal('Acareação aberta', [`Pedido #${order.numero} (${order.cliente_nome})`, `Rastreio: ${order.tracking_code || '-'}`, `Prazo: ${order.prazo_entrega}`]);
    }
  }

  // 4) Regras
  const rules = await sb.select('cmp_rules', { where: 'enabled=eq.true', order: 'priority.asc' });
  for (const rule of rules) {
    const when = rule.when_json, then = rule.then_json;
    if (!matchRule(order, when)) continue;
    if (then.setPrazoDias != null) {
      const prazo = addBusinessDays(order.data_envio || order.criado_em, then.setPrazoDias);
      await sb.update('cmp_orders', `id=eq.${orderId}`, { prazo_entrega: prazo }); order.prazo_entrega = prazo;
    }
    if (then.openAcareacao && !order.acareacao_aberta) {
      await sb.update('cmp_orders', `id=eq.${orderId}`, { acareacao_aberta: true, acareacao_em: new Date().toISOString() });
      order.acareacao_aberta = true; actions.push(`regra "${rule.name}": acareação`);
    }
    if (then.alertInternal) await alertInternal(`Regra: ${rule.name}`, [`Pedido #${order.numero}`]);
    if (then.setStatus) await setStatus(order, then.setStatus, `regra:${rule.name}`, actions, { forceSync: then.syncLI });
  }

  // 4.5) Ocorrências automáticas (evento de rastreio + status)
  if (!FINAL_STATUSES.has(order.status) || order.status === 'devolvido') {
    try { const abertas = await autoFromOrder(order, latestEvento); if (abertas.length) actions.push(`ocorrência(s): ${abertas.join(', ')}`); }
    catch (e) { actions.push(`falha ocorrência: ${e.message}`); }
  }

  // 5) Entregue: fecha acareação e grava data
  if (order.status === 'entregue') {
    const patch = {};
    if (order.acareacao_aberta) patch.acareacao_aberta = false;
    if (!order.data_entrega) patch.data_entrega = new Date().toISOString();
    if (Object.keys(patch).length) await sb.update('cmp_orders', `id=eq.${orderId}`, patch);
  }
  return { orderId, numero: order.numero, before, after: order.status, actions };
}

export async function importOrders() {
  const orders = await li.fetchOrders();
  let novos = 0, atualizados = 0;
  for (const o of orders) {
    const existing = await sb.selectOne('cmp_orders', { columns: 'id', where: `li_id=eq.${o.li_id}` });
    const row = {
      li_id: o.li_id, numero: o.numero, nota_fiscal: o.nota_fiscal, cliente_nome: o.cliente_nome,
      cliente_email: o.cliente_email, cliente_cpf: o.cliente_cpf, destino: o.destino, uf: o.uf, preco: o.preco,
      transportadora: o.transportadora, servico: o.servico, skus: o.skus, criado_em: o.criado_em, raw: o.raw,
    };
    if (o.tracking_code) row.tracking_code = o.tracking_code;
    if (existing) { await sb.update('cmp_orders', `id=eq.${existing.id}`, row); atualizados++; }
    else { await sb.insert('cmp_orders', { ...row, status: o.status }, { returning: false }); novos++; }
  }
  return { total: orders.length, novos, atualizados };
}

export async function runCycle() {
  const imp = await importOrders();
  const active = await sb.select('cmp_orders', { columns: 'id', where: 'status=not.in.(entregue,cancelado,devolvido)' });
  const results = [];
  for (const { id } of active) {
    try { results.push(await processOrder(id)); } catch (e) { results.push({ orderId: id, error: e.message }); }
  }
  return { import: imp, processados: active.length, comAcao: results.filter((r) => r.actions && r.actions.length).length, results };
}

export default { processOrder, importOrders, runCycle };
