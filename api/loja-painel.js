// api/loja-painel.js
// Dados das telas de dentro de cada loja (Eventos, Relatórios, Leads).
// Uma chamada só, com ?aba= dizendo o que buscar. Usa a service role por baixo,
// então não depende de RLS — mas exige o Bearer de quem está logado na suíte.
//
// GET (Bearer) ?loja=loja_integrada|troquecommerce&aba=resumo|eventos|relatorio|leads
//   &dias=7            (relatorio)
//   &q=texto           (eventos/leads)
//   &evento=codigo     (eventos)

const SB  = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY() }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
  return Array.isArray(data) ? data : [];
}

// o PostgREST corta em 1000 linhas por resposta. Quando a gente precisa das linhas
// (e não só do total), tem que ir buscando de mil em mil com o header Range.
async function sbTudo(path, teto) {
  teto = teto || 20000;
  const passo = 1000;
  const saida = [];
  for (let ini = 0; ini < teto; ini += passo) {
    const fim = ini + passo - 1;
    let lote = [];
    try {
      const r = await fetch(SB() + '/rest/v1/' + path, {
        headers: {
          apikey: KEY(), Authorization: 'Bearer ' + KEY(),
          Range: ini + '-' + fim, 'Range-Unit': 'items'
        }
      });
      const txt = await r.text();
      try { lote = JSON.parse(txt); } catch (e) { lote = []; }
      if (!Array.isArray(lote)) lote = [];
    } catch (e) { lote = []; }
    saida.push(...lote);
    if (lote.length < passo) break;
  }
  return saida;
}

// o PostgREST corta em 1000 linhas, então contagem tem que vir do content-range
async function contar(path) {
  try {
    const r = await fetch(SB() + '/rest/v1/' + path + '&select=id&limit=1', {
      headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), Prefer: 'count=exact' }
    });
    const cr = r.headers.get('content-range') || '';
    const n = Number(String(cr).split('/')[1]);
    return isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}

async function callerEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB() + '/auth/v1/user', { headers: { apikey: KEY(), Authorization: 'Bearer ' + token } });
    const j = await r.json();
    return j && j.email ? String(j.email) : null;
  } catch (e) { return null; }
}

// os códigos de evento que pertencem a esta loja (pra filtrar o log de disparos,
// que guarda só o evento_key, sem a loja)
async function codigosDaLoja(loja) {
  const g = await sb('at_gatilhos?loja=eq.' + encodeURIComponent(loja) + '&select=evento_code,li_codigo,evento_nome,ativo,template_name');
  return g;
}

// O log de disparos guarda a chave que o webhook usou: na Loja Integrada é a
// situação dela (li_codigo); na TroqueCommerce é o nosso evento_code. Então o
// filtro tem que aceitar os dois.
function chavesDeLog(gatilhos) {
  const s = new Set();
  gatilhos.forEach(g => { if (g.evento_code) s.add(g.evento_code); if (g.li_codigo) s.add(g.li_codigo); });
  return [...s];
}

