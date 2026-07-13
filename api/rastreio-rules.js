// Admin: CRUD de regras de automação. Protegido por sessão do Supabase.
import * as sb from '../lib/supabase.js';

async function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = await sb.getUserFromToken(token);
  if (!user) { res.status(401).json({ error: 'não autorizado' }); return null; }
  return user;
}

export default async function handler(req, res) {
  if (!(await requireAdmin(req, res))) return;

  if (req.method === 'GET') {
    const rules = await sb.select('cmp_rules', { order: 'priority.asc' });
    return res.status(200).json({ rules });
  }
  if (req.method === 'POST') {
    const { id, name, enabled, priority, when, then, action } = req.body || {};
    if (action === 'delete') { await sb.remove('cmp_rules', `id=eq.${id}`); return res.status(200).json({ ok: true }); }
    if (action === 'toggle') {
      const r = await sb.selectOne('cmp_rules', { where: `id=eq.${id}` });
      await sb.update('cmp_rules', `id=eq.${id}`, { enabled: !r.enabled });
      return res.status(200).json({ ok: true });
    }
    const row = { name, enabled: enabled !== false, priority: Number(priority || 100), when_json: when || {}, then_json: then || {} };
    if (id) { await sb.update('cmp_rules', `id=eq.${id}`, row); return res.status(200).json({ ok: true, id }); }
    const created = await sb.insert('cmp_rules', row);
    return res.status(200).json({ ok: true, id: created?.id });
  }
  res.status(405).json({ error: 'método não suportado' });
}
