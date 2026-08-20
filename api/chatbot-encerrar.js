// api/chatbot-encerrar.js
// Encerra o atendimento do robô em conversas que ficaram paradas.
// Roda de cron (vercel.json), de 10 em 10 minutos.
//
// Por que precisa existir: o robô responde e o cliente some. Sem isso, a conversa fica
// eternamente em "modo bot" — atrapalha a contagem de sessão, atrapalha a espera de
// reentrada e dá a impressão, pra quem olha a Central, de que tem robô atendendo alguém
// que foi embora faz três dias.
//
// Regras (aba Atendimento do chatbot.html):
//   inatividade_min  = minutos de silêncio até encerrar. 0 = nunca encerra.
//   msg_encerramento = texto mandado pro cliente ao encerrar. Vazio = encerra calado.
//
// NUNCA toca em conversa que tem atendente ou que já está em modo humano.

const GRAPH = 'https://graph.facebook.com/v20.0';
const SB  = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + JSON.stringify(data));
  return data;
}

export default async function handler(req, res) {
  // Chamada pelo cron da Vercel, ou manualmente com ?forcar=1 pra testar.
  try {
    const rows = await sbFetch('at_chatbot?id=eq.1&select=inatividade_min,msg_encerramento,nome,ativo');
    const cfg = Array.isArray(rows) ? rows[0] : rows;
    const limite = parseInt(cfg && cfg.inatividade_min, 10) || 0;
    if (!cfg || limite <= 0) return res.status(200).json({ ok: true, encerradas: 0, motivo: 'encerramento desligado' });

    const corte = new Date(Date.now() - limite * 60 * 1000).toISOString();

    // Conversa em modo robô, sem atendente, parada há mais tempo que o limite e ainda
    // não encerrada.
    const alvos = await sbFetch(
      'at_conversas?modo=eq.bot&atendente_id=is.null&bot_encerrada_em=is.null'
      + '&bot_ultima_em=lt.' + encodeURIComponent(corte)
      + '&select=id,cliente_id,bot_ultima_em&limit=200'
    );
    if (!Array.isArray(alvos) || !alvos.length) return res.status(200).json({ ok: true, encerradas: 0 });

    const texto = String((cfg.msg_encerramento || '')).trim();
    let avisadas = 0;

    for (const cv of alvos) {
      // Aviso pro cliente (opcional). Só dentro da janela de 24h do WhatsApp — fora dela
      // a Meta exige template, e mandar template pra dizer "vou encerrar" seria gastar
      // conversa paga pra falar sozinho.
      if (texto && process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID) {
        try {
          const cli = await sbFetch('at_clientes?id=eq.' + cv.cliente_id + '&select=whatsapp_id');
          const waid = Array.isArray(cli) && cli[0] ? cli[0].whatsapp_id : null;
          const dentroDaJanela = Date.now() - new Date(cv.bot_ultima_em).getTime() < 24 * 3600 * 1000;
          if (waid && dentroDaJanela) {
            await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
              body: JSON.stringify({ messaging_product: 'whatsapp', to: waid, type: 'text', text: { body: texto } })
            });
            await sbFetch('at_mensagens', {
              method: 'POST',
              body: JSON.stringify({ conversa_id: cv.id, direcao: 'out', tipo: 'texto', conteudo: texto,
                autor: (cfg.nome || 'Assistente'), meta: { bot: true, encerramento: true } })
            });
            avisadas++;
          }
        } catch (e) { console.error('encerrar/aviso', cv.id, e.message); }
      }

      /* Marca como RESOLVIDA junto. Antes a conversa ficava num limbo: o robô já tinha
         soltado, ninguém tinha assumido, e ela seguia "não resolvida" e lida — ou seja,
         invisível pra equipe e aberta pra sempre. Com 1.700 conversas, ninguém ia fechar
         na mão.
         Só chega aqui quem o robô estava atendendo (modo=bot) e ninguém assumiu — ou seja,
         ele nunca achou que precisava de gente. Se a cliente voltar a escrever, a
         conversa reabre sozinha (ver getOrCreateConversa no webhook), então fechar aqui
         não perde ninguém. */
      await sbFetch('at_conversas?id=eq.' + cv.id, {
        method: 'PATCH',
        /* bot_teste_lote volta a null: a vaga do modo teste é DEVOLVIDA ao encerrar.
           Sem isto, o lote de 50 encheu de conversa morta e o robô ficou 4h sem atender
           ninguém — as 50 vagas estavam ocupadas por conversas encerradas por inatividade,
           e conversa nova nenhuma conseguia entrar. Foi assim que a coisa apareceu:
           "tava setado em 50, tentei colocar 100 e não consegui". */
        body: JSON.stringify({ modo: null, bot_encerrada_em: new Date().toISOString(), status: 'encerrada', bot_teste_lote: null })
      });
      await sbFetch('at_mensagens', {
        method: 'POST',
        body: JSON.stringify({ conversa_id: cv.id, direcao: 'in', tipo: 'nota',
          conteudo: 'Atendimento do robô encerrado por ' + limite + ' min sem resposta do cliente.', autor: 'Sistema' })
      });
    }

    return res.status(200).json({ ok: true, encerradas: alvos.length, avisadas, limite });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