function diaISO(d) { return new Date(d).toISOString().slice(0, 10); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });

  const q     = req.query || {};
  const loja  = String(q.loja || 'loja_integrada');
  const aba   = String(q.aba || 'resumo');
  const busca = String(q.q || '').trim().toLowerCase();
  const dias  = Math.min(90, Math.max(1, Number(q.dias) || 7));
  const desde = new Date(Date.now() - dias * 86400000).toISOString();

  try {
    const gatilhos = await codigosDaLoja(loja);
    const codigos = chavesDeLog(gatilhos);
    const nomeDoCodigo = {};
    gatilhos.forEach(g => {
      const nome = g.evento_nome || g.evento_code;
      if (g.evento_code) nomeDoCodigo[g.evento_code] = nome;
      if (g.li_codigo) nomeDoCodigo[g.li_codigo] = nome;
    });

    // ---------- RESUMO ----------
    if (aba === 'resumo') {
      const ev24 = await contar('loja_eventos?loja=eq.' + loja + '&created_at=gte.' +
        encodeURIComponent(new Date(Date.now() - 86400000).toISOString()));
      const ult = await sb('loja_eventos?loja=eq.' + loja +
        '&select=evento_codigo,evento_label,cliente_nome,pedido,cliente_telefone,created_at&order=created_at.desc&limit=12');

      let enviados = 0, erros = 0;
      if (codigos.length) {
        const inCod = '(' + codigos.map(c => '"' + c + '"').join(',') + ')';
        const base = 'at_disparos_log?evento_key=in.' + encodeURIComponent(inCod) +
          '&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 86400000).toISOString());
        // conta direto no banco: passar de 1000 disparos em 24h é normal por aqui
        enviados = await contar(base + '&status=eq.enviado');
        erros    = await contar(base + '&status=eq.erro');
      }
      return res.status(200).json({
        ok: true,
        eventos24h: ev24, enviados24h: enviados, erros24h: erros,
        gatilhosLigados: gatilhos.filter(g => g.ativo).length, gatilhosTotal: gatilhos.length,
        ultimos: ult
      });
    }

    // ---------- EVENTOS ----------
    if (aba === 'eventos') {
      let path = 'loja_eventos?loja=eq.' + loja +
        '&select=id,evento_codigo,evento_label,cliente_nome,cliente_telefone,cliente_email,pedido,created_at' +
        '&order=created_at.desc&limit=200';
      if (q.evento) path += '&evento_codigo=eq.' + encodeURIComponent(String(q.evento));
      let linhas = await sb(path);
      if (busca) {
        linhas = linhas.filter(l => [l.cliente_nome, l.pedido, l.cliente_telefone, l.evento_label]
          .some(v => String(v || '').toLowerCase().includes(busca)));
      }
      const tipos = {};
      linhas.forEach(l => { tipos[l.evento_codigo] = (tipos[l.evento_codigo] || 0) + 1; });
      return res.status(200).json({ ok: true, linhas, tipos, nomeDoCodigo });
    }

    // ---------- RELATÓRIO ----------
    if (aba === 'relatorio') {
      if (!codigos.length) return res.status(200).json({ ok: true, porDia: [], porEvento: [], total: 0 });
      const inCod = '(' + codigos.map(c => '"' + c + '"').join(',') + ')';
      const log = await sbTudo('at_disparos_log?evento_key=in.' + encodeURIComponent(inCod) +
        '&created_at=gte.' + encodeURIComponent(desde) +
        '&select=evento_key,status,created_at&order=created_at.desc');

      const dia = {}, evt = {};
      log.forEach(l => {
        const d = diaISO(l.created_at);
        dia[d] = dia[d] || { dia: d, enviado: 0, erro: 0, outro: 0 };
        evt[l.evento_key] = evt[l.evento_key] || { evento: l.evento_key, nome: nomeDoCodigo[l.evento_key] || l.evento_key, enviado: 0, erro: 0, outro: 0 };
        const campo = l.status === 'enviado' ? 'enviado' : (l.status === 'erro' ? 'erro' : 'outro');
        dia[d][campo]++; evt[l.evento_key][campo]++;
      });
      return res.status(200).json({
        ok: true, total: log.length,
        porDia: Object.values(dia).sort((a, b) => a.dia < b.dia ? 1 : -1),
        porEvento: Object.values(evt).sort((a, b) => (b.enviado + b.erro) - (a.enviado + a.erro))
      });
    }

    // ---------- LEADS (só quem veio desta loja) ----------
    if (aba === 'leads') {
      const ev = await sbTudo('loja_eventos?loja=eq.' + loja +
        '&select=cliente_nome,cliente_telefone,cliente_email,pedido,evento_label,created_at' +
        '&order=created_at.desc', 20000);
      const porTel = new Map();
      ev.forEach(e => {
        const tel = String(e.cliente_telefone || '').trim();
        if (!tel) return;
        const ja = porTel.get(tel);
        if (!ja) {
          porTel.set(tel, {
            telefone: tel, nome: e.cliente_nome || '', email: e.cliente_email || '',
            ultimoEvento: e.evento_label || '', ultimoPedido: e.pedido || '',
            visto: e.created_at, desde: e.created_at, eventos: 1
          });
        } else {
          ja.eventos++;
          if (!ja.nome && e.cliente_nome) ja.nome = e.cliente_nome;
          if (!ja.email && e.cliente_email) ja.email = e.cliente_email;
          if (e.created_at < ja.desde) ja.desde = e.created_at;
        }
      });
      let leads = [...porTel.values()];
      if (busca) {
        leads = leads.filter(l => [l.nome, l.telefone, l.email, l.ultimoPedido]
          .some(v => String(v || '').toLowerCase().includes(busca)));
      }
      leads.sort((a, b) => a.visto < b.visto ? 1 : -1);
      return res.status(200).json({ ok: true, total: porTel.size, leads: leads.slice(0, 300) });
    }

    return res.status(400).json({ error: 'aba desconhecida' });
  } catch (e) {
    return res.status(500).json({ error: e && e.message });
  }
}
