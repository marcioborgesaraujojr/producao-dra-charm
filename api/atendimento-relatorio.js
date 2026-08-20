// api/atendimento-relatorio.js
// Números da central de atendimento, no formato dos "Relatórios de atendimento" do
// Notificações Inteligentes: total de mensagens, total de atendimentos, clientes atendidos,
// tempo médio de atendimento e o desempenho por operador — sempre comparando com o período
// anterior de mesmo tamanho.
//
// GET /api/atendimento-relatorio?de=2026-08-13&ate=2026-08-19
//
// Por que no servidor: contar no navegador significaria baixar dezenas de milhares de
// linhas (e o PostgREST corta em 1000, então o número sairia errado — foi o que acontecia
// no relatório antigo, que lia 2000 conversas e chamava aquilo de "total").

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

// Conta sem baixar as linhas: Prefer: count=exact + o total no header content-range.
async function contar(tabela, filtro){
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + tabela + '?select=id' + (filtro || ''),
    { headers: { ...H(), Prefer: 'count=exact', Range: '0-0' } });
  if(!r.ok) return 0;
  const n = parseInt(String(r.headers.get('content-range') || '').split('/')[1], 10);
  return Number.isFinite(n) ? n : 0;
}

async function buscar(tabela, query){
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + tabela + '?' + query, { headers: H() });
  if(!r.ok) return [];
  try{ return await r.json(); }catch(e){ return []; }
}

// "Atendimento" = conversa em que o CLIENTE falou. Conversa aberta só por automação
// (aviso de pedido pago, enviado…) não conta — foi o que inflou o dia 19/08 com 1.192
// "atendimentos" quando o normal são ~20/dia.
async function conversasComEntrada(deISO, ateISO){
  const porConversa = new Map();     // conversa_id -> dia da primeira entrada
  let desloc = 0;
  while(desloc < 40000){
    const pagina = await buscar('at_mensagens',
      'select=conversa_id,enviada_em&direcao=eq.in&enviada_em=gte.' + deISO + '&enviada_em=lte.' + ateISO
      + '&order=enviada_em.asc&limit=1000&offset=' + desloc);
    pagina.forEach(m => {
      if(!m.conversa_id) return;
      const dia = new Date(new Date(m.enviada_em).getTime() - 3*3600*1000).toISOString().slice(0,10);
      if(!porConversa.has(m.conversa_id)) porConversa.set(m.conversa_id, dia);
    });
    if(pagina.length < 1000) break;
    desloc += 1000;
  }
  return porConversa;
}

