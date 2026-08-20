// api/whatsapp-webhook.js
// Webhook do WhatsApp Cloud API (oficial da Meta).
// GET  = verificação do webhook (Meta chama com hub.challenge).
// POST = recebimento de mensagens → grava em at_clientes/at_conversas/at_mensagens
//        e, se o Chatbot IA estiver ATIVO, responde sozinho (modo robô).
//
// Env vars no Vercel:
//   WA_VERIFY_TOKEN, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { buscarFotoWhatsApp } from '../lib/foto.js';

const GRAPH = 'https://graph.facebook.com/v20.0';
const SB  = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

// Comparação de texto do cliente: sem acento e sem maiúscula. Gente escreve "troca",
// "TROCA" e "tróca" pra dizer a mesma coisa.
function semAcentoWh(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Brasil / 9º dígito (mesma regra do whatsapp-send.js)
function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length === 12) { n = '55' + n.slice(2, 4) + '9' + n.slice(4); }
  return n;
}

async function sbFetch(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: KEY(),
      Authorization: 'Bearer ' + KEY(),
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + JSON.stringify(data));
  return data;
}

// upsert cliente por whatsapp_id, retorna o registro
async function upsertCliente({ waid, nome, telefone }) {
  const rows = await sbFetch('at_clientes?on_conflict=whatsapp_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ whatsapp_id: waid, nome: nome || 'Cliente', telefone: telefone || null })
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

// acha conversa aberta/pendente do cliente, senão cria
async function getOrCreateConversa(clienteId) {
  // Pega a ULTIMA conversa do cliente, mesmo resolvida, e reabre. Antes criavamos
  // uma conversa nova e o historico anterior parecia ter sumido pra quem atendia.
  const found = await sbFetch(
    'at_conversas?cliente_id=eq.' + clienteId + '&select=id,status&order=ultima_msg_em.desc.nullslast&limit=1'
  );
  if (Array.isArray(found) && found.length) {
    const ja = found[0];
    if (ja.status === 'encerrada') {
      await sbFetch('at_conversas?id=eq.' + ja.id, { method: 'PATCH', body: JSON.stringify({ status: 'aberta', nao_lida: true }) });
    }
    return ja.id;
  }
  const created = await sbFetch('at_conversas', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      cliente_id: clienteId,
      canal: 'whatsapp_oficial',
      status: 'aberta',
      nao_lida: true,
      janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      ultima_msg_em: new Date().toISOString()
    })
  });
  return (Array.isArray(created) ? created[0] : created).id;
}

// motivo que o WhatsApp informa quando não repassa a mensagem (unsupported)
function motivoErro(m) {
  const e = (m && m.errors && m.errors[0]) || {};
  const det = e.title || (e.error_data && e.error_data.details) || e.message || '';
  return String(det || '').replace(/\.$/, '').trim();
}

// extrai texto/tipo de uma mensagem do WhatsApp
function parseMsg(m) {
  switch (m.type) {
    case 'text':     return { tipo: 'texto',      conteudo: m.text?.body || '' };
    case 'reaction': return { tipo: 'texto',      conteudo: m.reaction?.emoji ? ('reagiu ' + m.reaction.emoji) : '[reação removida]' };
    case 'sticker':  return { tipo: 'imagem',     conteudo: '[figurinha]' };
    case 'image':    return { tipo: 'imagem',     conteudo: m.image?.caption || '[imagem]' };
    case 'audio':    return { tipo: 'audio',      conteudo: '[áudio]' };
    case 'document': return { tipo: 'documento',  conteudo: m.document?.filename || '[documento]' };
    case 'video':    return { tipo: 'documento',  conteudo: m.video?.caption || '[vídeo]' };
    case 'location': return { tipo: 'texto',      conteudo: '[localização]' };
    case 'contacts': return { tipo: 'texto',      conteudo: '[contato]' };
    case 'unsupported': { const mo = motivoErro(m); return { tipo: 'texto', conteudo: '[mensagem não suportada pelo WhatsApp' + (mo ? (' — ' + mo) : ' (encaminhada/enquete/ver uma vez/etc.)') + ']' }; }
    default:            { const mo = motivoErro(m); return { tipo: 'texto', conteudo: '[mensagem não suportada pelo WhatsApp' + (mo ? (' — ' + mo) : (m && m.type ? (' (' + m.type + ')') : '')) + ']' }; }
  }
}

