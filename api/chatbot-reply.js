// api/chatbot-reply.js
// Cérebro do chatbot de IA — AGNÓSTICO: funciona com OpenAI (GPT) ou Anthropic (Claude).
// Escolhe o provedor pela chave que estiver no Vercel e pelo modelo configurado.
//
// Env no Vercel (basta UMA das chaves de IA):
//   OPENAI_API_KEY       -> usa GPT (ex.: gpt-4o-mini)  [mais fácil/barato]
//   ANTHROPIC_API_KEY    -> usa Claude (ex.: claude-haiku)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (já existem)
//
// Auth: Bearer da suíte (painel de teste) OU header x-internal = SERVICE_ROLE_KEY (chamada do webhook).
// Body: { mensagens: [{role:'user'|'assistant', content:'...'}], cliente?: {nome}, conversa_id? }
// Retorno: { reply, handoff:boolean }

async function callerEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token }
    });
    const j = await r.json(); return j && j.email ? String(j.email) : null;
  } catch (e) { return null; }
}
const SB = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
});
async function tabela(caminho){
  try{
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + caminho, { headers: SB() });
    if(!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  }catch(e){ return []; }
}
// Perguntas/respostas e intenções ficam em tabela (igual ao Notificações), não espremidas
// num campo de texto. Se as tabelas ainda não existirem, volta lista vazia e o bot segue.
const getFaq       = () => tabela('at_chatbot_faq?ativo=eq.true&select=pergunta,resposta&order=ordem,id&limit=300');
const getIntencoes = () => tabela('at_chatbot_intencoes?ativo=eq.true&select=nome,comportamento,acao&order=ordem,id&limit=100');

async function getConfig() {
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/at_chatbot?id=eq.1&select=*', {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  const j = await r.json(); return Array.isArray(j) && j[0] ? j[0] : {};
}
const MARCA_TRANSFERIR = '[TRANSFERIR]';

function montarSystem(cfg, cliente, faq, intencoes) {
  let s = cfg.persona || 'Você é uma atendente virtual simpática e objetiva. Responda em português do Brasil.';
  if (cfg.nome) s = 'Seu nome é ' + cfg.nome + (cfg.cargo ? (', ' + cfg.cargo) : '') + '.\n' + s;

  if (cfg.base_conhecimento && cfg.base_conhecimento.trim())
    s += '\n\nBASE DE CONHECIMENTO (use quando útil):\n' + cfg.base_conhecimento;

  if (faq && faq.length){
    s += '\n\nPERGUNTAS FREQUENTES — use estas respostas como verdade. Pode reescrever com suas palavras, mas não invente nada diferente:\n'
       + faq.map((f, i) => (i+1) + '. P: ' + f.pergunta + '\n   R: ' + f.resposta).join('\n');
  }

  if (intencoes && intencoes.length){
    s += '\n\nSITUAÇÕES QUE VOCÊ NÃO RESOLVE. Se a mensagem do cliente se encaixar em uma delas, NÃO tente resolver e NÃO peça mais detalhes: '
       + 'responda uma única frase curta dizendo que vai passar para um atendente humano, e comece a resposta com ' + MARCA_TRANSFERIR + '.\n'
       + intencoes.map((it, i) => (i+1) + '. ' + it.nome + ' — ' + it.comportamento).join('\n');
  }

  const sites = String(cfg.sites_permitidos || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  if (sites.length){
    s += '\n\nLINKS: só envie links destes endereços: ' + sites.join(', ')
       + '. Escreva sempre o endereço completo, começando com https://. Nunca invente, encurte nem corte um link. '
       + 'Se não tiver um link válido dessa lista, explique sem link.';
  }

  if (cliente && cliente.nome) s += '\n\nO cliente se chama ' + cliente.nome + ' (use o primeiro nome quando fizer sentido).';
  s += '\n\nSeja breve. Responda em UMA mensagem.';
  return s;
}

// Tira links de domínios que não estão liberados, em vez de mandar o cliente pra qualquer
// lugar que o modelo inventar. É a "verificação de links" do Notificações.
function limparLinks(texto, cfg){
  const permitidos = String(cfg.sites_permitidos || '').split(/[\n,;]+/).map(x => x.trim().toLowerCase()
    .replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*$/,'')).filter(Boolean);
  if(!permitidos.length) return texto;
  return String(texto).replace(/https?:\/\/[^\s)]+/gi, (url) => {
    const host = url.replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('/')[0].toLowerCase();
    return permitidos.some(d => host === d || host.endsWith('.' + d)) ? url : '';
  }).replace(/[ \t]{2,}/g, ' ');
}

