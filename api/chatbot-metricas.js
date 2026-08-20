// api/chatbot-metricas.js
// Números do robô: desempenho (aba Métricas) e gasto (aba Custos).
//
// GET /api/chatbot-metricas?dias=30&o=metricas
// GET /api/chatbot-metricas?dias=7&o=custos
//
// Por que no servidor:
//  1) at_chatbot_uso tem RLS ligada e NENHUMA política — de propósito, só a API escreve
//     nela. Se a página tentasse ler direto, o PostgREST devolveria lista vazia SEM ERRO
//     e o painel mostraria R$ 0,00 pra sempre (foi exatamente o que aconteceu com o
//     at_disparos_log).
//  2) Contagem tem que ser exata. O PostgREST corta em 1000 linhas, então contar as
//     linhas trazidas mente o número — os cartões da Fila já mostraram "300" porque 300
//     era o limite do fetch, não o total.

async function callerEmail(token){
  if(!token) return null;
  try{
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token }
    });
    const j = await r.json();
    return (j && j.email) ? String(j.email).toLowerCase() : null;
  }catch(e){ return null; }
}

const H = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
});

// O dia é o dia de Fortaleza (UTC-3 fixo, sem horário de verão desde 2019), não o dia em
// UTC. Sem isso "hoje" começaria às 21h de ontem aqui.
const FUSO = '-03:00';
const ini = (dia) => dia + 'T00:00:00.000' + FUSO;
const fim = (dia) => dia + 'T23:59:59.999' + FUSO;
const diaLocal = (ms) => new Date(ms - 3*3600*1000).toISOString().slice(0,10);

async function contar(tabela, filtro){
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + tabela + '?select=id' + (filtro || ''),
    { headers: { ...H(), Prefer: 'count=exact', Range: '0-0' } });
  if(!r.ok) return 0;
  const n = parseInt(String(r.headers.get('content-range') || '').split('/')[1], 10);
  return Number.isFinite(n) ? n : 0;
}

async function paginar(tabela, query){
  let saida = [], desloc = 0;
  while(desloc < 50000){
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + tabela + '?' + query + '&limit=1000&offset=' + desloc,
      { headers: H() });
    if(!r.ok) break;
    let pagina = []; try{ pagina = await r.json(); }catch(e){ break; }
    saida = saida.concat(pagina);
    if(pagina.length < 1000) break;
    desloc += 1000;
  }
  return saida;
}

// Preço por MILHÃO de tokens, em dólar. Se a Anthropic mudar a tabela, é aqui que muda.
// Cache de escrita custa 1,25x a entrada; cache de leitura, 0,10x.
const PRECO = {
  'claude-haiku-4-5-20251001': { in: 1.00, out: 5.00 },
  'gpt-4o-mini':               { in: 0.15, out: 0.60 },
  'gpt-5-mini':                { in: 0.25, out: 2.00 },
  'gpt-5-nano':                { in: 0.05, out: 0.40 }
};
const PADRAO = { in: 1.00, out: 5.00 };