// ===== MÍDIA: baixa foto/figurinha/áudio/vídeo/documento do WhatsApp e sobe no storage (bucket at-media) =====
const EXT_MAP = {
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
  'audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','audio/aac':'aac','audio/amr':'amr','audio/wav':'wav',
  'video/mp4':'mp4','video/3gpp':'3gp','video/quicktime':'mov',
  'application/pdf':'pdf'
};
// identifica se a mensagem tem mídia baixável e de que tipo (pro front renderizar o player certo)
function midiaIdTipo(m){
  if(m.type==='image'    && m.image    && m.image.id)    return { id:m.image.id,    tipo:'imagem' };
  if(m.type==='sticker'  && m.sticker  && m.sticker.id)  return { id:m.sticker.id,  tipo:'imagem' };
  if(m.type==='audio'    && m.audio    && m.audio.id)    return { id:m.audio.id,    tipo:'audio' };
  if(m.type==='video'    && m.video    && m.video.id)    return { id:m.video.id,    tipo:'video' };
  if(m.type==='document' && m.document && m.document.id) return { id:m.document.id, tipo:'documento' };
  return null;
}
async function baixarMidia(mediaId){
  try{
    if(!process.env.WA_ACCESS_TOKEN) return null;
    const r1 = await fetch(GRAPH + '/' + mediaId, { headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN } });
    const j1 = await r1.json(); if(!j1 || !j1.url) return null;
    const r2 = await fetch(j1.url, { headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN } });
    if(!r2.ok) return null;
    const clen = Number(r2.headers.get('content-length') || 0);
    if(clen && clen > 20 * 1024 * 1024) return null;   // >20MB: não baixa (evita estourar memória/timeout)
    const buf = Buffer.from(await r2.arrayBuffer());
    const mime = String(j1.mime_type || r2.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const ext = EXT_MAP[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi,'').slice(0,5) || 'bin';
    const path = 'in/' + Date.now() + '-' + String(mediaId).slice(-10) + '.' + ext;
    const up = await fetch(SB() + '/storage/v1/object/at-media/' + path, {
      method: 'POST',
      headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': mime, 'x-upsert': 'true' },
      body: buf
    });
    if(!up.ok) return null;
    return { url: SB() + '/storage/v1/object/public/at-media/' + path, mime };
  }catch(e){ console.error('baixarMidia:', e.message); return null; }
}

// ===== FORA DO HORÁRIO: mensagem de ausência =====
// Só entra em ação quando o chatbot está DESLIGADO — se o robô responde, ele já
// dá conta. A configuração fica em sys_config.atend_config (tela Conexão WhatsApp).
const DIAS_NOME = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

async function lerAtendCfg() {
  try {
    const r = await sbFetch('sys_config?chave=eq.atend_config&select=valor&limit=1');
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.valor) return null;
    return JSON.parse(row.valor);
  } catch (e) { return null; }
}

// dia da semana (0=domingo) e minutos do dia, no fuso da loja
function agoraLocal(tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'America/Fortaleza', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  const mapa = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let h = parseInt(g('hour'), 10); if (h === 24) h = 0;
  return { dia: mapa[g('weekday')] || 0, min: h * 60 + parseInt(g('minute'), 10) };
}

function dentroDoHorario(cfg) {
  const { dia, min } = agoraLocal(cfg.tz);
  const d = (cfg.dias || [])[dia];
  if (!d || !d.on) return false;
  const a = String(d.de || '00:00').split(':').map(Number);
  const b = String(d.ate || '23:59').split(':').map(Number);
  return min >= (a[0] * 60 + a[1]) && min < (b[0] * 60 + b[1]);
}

function resumoHorario(cfg) {
  const abertos = (cfg.dias || []).map((d, i) => ({ d, i })).filter(x => x.d && x.d.on);
  if (!abertos.length) return '';
  return 'Atendemos ' + abertos.map(x => DIAS_NOME[x.i] + ' das ' + x.d.de + ' às ' + x.d.ate).join(', ') + '.';
}