async function viaOpenAI(cfg, mensagens, cliente, faq, intencoes) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Na OpenAI o cache é automático acima de 1.024 tokens, desde que o trecho fixo venha
      // primeiro — e vem: o system é a primeira mensagem e não muda entre as chamadas.
      model: cfg.modelo || 'gpt-4o-mini',
      messages: [{ role: 'system', content: montarSystem(cfg, cliente, faq, intencoes) }, ...mensagens],
      temperature: 0.5, max_tokens: 400
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Erro OpenAI');
  return j.choices?.[0]?.message?.content || '';
}
async function viaAnthropic(cfg, mensagens, cliente, faq, intencoes) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.modelo && cfg.modelo.startsWith('claude') ? cfg.modelo : 'claude-haiku-4-5-20251001',
      // CACHE DE PROMPT: o system é idêntico em toda mensagem (persona + FAQ + intenções,
      // ~5 mil tokens). Sem cache, ele é cobrado inteiro a cada resposta. Marcado assim,
      // a releitura custa 10% — no volume de ~25 mil mensagens/mês isso corta ~70% da conta.
      system: [{ type: 'text', text: montarSystem(cfg, cliente, faq, intencoes), cache_control: { type: 'ephemeral' } }],
      max_tokens: 400,
      messages: mensagens.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Erro Anthropic');
  return (j.content && j.content[0] && j.content[0].text) || '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-internal');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // Auth: chamada interna do webhook (service role) OU sessão da suíte (painel de teste)
  const interno = req.headers['x-internal'] && req.headers['x-internal'] === process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!interno) {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const email = await callerEmail(token);
    if (!email) return res.status(403).json({ error: 'Sessão inválida. Faça login na suíte.' });
  }

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const mensagens = Array.isArray(body.mensagens) ? body.mensagens.slice(-12) : [];
  const cliente = body.cliente || null;
  if (!mensagens.length) return res.status(400).json({ error: 'Envie "mensagens".' });

  const [cfg, faq, intencoes] = await Promise.all([getConfig(), getFaq(), getIntencoes()]);
  const usaClaude = (cfg.modelo || '').startsWith('claude');
  const temOpenAI = !!process.env.OPENAI_API_KEY;
  const temAnthropic = !!process.env.ANTHROPIC_API_KEY;

  try {
    let reply;
    if (usaClaude && temAnthropic) reply = await viaAnthropic(cfg, mensagens, cliente, faq, intencoes);
    else if (temOpenAI) reply = await viaOpenAI(cfg, mensagens, cliente, faq, intencoes);
    else if (temAnthropic) reply = await viaAnthropic(cfg, mensagens, cliente, faq, intencoes);
    else return res.status(503).json({ error: 'Chatbot não configurado: falta OPENAI_API_KEY ou ANTHROPIC_API_KEY no Vercel.' });

    // Transferência: por palavra-chave (barata, antes da IA) OU porque o modelo reconheceu
    // uma das intenções e marcou a resposta. A marca some do texto que vai pro cliente.
    const termos = (cfg.handoff_termos || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const ultima = (mensagens[mensagens.length - 1].content || '').toLowerCase();
    const porTermo = termos.some(t => t && ultima.includes(t));
    const porIntencao = String(reply).includes(MARCA_TRANSFERIR);
    reply = limparLinks(String(reply).split(MARCA_TRANSFERIR).join('').trim(), cfg);

    return res.status(200).json({ reply, handoff: porTermo || porIntencao, motivo: porIntencao ? 'intencao' : (porTermo ? 'palavra-chave' : null) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