function custoDaLinha(u){
  const p = PRECO[u.modelo] || PADRAO;
  const M = 1e6;
  return ((u.tokens_in      || 0) * p.in
        + (u.tokens_cache_w || 0) * p.in * 1.25
        + (u.tokens_cache_r || 0) * p.in * 0.10
        + (u.tokens_out     || 0) * p.out) / M;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const quem = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if(!quem) return res.status(403).json({ error: 'Sessão inválida. Faça login na suíte.' });

  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 92);
  const hoje = diaLocal(Date.now());
  const de   = diaLocal(Date.now() - (dias - 1) * 86400000);
  const janela = '&created_at=gte.' + ini(de) + '&created_at=lte.' + fim(hoje);

  try{
    const uso = await paginar('at_chatbot_uso',
      'select=conversa_id,modelo,tokens_in,tokens_out,tokens_cache_w,tokens_cache_r,handoff,erro,created_at'
      + janela + '&order=created_at.asc');

    // ---------- CUSTOS ----------
    if(String(req.query.o || '') === 'custos'){
      const bons = uso.filter(u => !u.erro);
      let total = 0, tIn = 0, tOut = 0, tCw = 0, tCr = 0;
      const porDia = {}, porModelo = {};

      bons.forEach(u => {
        const c = custoDaLinha(u);
        total += c;
        tIn += u.tokens_in || 0; tOut += u.tokens_out || 0;
        tCw += u.tokens_cache_w || 0; tCr += u.tokens_cache_r || 0;
        const d = diaLocal(new Date(u.created_at).getTime());
        porDia[d] = (porDia[d] || 0) + c;
        const m = u.modelo || '—';
        porModelo[m] = porModelo[m] || { modelo: m, respostas: 0, custo: 0 };
        porModelo[m].respostas++; porModelo[m].custo += c;
      });

      // Quanto o cache economizou: o que essas leituras custariam se fossem entrada cheia.
      const economiaCache = bons.reduce((s, u) => {
        const p = PRECO[u.modelo] || PADRAO;
        return s + ((u.tokens_cache_r || 0) * p.in * 0.90) / 1e6;
      }, 0);

      const diasComDado = Object.keys(porDia).length || 1;
      return res.status(200).json({
        periodo: { de, ate: hoje, dias },
        respostas: bons.length,
        erros: uso.length - bons.length,
        custoTotal: total,
        custoPorResposta: bons.length ? total / bons.length : 0,
        mediaDiaria: total / diasComDado,
        projecaoMes: (total / diasComDado) * 30,
        economiaCache,
        tokens: { entrada: tIn, saida: tOut, cacheGravado: tCw, cacheLido: tCr },
        porModelo: Object.values(porModelo).sort((a,b) => b.custo - a.custo),
        porDia: Object.entries(porDia).map(([dia, custo]) => ({ dia, custo })).sort((a,b) => a.dia < b.dia ? -1 : 1),
        semDados: uso.length === 0
      });
    }

    // ---------- MÉTRICAS ----------
    const respostas = uso.filter(u => !u.erro).length;
    const transferidas = uso.filter(u => u.handoff).length;
    const conversas = new Set(uso.map(u => u.conversa_id).filter(Boolean));

    const porDia = {};
    uso.forEach(u => {
      const d = diaLocal(new Date(u.created_at).getTime());
      porDia[d] = porDia[d] || { dia: d, respostas: 0, transferencias: 0 };
      if(!u.erro) porDia[d].respostas++;
      if(u.handoff) porDia[d].transferencias++;
    });

    // Quanto tempo o robô segurou a conversa antes de passar (ou de acabar).
    const porConversa = {};
    uso.forEach(u => {
      if(!u.conversa_id) return;
      const t = new Date(u.created_at).getTime();
      const c = porConversa[u.conversa_id] = porConversa[u.conversa_id] || { ini: t, fim: t, n: 0 };
      c.ini = Math.min(c.ini, t); c.fim = Math.max(c.fim, t); c.n++;
    });
    const sessoes = Object.values(porConversa);
    const duracoes = sessoes.map(s => s.fim - s.ini).filter(ms => ms > 0);
    const duracaoMediaMin = duracoes.length
      ? Math.round(duracoes.reduce((a,b) => a+b, 0) / duracoes.length / 60000) : 0;

    // Quantas conversas de gente existiram no período, pra saber a fatia do robô.
    const conversasNoPeriodo = await contar('at_conversas', janela);

    return res.status(200).json({
      periodo: { de, ate: hoje, dias },
      respostas,
      conversas: conversas.size,
      conversasNoPeriodo,
      fatia: conversasNoPeriodo ? conversas.size / conversasNoPeriodo : 0,
      transferidas,
      taxaTransferencia: conversas.size ? transferidas / conversas.size : 0,
      resolvidasSozinho: Math.max(conversas.size - transferidas, 0),
      respostasPorConversa: conversas.size ? respostas / conversas.size : 0,
      duracaoMediaMin,
      erros: uso.filter(u => u.erro).length,
      porDia: Object.values(porDia).sort((a,b) => a.dia < b.dia ? -1 : 1),
      semDados: uso.length === 0
    });
  }catch(e){
    return res.status(500).json({ error: 'Falha ao montar os números: ' + (e && e.message) });
  }
}