// O nome vem do perfil do WhatsApp do cliente, então pode vir com emoji, tudo
// minúsculo, ou nome de empresa. Fica só o primeiro nome, limpo. Se não der pra
// aproveitar, devolve vazio e o texto se ajeita sem ele.
function primeiroNome(bruto) {
  const s = String(bruto || '').replace(/[^\p{L}\p{M}\s'-]/gu, ' ').trim();
  if (!s) return '';
  const titulos = /^(dr|dra|sr|sra|srta|prof|profa|enf|tec|tecn)$/i;
  const palavra = s.split(/\s+/).find(p => p.length >= 2 && !titulos.test(p));
  if (!palavra || /^(cliente|client)$/i.test(palavra)) return '';
  return palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase();
}

async function maybeAusencia(conversaId, waid, nomeBruto) {
  try {
    if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) return;

    // robô ligado? então ele responde e a ausência não entra
    try {
      const bot = await sbFetch('at_chatbot?id=eq.1&select=ativo');
      const b = Array.isArray(bot) ? bot[0] : bot;
      if (b && b.ativo) return;
    } catch (e) {}

    const cfg = await lerAtendCfg();
    if (!cfg || !cfg.ativo) return;
    if (dentroDoHorario(cfg)) return;

    // não repete pro mesmo cliente dentro da janela configurada
    const horas = Number(cfg.repetir_horas || 6);
    if (horas > 0) {
      const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
      const ja = await sbFetch('at_mensagens?conversa_id=eq.' + conversaId +
        '&meta->>ausencia=eq.1&created_at=gte.' + encodeURIComponent(desde) + '&select=id&limit=1');
      if (Array.isArray(ja) && ja.length) return;
    }

    const pn = primeiroNome(nomeBruto);
    let texto = String(cfg.texto || '')
      .replace(/\{\{\s*horario\s*\}\}/g, resumoHorario(cfg))
      .replace(/\{\{\s*nome\s*\}\}/g, pn);
    // sem nome, sobra "Oi !" ou "Olá, !" — arruma a pontuação órfã
    if (!pn) {
      texto = texto.replace(/,\s*([!?.])/g, '$1').replace(/ +([,!?.])/g, '$1').replace(/[ \t]{2,}/g, ' ');
    }
    texto = texto.trim();
    if (!texto) return;

    const r = await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizeWa(waid), type: 'text', text: { body: texto } })
    });
    if (!r.ok) return;

    await sbFetch('at_mensagens', { method: 'POST', body: JSON.stringify({
      conversa_id: conversaId, direcao: 'out', tipo: 'texto', conteudo: texto,
      autor: 'Automático · fora do horário', meta: { ausencia: '1' } }) });
    // continua NÃO LIDA de propósito: a equipe precisa ver isso quando abrir
    await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({
      ultima_msg_preview: texto.slice(0, 120), ultima_msg_em: new Date().toISOString() }) });
  } catch (e) { console.error('ausencia:', e && e.message); }
}

