// api/chatbot-reply.js
// Cérebro do chatbot de IA — AGNÓSTICO: funciona com OpenAI (GPT) ou Anthropic (Claude).
// Escolhe o provedor pela chave que estiver no Vercel e pelo modelo configurado.
//
// Env no Vercel (basta UMA das chaves de IA):
//   OPENAI_API_KEY       -> usa GPT (ex.: gpt-4o-mini)  [mais fácil/barato]
//   ANTHROPIC_API_KEY    -> usa Claude (ex.: claude-haiku)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (já existem)
//
// A chave da Anthropic vem do MESMO lugar que o Assistente IA usa (lib/licfg.js:
// Edge Config e, se não houver, process.env). Antes este arquivo lia só process.env, então
// se a chave estivesse no Edge Config o chatbot dizia "não configurado" mesmo com o
// Assistente funcionando.
//
// Auth: Bearer da suíte (painel de teste) OU header x-internal = SERVICE_ROLE_KEY (chamada do webhook).
// Body: { mensagens: [{role:'user'|'assistant', content:'...'}], cliente?: {nome}, conversa_id? }
// Retorno: { reply, handoff:boolean }

import { getAnthropicKey } from '../lib/licfg.js';

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

  // Isto aqui é WhatsApp, não é chat de site. Escrever como gente é parte da resposta certa.
  s += '\n\nCOMO ESCREVER:\n'
     + '- Você está no WhatsApp. Negrito é com UM asterisco (*assim*), nunca dois. Nada de Markdown, título ou tabela.\n'
     + '- Responda curto: 2 a 4 linhas. Se precisar de mais, é porque o caso é de gente, não seu.\n'
     + '- No máximo UM emoji na mensagem, e só quando couber. Sem emoji também está ótimo.\n'
     + '- Não termine toda mensagem com "Posso te ajudar com mais alguma coisa?". Só pergunte se fizer sentido.\n'
     + '- Escreva como uma pessoa do atendimento escreveria, não como propaganda. Sem CAPS pra dar ênfase.\n'
     + '\nO QUE VOCÊ NÃO PODE FAZER — isto é mais importante que parecer prestativa:\n'
     + '- NUNCA invente regra, prazo, política, preço ou endereço de página. Se a resposta exata não estiver '
     + 'no seu treinamento, diga com naturalidade que vai confirmar com o time e ' + MARCA_TRANSFERIR + '.\n'
     + '- Só escreva links que existam no seu treinamento. Não monte caminho novo (nada de inventar /buscar?q=...).\n'
     + '- Não diga que algo "não é possível" se ninguém te disse isso. Não saber e não poder são coisas diferentes.\n'
     + '- Nunca se contradiga na mesma mensagem: se vai passar pra uma pessoa, não afirme antes que não tem jeito.';
  return s;
}

/* O modelo escreve em Markdown — negrito com DOIS asteriscos. O WhatsApp usa UM.
   Resultado: a cliente lia literalmente "**gratuita**", "**Motoboy**", "**(85) 98701-5980**".
   Toda resposta chegava suja de asterisco, e isso sozinho já faz parecer robô.

   Pedir no prompt pra não usar Markdown ajuda, mas o modelo esquece. Aqui a gente
   converte na saída, que é garantia — não esperança. */
function paraWhatsApp(texto){
  return String(texto || '')
    .replace(/\*\*\*(.+?)\*\*\*/gs, '*$1*')      // ***forte*** -> *forte*
    .replace(/\*\*(.+?)\*\*/gs,     '*$1*')      // **negrito**  -> *negrito*
    .replace(/__(.+?)__/gs,         '*$1*')      // __negrito__  -> *negrito*
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, '$1: $2')  // [texto](link) -> texto: link
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // títulos de Markdown não existem no WhatsApp
    .replace(/^\s{0,3}[-*]\s+/gm,   '• ')        // lista vira bolinha de verdade
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Tira links de domínios que não estão liberados, em vez de mandar o cliente pra qualquer
   lugar que o modelo inventar. É a "verificação de links" do Notificações.

   ATENÇÃO — aqui morava um bug que fazia o robô parecer burro.
   O recorte pegava tudo que não fosse espaço, então a pontuação e a marcação coladas no
   FIM do endereço entravam junto:

     "**https://dracharm.troque.app.br**"  -> domínio virava "dracharm.troque.app.br**"
     "https://dracharm.troque.app.br."     -> domínio virava "dracharm.troque.app.br."

   Domínio corrompido não batia com a lista, e o link CERTO era apagado. A cliente
   recebeu "Acesse ** informe os dados do seu pedido" — frase quebrada, sem endereço.
   E como o modelo põe o link em negrito ou termina a frase com ponto quase sempre, o
   robô praticamente NUNCA conseguia entregar o link da troca ou do provador. Ele sabia
   a resposta certa e ela chegava mutilada.

   Agora a pontuação/marcação do fim é separada antes de conferir o domínio, e volta pro
   texto depois. Só o endereço proibido some. */
