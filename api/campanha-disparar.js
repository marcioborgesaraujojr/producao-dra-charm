// api/campanha-disparar.js
// Enfileira uma campanha (disparo em massa) na at_fila_envios. O envio real sai
// quando o WhatsApp estiver conectado (worker da fila). Só admin pode disparar.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const ADMIN = 'marcioborgesaraujojr@gmail.com';
const SB = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
async function sb(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, { ...opts,
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const txt = await r.text(); let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = txt; }
  if (!r.ok) throw new Error('SB ' + r.status + ': ' + JSON.stringify(d));
  return d;
}
async function callerEmail(token) {
  if (!token) return null;
  try { const r = await fetch(SB() + '/auth/v1/user', { headers: { apikey: KEY(), Authorization: 'Bearer ' + token } });
    const j = await r.json(); return j && j.email ? String(j.email).toLowerCase() : null; } catch (e) { return null; }
}
const preencher = (msg, nome) => String(msg || '').replace(/\{\{\s*nome\s*\}\}/gi, nome || 'cliente');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const email = await callerEmail(token);
  if (email !== ADMIN) return res.status(403).json({ error: 'Apenas o administrador pode disparar campanhas.' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const id = body && body.campanha_id;
  if (!id) return res.status(400).json({ error: 'campanha_id ausente' });

  const arr = await sb('at_campanhas?id=eq.' + id + '&select=*');
  const camp = Array.isArray(arr) ? arr[0] : null;
  if (!camp) return res.status(404).json({ error: 'Campanha não encontrada' });

  // resolve alvos
  let alvos = [];
  if (camp.publico === 'manual') {
    alvos = String(camp.telefones || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).map(t => ({ telefone: t, nome: null }));
  } else {
    const clientes = await sb('at_clientes?telefone=not.is.null&select=nome,telefone');
    alvos = (clientes || []).filter(c => c.telefone).map(c => ({ telefone: c.telefone, nome: c.nome }));
  }
  if (!alvos.length) return res.status(200).json({ ok: true, total: 0, aviso: 'Nenhum destinatário com telefone.' });

  // insere na fila em lote
  const linhas = alvos.map(a => ({ telefone: a.telefone, canal: 'whatsapp_oficial',
    conteudo: preencher(camp.mensagem, a.nome), status: 'pendente', evento_code: 'campanha:' + camp.id }));
  await sb('at_fila_envios', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(linhas) });
  await sb('at_campanhas?id=eq.' + id, { method: 'PATCH', body: JSON.stringify({ status: 'enfileirada', total: alvos.length, updated_at: new Date().toISOString() }) });

  return res.status(200).json({ ok: true, total: alvos.length });
}