// ===== CHATBOT IA: responde sozinho quando ATIVO e ninguém humano assumiu =====
async function maybeBotReply(conversaId, clienteNome, inboundText, waid, host, ultimaMsgId) {
  try {
    if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) return;
    let cfgRows = null; try { cfgRows = await sbFetch('at_chatbot?id=eq.1&select=*'); } catch (e) { return; }
    const cfg = Array.isArray(cfgRows) ? cfgRows[0] : cfgRows;
    if (!cfg || !cfg.ativo) return;                                   // chatbot desligado -> nada

    let convRows = null; try { convRows = await sbFetch('at_conversas?id=eq.' + conversaId + '&select=modo,atendente_id,bot_encerrada_em'); } catch (e) {}
    const cv = Array.isArray(convRows) ? convRows[0] : convRows;
    if (cv && (cv.modo === 'humano' || cv.atendente_id)) return;      // humano assumiu -> robô quieto

    // ---- Espera pra reentrar (aba Atendimento) ----
    // Cliente que acabou de ser encerrado não cai de novo no robô na mesma hora.
    const esperaH = parseInt(cfg.reentrada_horas, 10) || 0;
    if (esperaH > 0 && cv && cv.bot_encerrada_em) {
      const desde = Date.now() - new Date(cv.bot_encerrada_em).getTime();
      if (desde < esperaH * 3600 * 1000) {
        await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ nao_lida: true }) });
        return;
      }
    }

    // ---- GATILHOS (aba Gatilhos) ----
    // Frase que faz o robô ENTRAR. Nenhum gatilho ativo = ele responde tudo.
    // Esta regra é a mesma da função baterGatilho() no chatbot.html — se mudar uma,
    // mudar a outra, senão o testador da tela mente.
    let gats = []; try { gats = await sbFetch('at_chatbot_gatilhos?select=texto,tipo,ativo&ativo=eq.true'); } catch (e) {}
    const ativos = (Array.isArray(gats) ? gats : []).filter(g => String(g.texto || '').trim());
    if (ativos.length) {
      const t = semAcentoWh(inboundText);
      const bateu = ativos.some(g => {
        const f = semAcentoWh(g.texto).trim();
        if (g.tipo === 'igual')  return t.trim() === f;
        if (g.tipo === 'comeca') return t.trim().startsWith(f);
        return t.includes(f);
      });
      if (!bateu) {                                                   // não é caso do robô -> fila humana
        await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ nao_lida: true }) });
        return;
      }
    }

    // handoff por palavra-chave (antes de gastar IA)
    const termos = String(cfg.handoff_termos || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (termos.some(t => t && String(inboundText || '').toLowerCase().includes(t))) {
      await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ modo: 'humano', nao_lida: true }) });
      await sbFetch('at_mensagens', { method: 'POST', body: JSON.stringify({ conversa_id: conversaId, direcao: 'in', tipo: 'nota', conteudo: 'Cliente pediu atendente humano (palavra-chave). Robô pausado.', autor: 'Sistema' }) });
      return;
    }

    // histórico — quantas mensagens ele lê é ajustável na aba Configurações
    const contexto = Math.min(Math.max(parseInt(cfg.contexto_msgs, 10) || 12, 2), 40);
    let rows = []; try { rows = await sbFetch('at_mensagens?conversa_id=eq.' + conversaId + '&select=direcao,conteudo,tipo,meta&order=enviada_em.desc&limit=' + (contexto + 20)); } catch (e) {}
    const todas = (Array.isArray(rows) ? rows : []).reverse();
    const msgs = todas
      .filter(m => (m.tipo === 'texto' || !m.tipo) && (m.direcao === 'in' || m.direcao === 'out'))
      .map(m => ({ role: m.direcao === 'out' ? 'assistant' : 'user', content: m.conteudo || '' }))
      .slice(-contexto);
    if (!msgs.length) return;

    // ---- Limite de respostas por conversa (aba Configurações) ----
    const limite = parseInt(cfg.limite_msgs, 10) || 0;
    if (limite > 0) {
      const jaRespondeu = todas.filter(m => m.direcao === 'out' && m.meta && m.meta.bot).length;
      if (jaRespondeu >= limite) {
        await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ modo: 'humano', nao_lida: true }) });
        await sbFetch('at_mensagens', { method: 'POST', body: JSON.stringify({ conversa_id: conversaId, direcao: 'in', tipo: 'nota',
          conteudo: 'Robô chegou ao limite de ' + limite + ' respostas nesta conversa. Passou pra atendimento humano.', autor: 'Sistema' }) });
        return;
      }
    }

    // ---- Conversa travada (aba Configurações) ----
    // Cliente mandando a MESMA coisa três vezes não está sendo entendido — ou tem outro
    // robô do outro lado. Insistir só queima token e irrita.
    if (cfg.detectar_loop !== false) {
      const entradas = todas.filter(m => m.direcao === 'in').slice(-3).map(m => semAcentoWh(m.conteudo).trim());
      if (entradas.length === 3 && entradas[0] && entradas.every(x => x === entradas[0])) {
        await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ modo: 'humano', nao_lida: true }) });
        await sbFetch('at_mensagens', { method: 'POST', body: JSON.stringify({ conversa_id: conversaId, direcao: 'in', tipo: 'nota',
          conteudo: 'Cliente repetiu a mesma mensagem 3x — o robô não estava resolvendo. Passou pra humano.', autor: 'Sistema' }) });
        return;
      }
    }

    // ---- Marcar como lida no WhatsApp do cliente (aba Configurações) ----
    if (cfg.marcar_lida !== false && ultimaMsgId) {
      try {
        await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: ultimaMsgId })
        });
      } catch (e) { /* tique azul não vale derrubar a resposta */ }
    }

    // chama o cérebro (auth interna via service role)
    const r = await fetch('https://' + host + '/api/chatbot-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal': KEY() },
      body: JSON.stringify({ mensagens: msgs, cliente: { nome: clienteNome }, conversa_id: conversaId })
    });
    let j = {}; try { j = await r.json(); } catch (e) {}

    // O robô não conseguiu responder — crédito da Anthropic acabou, API fora do ar,
    // chave errada. ANTES isto era um `return` mudo: o cliente ficava falando sozinho e
    // a conversa continuava marcada como "bot", então nem entrava na fila de quem atende.
    // Agora a conversa CAI PRA HUMANO na hora. Falha do robô nunca pode virar cliente
    // sem resposta.
    if (!r.ok || !j.reply) {
      console.error('bot sem resposta:', r.status, (j && j.error) || '');
      await sbFetch('at_conversas?id=eq.' + conversaId, {
        method: 'PATCH',
        body: JSON.stringify({ modo: 'humano', nao_lida: true })
      });
      return;
    }

    // envia a resposta pelo WhatsApp
    const to = normalizeWa(waid);
    await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(j.reply) } })
    });
    // grava a resposta do robô e mantém o modo bot
    await sbFetch('at_mensagens', { method: 'POST', body: JSON.stringify({ conversa_id: conversaId, direcao: 'out', tipo: 'texto', conteudo: j.reply, autor: (cfg.nome || 'Assistente'), meta: { bot: true } }) });
    // bot_ultima_em é o relógio do encerramento por inatividade (api/chatbot-encerrar.js).
    await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ modo: 'bot', ultima_msg_preview: String(j.reply).slice(0, 120), ultima_msg_em: new Date().toISOString(), bot_ultima_em: new Date().toISOString(), bot_encerrada_em: null, nao_lida: false }) });
    if (j.handoff) { await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ modo: 'humano', nao_lida: true }) }); }
  } catch (e) { console.error('bot reply erro:', e.message); }
}

