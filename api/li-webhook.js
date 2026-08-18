// api/li-webhook.js
// Recebe o WEBHOOK NATIVO da Loja Integrada (tipo "pedido_venda") e dispara a
// notificação do WhatsApp pelo gatilho correspondente em at_gatilhos.
//
// Confirmado no payload real da loja Dra. Charm:
//   {
//     tipo: "pedido_venda", numero: 248888, cliente_obs: "...",
//     cliente: { nome, email, telefone_celular, cpf },
//     envios: [{ objeto, prazo, forma_envio }],
//     situacao: { id:4, codigo:"pedido_pago", nome:"Pedido Pago",
//                 aprovado:true, cancelado:false, final:false,
//                 situacao_alterada:true }
//   }
// O campo situacao_alterada é o ouro: só é true quando o status MUDOU de verdade.
// Sem ele a loja reenvia o mesmo pedido várias vezes e o cliente levaria mensagem
// repetida.
//
// Env vars no Vercel (o Marcio cadastra; NUNCA no código):
//   LI_WEBHOOK_TOKEN                        (segredo embutido na URL)
//   WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID     (WhatsApp oficial, já existem)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (já existem)
//   DISPARO_SECO=1                          (opcional: MODO SECO - não envia, só registra)
//
// GET  ?config=1  (Bearer da suíte) -> URL do webhook, últimos eventos, códigos não mapeados
// GET             (sem nada)        -> 200 "ok"  (ping de saúde da Loja Integrada)
// POST ?token=... -> processa 1 evento

import { createHash } from 'crypto';

const GRAPH = 'https://graph.facebook.com/v20.0';
const SB    = () => process.env.SUPABASE_URL;
const KEY   = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

// O segredo da URL nasce sozinho: é um resumo (sha256) da chave de serviço que
// já existe no Vercel. Assim ninguém precisa cadastrar variável nova, e esse
// resumo NÃO permite voltar pra chave original. Se um dia quiser trocar o
// segredo, é só cadastrar LI_WEBHOOK_TOKEN que ele passa a valer.
function tokenWebhook() {
  if (process.env.LI_WEBHOOK_TOKEN) return process.env.LI_WEBHOOK_TOKEN;
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base) return null;
  return 'li_' + createHash('sha256').update(base + '::li-webhook::v1').digest('hex').slice(0, 32);
}

// Modo seco fica no BANCO (sys_config.disparo_seco), pra dar pra ligar e
// desligar pelo painel sem mexer no Vercel.
let _secoCache = { v: true, em: 0 };
async function modoSeco() {
  if (Date.now() - _secoCache.em < 30000) return _secoCache.v;
  let v = true;                                   // padrão: SECO (não envia)
  try {
    const r = await sb('sys_config?chave=eq.disparo_seco&select=valor&limit=1');
    const row = Array.isArray(r.data) ? r.data[0] : null;
    if (row) v = ['1','true','sim'].includes(String(row.valor).toLowerCase());
  } catch (e) { v = true; }
  _secoCache = { v, em: Date.now() };
  return v;
}

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

// Brasil / 9º dígito (mesma regra do resto do sistema)
function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.length <= 11 && !n.startsWith('55')) n = '55' + n;
  if (n.startsWith('55') && n.length === 12) n = '55' + n.slice(2, 4) + '9' + n.slice(4);
  return n;
}

// Tira os dados que interessam do payload da Loja Integrada
function lerPedido(b) {
  const sit  = (b && b.situacao) || {};
  const cli  = (b && b.cliente)  || {};
  const env  = Array.isArray(b && b.envios) && b.envios.length ? b.envios[0] : {};
  const tel  = cli.telefone_celular || cli.telefone_principal || cli.telefone_comercial || '';
  return {
    codigo:    String(sit.codigo || '').trim(),
    rotulo:    String(sit.nome || sit.codigo || '').trim(),
    mudou:     sit.situacao_alterada === true,
    aprovado:  sit.aprovado === true,
    cancelado: sit.cancelado === true,
    numero:    b && b.numero != null ? String(b.numero) : '',
    nome:      String(cli.nome || '').trim(),
    primeiro:  String(cli.nome || '').trim().split(/\s+/)[0] || 'tudo bem',
    email:     cli.email || null,
    waid:      normalizeWa(tel),
    rastreio:  env.objeto || '',
    prazo:     env.prazo != null ? String(env.prazo) : '',
    valor:     b && b.valor_total != null ? String(b.valor_total) : '',
    obs:       b && b.cliente_obs ? String(b.cliente_obs) : ''
  };
}

