// api/at-media-limpeza.js
// Limpeza automática das fotos do atendimento (bucket at-media).
// Apaga imagens mais antigas que AT_MEDIA_RETENCAO_DIAS (padrão 60 dias).
// Chamado 1x por dia pelo cron do Vercel (ver vercel.json).
//
// Seguro por design: NÃO aceita a quantidade de dias por parâmetro — só apaga
// o que já passou da retenção. Env opcional: AT_MEDIA_RETENCAO_DIAS.

const SB = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

async function listarPasta(prefix) {
  try {
    const r = await fetch(SB() + '/storage/v1/object/list/at-media', {
      method: 'POST',
      headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'created_at', order: 'asc' } })
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}

async function apagarLote(paths) {
  const r = await fetch(SB() + '/storage/v1/object/at-media', {
    method: 'DELETE',
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths })
  });
  return r.ok;
}

export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'Supabase não configurado.' });
  }
  const dias = Math.max(1, Number(process.env.AT_MEDIA_RETENCAO_DIAS || 60));
  const cutoff = Date.now() - dias * 86400000;
  let removidos = 0, verificados = 0;
  try {
    for (const pasta of ['in/', 'out/']) {
      const itens = await listarPasta(pasta);
      verificados += itens.length;
      const velhos = itens
        .filter(o => o && o.name && o.created_at && new Date(o.created_at).getTime() < cutoff)
        .map(o => pasta + o.name);
      for (let i = 0; i < velhos.length; i += 100) {
        const lote = velhos.slice(i, i + 100);
        if (await apagarLote(lote)) removidos += lote.length;
      }
    }
    return res.status(200).json({ ok: true, retencao_dias: dias, verificados, removidos });
  } catch (e) {
    return res.status(200).json({ ok: false, erro: e.message, removidos });
  }
}