export default async function handler(req, res) {
  // 1) Verificação (GET) exigida pela Meta ao configurar o webhook
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'producao-dra-charm.vercel.app';

  // 2) Recebimento (POST). Responder 200 rápido é importante pra Meta não reenviar.
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

    const entries = body?.entry || [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const numeroDestino = value?.metadata?.phone_number_id;
        if (process.env.WA_PHONE_NUMBER_ID && numeroDestino && numeroDestino !== process.env.WA_PHONE_NUMBER_ID) {
          continue;
        }
        const messages = value.messages || [];
        const contatoNome = value.contacts?.[0]?.profile?.name || null;
        for (const m of messages) {
          const waid = m.from;                       // wa_id (telefone do cliente)
          const { tipo, conteudo } = parseMsg(m);
          const cliente = await upsertCliente({ waid, nome: contatoNome, telefone: waid });
          const conversaId = await getOrCreateConversa(cliente.id);

          // 1) GRAVA A MENSAGEM JÁ — garante o recebimento mesmo se o download da mídia demorar/falhar
          let msgId = null;
          try {
            const ins = await sbFetch('at_mensagens', {
              method: 'POST',
              headers: { Prefer: 'return=representation' },
              body: JSON.stringify({
                conversa_id: conversaId, direcao: 'in', tipo, conteudo,
                autor: contatoNome || waid, meta: { wa_id: waid, wamid: m.id },
                enviada_em: new Date(Number(m.timestamp) * 1000 || Date.now()).toISOString()
              })
            });
            msgId = Array.isArray(ins) ? (ins[0] && ins[0].id) : (ins && ins.id);
          } catch (e) { console.error('insert msg:', e.message); }

          await sbFetch('at_conversas?id=eq.' + conversaId, {
            method: 'PATCH',
            body: JSON.stringify({
              nao_lida: true,
              ultima_msg_preview: conteudo.slice(0, 120),
              ultima_msg_em: new Date().toISOString(),
              janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
            })
          });

          // 2) MÍDIA (foto/figurinha/áudio/vídeo/documento): baixa e ANEXA na mensagem já gravada
          const mid = midiaIdTipo(m);
          if (mid && msgId) {
            try {
              const dl = await baixarMidia(mid.id);
              if (dl) {
                await sbFetch('at_mensagens?id=eq.' + msgId, {
                  method: 'PATCH',
                  body: JSON.stringify({ midia_url: dl.url, midia_tipo: mid.tipo })
                });
              }
            } catch (e) { console.error('anexar midia:', e.message); }
          }

          // Foto de perfil (serviço externo, se configurado): busca 1x por cliente, cacheado, best-effort
          try {
            if (process.env.FOTO_API_URL && cliente && !cliente.foto_url) {
              const checked = cliente.foto_checked_at ? new Date(cliente.foto_checked_at).getTime() : 0;
              if (Date.now() - checked > 7 * 24 * 3600 * 1000) {
                const fu = await buscarFotoWhatsApp(waid);
                await sbFetch('at_clientes?id=eq.' + cliente.id, {
                  method: 'PATCH',
                  body: JSON.stringify({ foto_url: fu || null, foto_checked_at: new Date().toISOString() })
                });
              }
            }
          } catch (e) { /* foto é best-effort */ }

          // Chatbot IA: só reage a mensagem de TEXTO do cliente (não figurinha/áudio/etc)
          if (m.type === 'text') {
            await maybeBotReply(conversaId, contatoNome || 'Cliente', conteudo, waid, host, m.id);
            await maybeAusencia(conversaId, waid, contatoNome);
          }
        }
      }
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('whatsapp-webhook erro:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
}