async function acharOuCriarConversa(waid, nome) {
  const c = await sb('at_clientes?on_conflict=whatsapp_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ whatsapp_id: waid, nome: nome || 'Cliente', telefone: waid })
  });
  const cli = Array.isArray(c.data) ? c.data[0] : c.data;
  if (!cli || !cli.id) return null;
  const f = await sb('at_conversas?cliente_id=eq.' + cli.id + '&status=neq.encerrada&select=id&order=ultima_msg_em.desc&limit=1');
  if (Array.isArray(f.data) && f.data.length) return f.data[0].id;
  const nv = await sb('at_conversas', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ cliente_id: cli.id, canal: 'loja', status: 'aberta', nao_lida: true, ultima_msg_em: new Date().toISOString() })
  });
  const conv = Array.isArray(nv.data) ? nv.data[0] : nv.data;
  return conv && conv.id ? conv.id : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};

  // ===== CONFIG (tela de Automações) =====
  if (req.method === 'GET' && q.config) {
    const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
    if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });

    const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
    const tk   = tokenWebhook();

    const ev = await sb('loja_eventos?loja=eq.loja_integrada&select=evento_codigo,evento_label,cliente_nome,pedido,created_at&order=created_at.desc&limit=40');
    const recentes = Array.isArray(ev.data) ? ev.data : [];

    const gt = await sb('at_gatilhos?loja=eq.loja_integrada&select=evento_code,evento_nome,li_codigo,ativo,template_name');
    const gatilhos = Array.isArray(gt.data) ? gt.data : [];
    const mapeados = new Set(gatilhos.map(g => g.li_codigo).filter(Boolean));

    // códigos que a loja mandou e que ninguém mapeou ainda
    const naoMapeados = [...new Set(recentes.map(r => r.evento_codigo).filter(c => c && !mapeados.has(c)))];

    return res.status(200).json({
      url: tk ? (base + '/api/li-webhook?token=' + tk) : null,
      configurado: !!tk,
      wa_ok: !!(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID),
      modo_seco: await modoSeco(),
      recentes, naoMapeados
    });
  }

  // ping de saúde
  if (req.method === 'GET') return res.status(200).send('ok');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // ===== ligar/desligar o MODO SECO pelo painel (precisa estar logado) =====
  if (q.seco !== undefined) {
    const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
    if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });
    const valor = ['1','true','sim'].includes(String(q.seco).toLowerCase()) ? '1' : '0';
    await sb('sys_config?on_conflict=chave', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ chave: 'disparo_seco', valor })
    });
    _secoCache = { v: valor === '1', em: Date.now() };
    try {
      await sb('sys_audit_log', { method: 'POST', body: JSON.stringify({
        actor_email: email, tabela: 'sys_config', operacao: 'UPDATE',
        registro_id: 'disparo_seco', dados_depois: { modo_seco: valor === '1' } }) });
    } catch (e) {}
    return res.status(200).json({ ok: true, modo_seco: valor === '1' });
  }

  const tk = tokenWebhook();
  if (!tk) return res.status(503).json({ error: 'Faltam as variáveis do Supabase no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // A loja pode devolver o token de três jeitos: na URL, num header ou no corpo.
  // Aceita qualquer um — o que não pode é aceitar sem token nenhum.
  const tokenRecebido =
    q.token ||
    req.headers['x-webhook-token'] || req.headers['x-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
    body.token || null;
  if (tokenRecebido !== tk) return res.status(401).json({ error: 'token inválido' });

  // Daqui pra baixo NUNCA devolvemos erro: se a gente responder != 2xx a Loja
  // Integrada reenvia o evento e o cliente leva mensagem repetida.
  try {
    if (String(body.tipo || '') !== 'pedido_venda') {
      return res.status(200).json({ received: true, ignorado: 'tipo ' + (body.tipo || '?') });
    }

    const p = lerPedido(body);

    // registra SEMPRE (serve de histórico e pra descobrir códigos novos)
    await sb('loja_eventos', {
      method: 'POST',
      body: JSON.stringify({
        loja: 'loja_integrada', evento_codigo: p.codigo, evento_label: p.rotulo,
        cliente_nome: p.nome, cliente_telefone: p.waid || null, cliente_email: p.email,
        pedido: p.numero || null, payload: body
      })
    });

    // 1) só reage quando a situação MUDOU
    if (!p.mudou) return res.status(200).json({ received: true, resultado: 'sem mudança de situação' });
    if (!p.codigo) return res.status(200).json({ received: true, resultado: 'sem código de situação' });

    // 2) tem gatilho ligado pra essa situação?
    const gr = await sb('at_gatilhos?loja=eq.loja_integrada&li_codigo=eq.' + encodeURIComponent(p.codigo) + '&select=*');
    const g = Array.isArray(gr.data) ? gr.data[0] : null;
    if (!g)        return res.status(200).json({ received: true, resultado: 'situação sem gatilho: ' + p.codigo });
    if (!g.ativo)  return res.status(200).json({ received: true, resultado: 'gatilho desligado' });
    if (!p.waid)   return res.status(200).json({ received: true, resultado: 'cliente sem telefone' });

    // 3) não repete o mesmo aviso em 12h
    const desde = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const dup = await sb('at_disparos_log?evento_key=eq.' + encodeURIComponent(p.codigo) +
      '&pedido=eq.' + encodeURIComponent(p.numero) + '&telefone=eq.' + p.waid +
      '&status=eq.enviado&created_at=gte.' + encodeURIComponent(desde) + '&select=id&limit=1');
    if (Array.isArray(dup.data) && dup.data.length) {
      return res.status(200).json({ received: true, resultado: 'já avisado (12h)' });
    }

    // 4) monta os parâmetros do template
    let aviso = 'Assim que enviarmos, você recebe o código de rastreio por aqui.';
    try {
      const av = await sb('sys_config?chave=eq.disparo_aviso&select=valor&limit=1');
      const r0 = Array.isArray(av.data) ? av.data[0] : null;
      if (r0 && r0.valor) aviso = String(r0.valor);
    } catch (e) {}

    const fonte = {
      nome: p.primeiro, nome_completo: p.nome, pedido: p.numero,
      rastreio: p.rastreio || '-', prazo: p.prazo || '-', valor: p.valor || '-',
      loja: 'Dra. Charm', aviso
    };
    const mapa = Array.isArray(g.template_mapa) ? g.template_mapa : [];
    const params = mapa.map(k => { const v = fonte[k]; return (v == null || v === '') ? '-' : String(v); });

    if (!g.template_name) {
      await sb('at_disparos_log', { method: 'POST', body: JSON.stringify({
        evento_key: p.codigo, telefone: p.waid, pedido: p.numero || null,
        status: 'erro', detalhe: 'gatilho ligado mas sem template aprovado', payload: fonte }) });
      return res.status(200).json({ received: true, resultado: 'sem template escolhido' });
    }

    // 5) MODO SECO: registra o que enviaria, sem enviar
    const seco = await modoSeco();
    if (seco || !process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
      await sb('at_disparos_log', { method: 'POST', body: JSON.stringify({
        evento_key: p.codigo, telefone: p.waid, pedido: p.numero || null,
        template_name: g.template_name, status: 'simulado',
        detalhe: seco ? 'modo seco ligado' : 'whatsapp não configurado', payload: { params, fonte } }) });
      return res.status(200).json({ received: true, resultado: 'simulado', params });
    }

    // 6) envia de verdade
    const template = { name: g.template_name, language: { code: g.template_language || 'pt_BR' } };
    if (params.length) template.components = [{ type: 'body', parameters: params.map(x => ({ type: 'text', text: x })) }];

    let ok = false, erro = null, wamid = null;
    try {
      const r = await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: p.waid, type: 'template', template })
      });
      const j = await r.json();
      if (r.ok) { ok = true; wamid = (j.messages && j.messages[0] && j.messages[0].id) || null; }
      else erro = (j.error && j.error.message) || ('erro ' + r.status);
    } catch (e) { erro = e.message; }

    // 7) deixa a marca na conversa do cliente (best effort)
    try {
      const conversaId = await acharOuCriarConversa(p.waid, p.nome);
      if (conversaId) {
        let texto = g.mensagem || ('[modelo: ' + g.template_name + ']');
        params.forEach((x, i) => { texto = texto.replace(new RegExp('\\{\\{\\s*' + (i + 1) + '\\s*\\}\\}', 'g'), x); });
        const nota = ok ? texto : ('Falhou o aviso "' + g.evento_nome + '" do pedido ' + p.numero + ': ' + erro);
        await sb('at_mensagens', { method: 'POST', body: JSON.stringify({
          conversa_id: conversaId, direcao: ok ? 'out' : 'in', tipo: ok ? 'template' : 'nota',
          conteudo: nota, autor: 'Automação · Loja Integrada',
          meta: { gatilho: g.evento_code, situacao: p.codigo, pedido: p.numero } }) });
        await sb('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({
          ultima_msg_preview: nota.slice(0, 120), ultima_msg_em: new Date().toISOString(),
          janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }) });
      }
    } catch (e) { /* nota é bônus, não pode derrubar o disparo */ }

    await sb('at_disparos_log', { method: 'POST', body: JSON.stringify({
      evento_key: p.codigo, telefone: p.waid, pedido: p.numero || null,
      template_name: g.template_name, status: ok ? 'enviado' : 'erro',
      detalhe: erro, wamid, payload: { params, fonte } }) });

    return res.status(200).json({ received: true, resultado: ok ? 'enviado' : 'erro', detalhe: erro });

  } catch (err) {
    console.error('li-webhook erro:', err && err.message);
    return res.status(200).json({ received: true, error: err && err.message });
  }
}
