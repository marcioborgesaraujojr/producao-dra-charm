// Motor de regras (mesma lógica validada). skus vem como array (jsonb).
function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}
function skuList(order) {
  const arr = Array.isArray(order.skus) ? order.skus : (() => { try { return JSON.parse(order.skus || '[]'); } catch { return []; } })();
  return arr.map((s) => String(s).toUpperCase());
}

export function matchRule(order, when) {
  const skus = skuList(order);
  if (when.carrier && !when.carrier.includes(order.transportadora)) return false;
  if (when.statusIn && !when.statusIn.includes(order.status)) return false;
  if (when.ufIn && !when.ufIn.includes((order.uf || '').toUpperCase())) return false;
  if (when.noTrackingCode && order.tracking_code) return false;
  if (when.skuContains) {
    const nds = when.skuContains.map((s) => s.toUpperCase());
    if (!skus.some((sku) => nds.some((n) => sku.includes(n)))) return false;
  }
  if (when.skuNotContains) {
    const nds = when.skuNotContains.map((s) => s.toUpperCase());
    if (skus.some((sku) => nds.some((n) => sku.includes(n)))) return false;
  }
  if (when.daysSinceSentGte != null && daysSince(order.data_envio || order.criado_em) < when.daysSinceSentGte) return false;
  if (when.daysSinceCreatedGte != null && daysSince(order.criado_em) < when.daysSinceCreatedGte) return false;
  return true;
}

export default { matchRule };