function limparLinks(texto, cfg){
  const permitidos = String(cfg.sites_permitidos || '').split(/[\n,;]+/).map(x => x.trim().toLowerCase()
    .replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*$/,'')).filter(Boolean);
  if(!permitidos.length) return texto;

  return String(texto)
    .replace(/https?:\/\/[^\s<>]+/gi, (bruto) => {
      const m = bruto.match(/[)\]}>.,;:!?'"*_]+$/);      // rabo colado no fim
      const rabo = m ? m[0] : '';
      const url  = rabo ? bruto.slice(0, -rabo.length) : bruto;
      const host = url.replace(/^https?:\/\//i,'').replace(/^www\./i,'').split(/[\/?#]/)[0].toLowerCase();
      const liberado = permitidos.some(d => host === d || host.endsWith('.' + d));
      return liberado ? (url + rabo) : '';               // proibido: some o link E o rabo dele
    })
    // sobra de negrito de um link que foi removido — sem isso fica "Acesse ** informe"
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/(^|[\s(])\*\*(?=[\s.,;:!?)]|$)/g, '$1')
    .replace(/\[\s*\]\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1');
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
  return {
    texto: j.choices?.[0]?.message?.content || '',
    uso: {
      tokens_in:      (j.usage?.prompt_tokens || 0) - (j.usage?.prompt_tokens_details?.cached_tokens || 0),
      tokens_out:     j.usage?.completion_tokens || 0,
      tokens_cache_w: 0,
      tokens_cache_r: j.usage?.prompt_tokens_details?.cached_tokens || 0
    }
  };
}
async function viaAnthropic(cfg, mensagens, cliente, faq, intencoes, chave) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': chave || process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
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
  return {
    texto: (j.content && j.content[0] && j.content[0].text) || '',
    uso: {
      tokens_in:      j.usage?.input_tokens || 0,
      tokens_out:     j.usage?.output_tokens || 0,
      tokens_cache_w: j.usage?.cache_creation_input_tokens || 0,
      tokens_cache_r: j.usage?.cache_read_input_tokens || 0
    }
  };
}

// Registra o consumo de cada resposta. É o que alimenta a aba Custos — sem isso o painel
// só saberia CHUTAR o gasto em cima do número de mensagens, e o cache faria a conta real
// e o chute divergirem muito.
async function registrarUso(linha) {
  try {
    await fetch(process.env.SUPABASE_URL + '/rest/v1/at_chatbot_uso', {
      method: 'POST',
      headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(linha)
    });
  } catch (e) { /* medir o gasto nunca pode derrubar a resposta ao cliente */ }
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
  const cliente = body.cliente || null;
  const conversaId = body.conversa_id || null;

  const [cfg, faq, intencoes] = await Promise.all([getConfig(), getFaq(), getIntencoes()]);

  // Quantas mensagens anteriores ele lê — ajustável na aba Configurações. Era 12 fixo.
  const contexto = Math.min(Math.max(parseInt(cfg.contexto_msgs, 10) || 12, 2), 40);
  const mensagens = Array.isArray(body.mensagens) ? body.mensagens.slice(-contexto) : [];
  if (!mensagens.length) return res.status(400).json({ error: 'Envie "mensagens".' });

  const usaClaude = (cfg.modelo || '').startsWith('claude');
  const chaveAnthropic = await getAnthropicKey();
  const temOpenAI = !!process.env.OPENAI_API_KEY;
  const temAnthropic = !!chaveAnthropic;
  const modeloUsado = cfg.modelo || (temOpenAI ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001');

  try {
    let saida;
    if (usaClaude && temAnthropic) saida = await viaAnthropic(cfg, mensagens, cliente, faq, intencoes, chaveAnthropic);
    else if (temOpenAI) saida = await viaOpenAI(cfg, mensagens, cliente, faq, intencoes);
    else if (temAnthropic) saida = await viaAnthropic(cfg, mensagens, cliente, faq, intencoes, chaveAnthropic);
    else return res.status(503).json({ error: 'Chatbot não configurado: falta OPENAI_API_KEY ou ANTHROPIC_API_KEY no Vercel.' });
    let reply = saida.texto;

    // Transferência: por palavra-chave (barata, antes da IA) OU porque o modelo reconheceu
    // uma das intenções e marcou a resposta. A marca some do texto que vai pro cliente.
    const termos = (cfg.handoff_termos || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const ultima = (mensagens[mensagens.length - 1].content || '').toLowerCase();
    const porTermo = termos.some(t => t && ultima.includes(t));
    const porIntencao = String(reply).includes(MARCA_TRANSFERIR);
    reply = paraWhatsApp(limparLinks(String(reply).split(MARCA_TRANSFERIR).join('').trim(), cfg));
    const handoff = porTermo || porIntencao;

    await registrarUso({ conversa_id: conversaId, modelo: modeloUsado, handoff, ...saida.uso });

    return res.status(200).json({ reply, handoff, motivo: porIntencao ? 'intencao' : (porTermo ? 'palavra-chave' : null) });
  } catch (err) {
    // A falha também vira linha: é assim que se descobre que o crédito acabou olhando o painel.
    await registrarUso({ conversa_id: conversaId, modelo: modeloUsado, erro: String(err.message).slice(0, 300) });
    return res.status(400).json({ error: err.message });
  }
}