const dias = (de, ate) => {
  const out = [];
  const d = new Date(de + 'T00:00:00Z'), fim = new Date(ate + 'T00:00:00Z');
  while(d <= fim && out.length < 92){ out.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
};
// O dia é o dia DE FORTALEZA (UTC-3, sem horário de verão desde 2019), não o dia em UTC.
// Sem isso, "hoje" começava às 21h do dia anterior aqui — o relatório mostrava 1 hora de
// movimento e chamava aquilo de dia inteiro.
const FUSO = '-03:00';
const ini = (dia) => dia + 'T00:00:00.000' + FUSO;
const fim = (dia) => dia + 'T23:59:59.999' + FUSO;
const hojeLocal = () => new Date(Date.now() - 3*3600*1000).toISOString().slice(0,10);

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const quem = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if(!quem) return res.status(403).json({ error: 'Sessão inválida. Faça login na suíte.' });

  const hoje = hojeLocal();
  const ate = String(req.query.ate || hoje).slice(0,10);
  const de  = String(req.query.de  || new Date(Date.now() - 3*3600*1000 - 6*86400000).toISOString().slice(0,10)).slice(0,10);

  const lista = dias(de, ate);
  if(!lista.length) return res.status(400).json({ error: 'Período inválido.' });

  // Período anterior do MESMO tamanho, colado no começo deste.
  const passo = lista.length;
  const anteriorAte = new Date(new Date(de + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0,10);
  const anteriorDe  = new Date(new Date(anteriorAte + 'T00:00:00Z').getTime() - (passo-1)*86400000).toISOString().slice(0,10);

  const janela = (campo, d1, d2) => '&' + campo + '=gte.' + ini(d1) + '&' + campo + '=lte.' + fim(d2);

  try{
    // ---- totais do período e do anterior ----
    const [
      msgsTotal, msgsIn, msgsOut, msgsAnterior,
      clientesTotal, clientesAnterior
    ] = await Promise.all([
      contar('at_mensagens',  janela('enviada_em', de, ate)),
      contar('at_mensagens',  janela('enviada_em', de, ate) + '&direcao=eq.in'),
      contar('at_mensagens',  janela('enviada_em', de, ate) + '&direcao=eq.out'),
      contar('at_mensagens',  janela('enviada_em', anteriorDe, anteriorAte)),
      contar('at_clientes',   janela('created_at', de, ate)),
      contar('at_clientes',   janela('created_at', anteriorDe, anteriorAte))
    ]);

    // ---- quem realmente foi atendido (o cliente falou) ----
    const atendMapa   = await conversasComEntrada(ini(de), fim(ate));
    const atendAntMap = await conversasComEntrada(ini(anteriorDe), fim(anteriorAte));
    const atendIds    = [...atendMapa.keys()];
    const porDiaAtend = {};
    atendMapa.forEach(dia => { porDiaAtend[dia] = (porDiaAtend[dia] || 0) + 1; });

    // ---- por dia ----
    const porDia = await Promise.all(lista.map(async d => ({
      dia: d,
      recebidas: await contar('at_mensagens', janela('enviada_em', d, d) + '&direcao=eq.in'),
      enviadas:  await contar('at_mensagens', janela('enviada_em', d, d) + '&direcao=eq.out'),
      atendimentos: porDiaAtend[d] || 0
    })));

    // ---- conversas do período, para tempo médio e desempenho por operador ----
    // Paginado porque o PostgREST devolve no máximo 1000 por vez.
    let conversas = [];
    for(let i = 0; i < atendIds.length && i < 6000; i += 100){
      const bloco = atendIds.slice(i, i + 100);
      const pagina = await buscar('at_conversas',
        'select=id,status,atendente_id,created_at,ultima_msg_em&id=in.(' + bloco.join(',') + ')&limit=200');
      conversas = conversas.concat(pagina);
    }

    const duracoes = conversas
      .filter(c => c.status === 'encerrada' && c.created_at && c.ultima_msg_em)
      .map(c => new Date(c.ultima_msg_em) - new Date(c.created_at))
      .filter(ms => ms > 0);
    const duracaoMediaMin = duracoes.length
      ? Math.round(duracoes.reduce((a,b) => a+b, 0) / duracoes.length / 60000)
      : null;

    const perfis = await buscar('profiles', 'select=id,full_name,email&order=full_name');
    const nomeDe = {}; (perfis || []).forEach(p => { nomeDe[p.id] = p.full_name || p.email || '—'; });

    const porOperador = {};
    conversas.forEach(c => {
      const k = c.atendente_id || '__sem__';
      porOperador[k] = porOperador[k] || { operador: k === '__sem__' ? 'Não atribuído' : (nomeDe[k] || 'Operador'), atribuidas: 0, resolvidas: 0, ativas: 0 };
      porOperador[k].atribuidas++;
      if(c.status === 'encerrada') porOperador[k].resolvidas++; else porOperador[k].ativas++;
    });
    const operadores = Object.values(porOperador).sort((a,b) => b.atribuidas - a.atribuidas);

    return res.status(200).json({
      periodo: { de, ate, dias: passo },
      anterior: { de: anteriorDe, ate: anteriorAte },
      mensagens: { total: msgsTotal, recebidas: msgsIn, enviadas: msgsOut, anterior: msgsAnterior },
      atendimentos: {
        total: atendMapa.size,
        anterior: atendAntMap.size,
        resolvidas: conversas.filter(c => c.status === 'encerrada').length
      },
      clientes: { total: clientesTotal, anterior: clientesAnterior },
      duracaoMediaMin,
      amostraConversas: conversas.length,
      criterio: 'atendimento = conversa em que o cliente enviou pelo menos uma mensagem no período',
      porDia,
      operadores
    });
  }catch(e){
    return res.status(500).json({ error: 'Falha ao montar o relatório: ' + (e && e.message) });
  }
}
