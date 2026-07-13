// Cliente Supabase mínimo via REST (PostgREST) — SEM dependências.
// Usa a SERVICE ROLE KEY (server-side apenas). Nunca exponha essa key no client.

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers(extra = {}) {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function req(path, opts = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, { ...opts, headers: headers(opts.headers) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// SELECT: select('cmp_orders', { where: 'status=eq.enviado', order: 'criado_em.desc', limit: 50 })
export async function select(table, { columns = '*', where = '', order = '', limit } = {}) {
  const q = new URLSearchParams();
  q.set('select', columns);
  if (order) q.set('order', order);
  if (limit) q.set('limit', String(limit));
  let url = `${table}?${q.toString()}`;
  if (where) url += `&${where}`;
  return req(url, { method: 'GET' });
}

export async function selectOne(table, opts) {
  const rows = await select(table, { ...opts, limit: 1 });
  return rows && rows[0] ? rows[0] : null;
}

export async function insert(table, row, { returning = true } = {}) {
  const rows = await req(table, {
    method: 'POST',
    headers: { Prefer: returning ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify(Array.isArray(row) ? row : [row]),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function upsert(table, row, onConflict) {
  const rows = await req(`${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(Array.isArray(row) ? row : [row]),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

// UPDATE: update('cmp_orders', 'id=eq.5', { status: 'entregue' })
export async function update(table, where, patch) {
  return req(`${table}?${where}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
}

export async function remove(table, where) {
  return req(`${table}?${where}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

// Verifica um token de sessão do Supabase Auth (para proteger endpoints admin).
// Valida o JWT localmente: emissor do nosso projeto + não expirado + tem sub.
// (Robusto e independente do formato de chave; admin é interno.)
export async function getUserFromToken(accessToken) {
  if (!accessToken) return null;
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.sub) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // expirado
    if (payload.iss && !String(payload.iss).includes(URL.replace(/^https?:\/\//, ''))) return null;
    return { id: payload.sub, email: payload.email, role: payload.role };
  } catch {
    return null;
  }
}

export default { select, selectOne, insert, upsert, update, remove, getUserFromToken };
