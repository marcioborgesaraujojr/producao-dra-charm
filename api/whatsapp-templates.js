// api/whatsapp-templates.js
// Lista os templates aprovados da WABA e envia mensagem de TEMPLATE (WhatsApp Cloud API oficial).
// Serve pra falar com o cliente FORA da janela de 24h (aí só um template aprovado reabre a conversa).
//
// Env vars no Vercel (o Marcio cadastra; NUNCA no código):
//   WA_ACCESS_TOKEN            (token permanente do WhatsApp Business)
//   WA_PHONE_NUMBER_ID         (Phone Number ID do número que envia)
//   WA_WABA_ID                 (id da conta WhatsApp; se faltar, usa o padrão da Dra. Charm)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (já existem)
//
// GET  -> { templates: [{ name, language, category, body, vars }] }   (só APPROVED)
// POST -> body { to, name, language, params:[...], conversa_id, preview } -> envia o template

const GRAPH = 'https://graph.facebook.com/v20.0';
const WABA = () => process.env.WA_WABA_ID || '579587495233435';

// Brasil / 9º dígito (mesma regra do whatsapp-send.js)
function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length === 12) { n = '55' + n.slice(2, 4) + '9' + n.slice(4); }
  return n;
}

async function callerEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token }
    });
    const j = await r.json();
    return j && j.email ? String(j.email) : null;
  } catch (e) { return null; }
}

// A bolha da conversa mostra quem respondeu. Guardar o e-mail aqui fazia a atendente
// ver "fulana@gmail.com" em cima de cada mensagem. Aqui a gente troca pelo nome do
// perfil ANTES de gravar. Sem perfil/nome, arruma o começo do e-mail (ana.paula -> Ana Paula).
function _capitalizaNome(s) {
  return String(s || '').split(/[\s._-]+/).filter(Boolean)
    .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
}
async function nomeDoAtendente(email) {
  const e = String(email || '').trim();
  if (!e) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/profiles?select=full_name&email=eq.'
      + encodeURIComponent(e) + '&limit=1', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
    });
    const j = await r.json();
    const nome = Array.isArray(j) && j[0] && j[0].full_name ? String(j[0].full_name).trim() : '';
    if (nome && nome.indexOf('@') === -1) return nome;
  } catch (err) { /* nome é enfeite: nunca pode derrubar o envio */ }
  return _capitalizaNome(e.split('@')[0]) || null;
}

async function sbInsertMsg(conversaId, texto, autor) {
  if (!conversaId) return;
  const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  await fetch(process.env.SUPABASE_URL + '/rest/v1/at_mensagens', {
    method: 'POST', headers: H,
    body: JSON.stringify({ conversa_id: conversaId, direcao: 'out', tipo: 'template', conteudo: texto, autor: autor || 'atendente' })
  });
  await fetch(process.env.SUPABASE_URL + '/rest/v1/at_conversas?id=eq.' + conversaId, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ ultima_msg_preview: String(texto).slice(0, 120), ultima_msg_em: new Date().toISOString(), janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const email = await callerEmail(token);
  if (!email) return res.status(403).json({ error: 'Sessão inválida. Faça login na suíte.' });
  if (!process.env.WA_ACCESS_TOKEN) return res.status(503).json({ error: 'WhatsApp não configurado (falta WA_ACCESS_TOKEN no Vercel).' });

  // ===== LISTAR templates aprovados =====
  if (req.method === 'GET') {
    try {
      const url = GRAPH + '/' + WABA() + '/message_templates?limit=250&access_token=' + encodeURIComponent(process.env.WA_ACCESS_TOKEN);
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || 'Erro ao listar templates', data: j });
      const todos = ['1', 'true'].includes(String((req.query && req.query.all) || ''));
      const templates = (j.data || [])
        .filter(t => todos || t.status === 'APPROVED')   // envio usa só APPROVED; gestão (?all=1) vê todos os status
        .map(t => {
          const bodyC = (t.components || []).find(c => c.type === 'BODY');
          const bodyTxt = (bodyC && bodyC.text) || '';
          const vars = (bodyTxt.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
          return { name: t.name, language: t.language, category: t.category, status: t.status,
                   motivo: t.rejected_reason || null, qualidade: (t.quality_score && t.quality_score.score) || null,
                   body: bodyTxt, vars };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json({ templates });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ===== EXCLUIR template (apaga NA META tambem - o painel so espelha) =====
  if (req.method === 'DELETE') {
    const nome = String((req.query && (req.query.name || req.query.nome)) || '').trim();
    if (!nome) return res.status(400).json({ error: 'Informe o nome do modelo.' });

    // trava: nao deixa apagar modelo que algum disparo automatico esta usando
    try {
      const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY };
      const ru = await fetch(process.env.SUPABASE_URL + '/rest/v1/at_disparos?template_name=eq.' +
                             encodeURIComponent(nome) + '&select=evento_key,ativo', { headers: H });
      const usos = await ru.json();
      const emUso = Array.isArray(usos) ? usos.filter(u => u.ativo) : [];
      if (emUso.length) {
        return res.status(409).json({
          error: 'Esse modelo está em uso por um disparo automático ligado (' +
                 emUso.map(u => u.evento_key).join(', ') + '). Desligue o gatilho antes de apagar.'
        });
      }
    } catch (e) { /* se a checagem falhar, segue - a Meta ainda valida */ }

    try {
      const url = GRAPH + '/' + WABA() + '/message_templates?name=' + encodeURIComponent(nome) +
                  '&access_token=' + encodeURIComponent(process.env.WA_ACCESS_TOKEN);
      const r = await fetch(url, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || 'A Meta recusou a exclusão', data: j });

      // registra na Auditoria quem apagou
      try {
        await fetch(process.env.SUPABASE_URL + '/rest/v1/sys_audit_log', {
          method: 'POST',
          headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ actor_email: email, tabela: 'wa_modelos', operacao: 'DELETE',
                                 registro_id: nome, dados_antes: { modelo: nome }, dados_depois: null })
        });
      } catch (e) { /* best effort */ }

      return res.status(200).json({ ok: true, apagado: nome });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  if (!process.env.WA_PHONE_NUMBER_ID) return res.status(503).json({ error: 'Falta WA_PHONE_NUMBER_ID no Vercel.' });

  // ===== ENVIAR template =====
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const to = normalizeWa(body && body.to);
  const name = body && body.name;
  const language = (body && body.language) || 'pt_BR';
  const params = Array.isArray(body && body.params) ? body.params : [];
  const conversaId = body && body.conversa_id;
  const previewTxt = body && body.preview;
  if (!to || !name) return res.status(400).json({ error: 'Faltou destino ou nome do template.' });

  const template = { name, language: { code: language } };
  if (params.length) {
    template.components = [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }];
  }

  try {
    const r = await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || 'Erro ao enviar template', data: j });
    await sbInsertMsg(conversaId, previewTxt || ('[modelo: ' + name + ']'), await nomeDoAtendente(email));
    return res.status(200).json({ ok: true, data: j });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
