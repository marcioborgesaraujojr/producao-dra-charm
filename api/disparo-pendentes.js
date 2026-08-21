// api/disparo-pendentes.js — manda os avisos que ficaram SEGURADOS por falta de rastreio.
//
// Por que existe: a Loja Integrada avisa "pedido enviado" antes de gravar o código de
// rastreio. Em 20/08, 175 dos 552 avisos de despacho saíram com "Código de rastreio: -" —
// um traço no lugar do código. O li-webhook agora segura esses casos com
// status 'aguardando_rastreio'; este cron reconsulta a Loja Integrada e manda assim que o
// código aparece (de 8 pedidos avisados com traço na véspera, 6 já tinham código no dia
// seguinte).
//
// Depois de LIMITE_HORAS sem código, manda mesmo assim, mas apontando o Cadê Meu Pedido em
// vez de mostrar um traço: melhor mandar onde consultar do que não avisar que despachou.
//
// Roda pelo cron do vercel.json. Também aceita chamada manual com o Bearer da suíte.

import { buscarPedidoLI } from '../lib/li-pedido.js';
import { mandarTemplate, textoDoTemplate } from '../lib/disparo-envio.js';

const SB  = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

const LIMITE_HORAS = 12;     // depois disso, manda sem esperar mais
const JANELA_HORAS = 48;     // não fica remoendo pendência antiga pra sempre
const SEM_CODIGO   = 'consulte em dracharm.cademeupedido.com.br';

async function sb(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

async function modoSeco() {
  try {
    const r = await sb('sys_config?chave=eq.disparo_modo_seco&select=valor&limit=1');
    const v = Array.isArray(r.data) && r.data[0] ? r.data[0].valor : null;
    return v === true || v === 'true' || v === '1';
  } catch (e) { return false; }
}

// Só ACHA conversa que já existe — cron não inventa conversa no Atendimento.
async function acharConversa(waid) {
  try {
    const c = await sb('at_clientes?select=id&whatsapp_id=eq.' + encodeURIComponent(waid) + '&limit=1');
    const cli = Array.isArray(c.data) ? c.data[0] : null;
    if (!cli) return null;
    const cv = await sb('at_conversas?select=id&cliente_id=eq.' + cli.id + '&order=ultima_msg_em.desc.nullslast&limit=1');
    return Array.isArray(cv.data) && cv.data[0] ? cv.data[0].id : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  // cron da Vercel entra sem Authorization; chamada manual precisa do Bearer da suíte
  const auth = String(req.headers.authorization || '');
  const daVercel = String(req.headers['user-agent'] || '').includes('vercel-cron')
    || req.headers['x-vercel-cron'] != null;
  if (!daVercel && !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'não autorizado' });
  }

  try {
    if (!SB() || !KEY()) return res.status(200).json({ ok: true, resultado: 'supabase não configurado' });

    const desde = new Date(Date.now() - JANELA_HORAS * 3600 * 1000).toISOString();
    const r = await sb('at_disparos_log?status=eq.aguardando_rastreio&created_at=gte.'
      + encodeURIComponent(desde) + '&select=*&order=created_at.asc&limit=60');
    const pend = Array.isArray(r.data) ? r.data : [];
    if (!pend.length) return res.status(200).json({ ok: true, pendentes: 0, enviados: 0 });

    const seco = await modoSeco();
    if (seco) return res.status(200).json({ ok: true, pendentes: pend.length, enviados: 0, resultado: 'modo seco ligado' });

    let enviados = 0, semCodigo = 0, erros = 0;

    for (const linha of pend) {
      const d = linha.payload || {};
      const params = Array.isArray(d.params) ? d.params.slice() : [];
      const idx = Array.isArray(d.idxRastreio) ? d.idxRastreio : [];
      if (!linha.template_name || !linha.telefone || !idx.length) {
        await sb('at_disparos_log?id=eq.' + linha.id, { method: 'PATCH',
          body: JSON.stringify({ status: 'descartado', detalhe: 'pendência sem dados pra reenviar' }) });
        continue;
      }

      let codigo = '';
      try {
        const p = await buscarPedidoLI(linha.pedido);
        if (p && p.ok && p.pedido && p.pedido.codigo_rastreio) codigo = String(p.pedido.codigo_rastreio);
      } catch (e) { /* segue: sem código, decide pelo tempo */ }

      const horas = (Date.now() - new Date(linha.created_at).getTime()) / 3600000;
      if (!codigo && horas < LIMITE_HORAS) { semCodigo++; continue; }   // espera mais um pouco

      const valor = codigo || SEM_CODIGO;
      idx.forEach(i => { params[i] = valor; });

      const env = await mandarTemplate({
        waid: linha.telefone, template_name: linha.template_name,
        template_language: d.template_language, params
      });
      if (!env.ok) {
        erros++;
        await sb('at_disparos_log?id=eq.' + linha.id, { method: 'PATCH',
          body: JSON.stringify({ status: 'erro', detalhe: 'ao mandar o aviso segurado: ' + env.erro }) });
        continue;
      }
      enviados++;

      // marca na conversa, igual o li-webhook faz
      try {
        const cid = await acharConversa(linha.telefone);
        if (cid) {
          const nota = textoDoTemplate(d.mensagem || ('[modelo: ' + linha.template_name + ']'), params);
          await sb('at_mensagens', { method: 'POST', body: JSON.stringify({
            conversa_id: cid, direcao: 'out', tipo: 'template', conteudo: nota,
            autor: 'Automação · Loja Integrada',
            meta: { gatilho: d.evento_code, situacao: linha.evento_key, pedido: linha.pedido, segurado: true } }) });
          const patch = { ultima_msg_em: new Date().toISOString(),
                          janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString() };
          if (linha.pedido) patch.pedido_numero = String(linha.pedido);
          await sb('at_conversas?id=eq.' + cid, { method: 'PATCH', body: JSON.stringify(patch) });
          // prévia só quando a conversa está LIDA — não apaga da lista a pergunta de quem espera
          await sb('at_conversas?id=eq.' + cid + '&nao_lida=is.false', { method: 'PATCH',
            body: JSON.stringify({ ultima_msg_preview: nota.slice(0, 120) }) });
        }
      } catch (e) { /* nota é bônus */ }

      await sb('at_disparos_log?id=eq.' + linha.id, { method: 'PATCH', body: JSON.stringify({
        status: 'enviado', wamid: env.wamid,
        detalhe: codigo ? ('segurado ' + horas.toFixed(1) + 'h até o código sair')
                        : ('mandado sem código depois de ' + horas.toFixed(1) + 'h') }) });
    }

    return res.status(200).json({ ok: true, pendentes: pend.length, enviados, aindaSemCodigo: semCodigo, erros });
  } catch (err) {
    console.error('disparo-pendentes erro:', err && err.message);
    return res.status(200).json({ ok: false, error: err && err.message });
  }
}
