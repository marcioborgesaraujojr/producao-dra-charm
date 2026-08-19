// api/atendimento-config.js
// Horário de atendimento do número oficial + mensagem de ausência.
//
// Fica guardado em sys_config na chave 'atend_config' (um JSON só), então não
// precisa de migração no banco.
//
// GET  (Bearer da suíte) -> devolve a configuração (com o padrão se nunca foi salva)
// POST (Bearer da suíte) -> salva { ativo, tz, dias[7], texto, repetir_horas }
//
// Quem usa isso na prática é o api/whatsapp-webhook.js: quando chega mensagem de
// cliente fora do horário e o chatbot está desligado, ele responde a ausência.

const SB = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHAVE = 'atend_config';

const PADRAO = {
  ativo: false,
  tz: 'America/Fortaleza',
  // índice 0 = domingo … 6 = sábado
  dias: [
    { on: false, de: '08:00', ate: '12:00' },
    { on: true,  de: '07:00', ate: '17:00' },
    { on: true,  de: '07:00', ate: '17:00' },
    { on: true,  de: '07:00', ate: '17:00' },
    { on: true,  de: '07:00', ate: '17:00' },
    { on: true,  de: '07:00', ate: '16:00' },
    { on: false, de: '08:00', ate: '12:00' }
  ],
  texto: 'Oi! 💛 Você chegou fora do nosso horário de atendimento.\n\n{{horario}}\n\nPode deixar sua mensagem por aqui que assim que abrirmos a gente te responde. 🙂',
  repetir_horas: 6
};

async function sb(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

async function callerEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB() + '/auth/v1/user', { headers: { apikey: KEY(), Authorization: 'Bearer ' + token } });
    const j = await r.json();
    return j && j.email ? String(j.email) : null;
  } catch (e) { return null; }
}

function horaValida(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
}

// deixa o que veio do painel num formato previsível antes de gravar
function limpar(body) {
  const dias = [];
  for (let i = 0; i < 7; i++) {
    const d = (Array.isArray(body.dias) ? body.dias[i] : null) || {};
    dias.push({
      on: !!d.on,
      de: horaValida(d.de) ? d.de : PADRAO.dias[i].de,
      ate: horaValida(d.ate) ? d.ate : PADRAO.dias[i].ate
    });
  }
  let horas = Number(body.repetir_horas);
  if (!isFinite(horas) || horas < 0) horas = 6;
  if (horas > 72) horas = 72;
  return {
    ativo: !!body.ativo,
    tz: String(body.tz || PADRAO.tz),
    dias,
    texto: String(body.texto || '').slice(0, 1000),
    repetir_horas: horas
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });

  if (req.method === 'GET') {
    const r = await sb('sys_config?chave=eq.' + CHAVE + '&select=valor&limit=1');
    const row = Array.isArray(r.data) ? r.data[0] : null;
    let cfg = PADRAO;
    if (row && row.valor) { try { cfg = Object.assign({}, PADRAO, JSON.parse(row.valor)); } catch (e) { cfg = PADRAO; } }
    return res.status(200).json({ ok: true, config: cfg, nunca_salvo: !row });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const cfg = limpar(body || {});
    if (cfg.ativo && !cfg.texto.trim()) {
      return res.status(400).json({ error: 'Escreva a mensagem de ausência antes de ligar.' });
    }

    const r = await sb('sys_config?on_conflict=chave', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ chave: CHAVE, valor: JSON.stringify(cfg) })
    });
    if (!r.ok) return res.status(500).json({ error: 'Não deu pra salvar.', detalhe: r.data });

    try {
      await sb('sys_audit_log', {
        method: 'POST',
        body: JSON.stringify({ actor_email: email, tabela: 'sys_config', operacao: 'UPDATE',
                               registro_id: CHAVE, dados_depois: cfg })
      });
    } catch (e) {}

    return res.status(200).json({ ok: true, config: cfg });
  }

  return res.status(405).json({ error: 'Método não permitido' });
}
