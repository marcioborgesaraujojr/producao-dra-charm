// lib/disparo-envio.js — mandar um modelo aprovado pelo WhatsApp.
//
// Existe pra ter UM lugar só fazendo a chamada da Meta. Quem manda aviso automático são
// dois: o api/li-webhook.js (na hora que a Loja Integrada avisa) e o api/disparo-pendentes.js
// (o que segurou por falta de código de rastreio e manda depois). Se cada um tivesse a sua
// cópia, o dia que a Meta mudasse alguma coisa a gente ia consertar um e esquecer o outro.

const GRAPH = 'https://graph.facebook.com/v20.0';

/**
 * Manda o template. NUNCA lança: quem chama está no meio de um webhook ou de um cron,
 * e falha de envio precisa virar linha de log, não erro 500.
 * Devolve { ok, wamid, erro }.
 */
export async function mandarTemplate({ waid, template_name, template_language, params }) {
  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
    return { ok: false, wamid: null, erro: 'whatsapp não configurado' };
  }
  const template = { name: template_name, language: { code: template_language || 'pt_BR' } };
  const lista = Array.isArray(params) ? params : [];
  if (lista.length) {
    template.components = [{ type: 'body', parameters: lista.map(x => ({ type: 'text', text: String(x) })) }];
  }
  try {
    const r = await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: waid, type: 'template', template })
    });
    const j = await r.json();
    if (r.ok) return { ok: true, wamid: (j.messages && j.messages[0] && j.messages[0].id) || null, erro: null };
    return { ok: false, wamid: null, erro: (j.error && j.error.message) || ('erro ' + r.status) };
  } catch (e) {
    return { ok: false, wamid: null, erro: e.message };
  }
}

/* O modelo tem {{1}}, {{2}}... e a gente guarda o texto dele em at_gatilhos.mensagem pra
   mostrar na conversa o que a cliente recebeu. Trocar na mão em dois arquivos dava
   divergência: aqui é um lugar só. */
export function textoDoTemplate(modelo, params) {
  let t = String(modelo || '');
  (params || []).forEach((x, i) => {
    t = t.replace(new RegExp('\\{\\{\\s*' + (i + 1) + '\\s*\\}\\}', 'g'), String(x));
  });
  return t;
}
