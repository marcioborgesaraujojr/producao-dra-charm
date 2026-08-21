// lib/bling.js — falar com o Bling de dentro do caminho de resposta ao cliente.
//
// POR QUE ISTO NÃO RENOVA O TOKEN, E ISSO É O PONTO PRINCIPAL DO ARQUIVO:
//
// O OAuth do Bling ROTACIONA o refresh token: a cada renovação ele devolve um novo e
// invalida o anterior. O api/estoque-sync.js já cuida disso, e faz certo — guarda o novo
// no Edge Config. Só que hoje quem renova é UM cron por dia. Se o robô passasse a renovar
// também, cinco clientes escrevendo ao mesmo tempo com o cache frio seriam cinco
// renovações simultâneas: a primeira rotaciona, as outras quatro ficam com um refresh
// token morto na mão — e aí não cai só o robô, cai a integração inteira do Bling
// (estoque diário, pedidos). Um enfeite no atendimento derrubaria o financeiro.
//
// Então a regra aqui é dura: este arquivo LÊ o access token do cache e nada mais.
// Se o cache estiver frio, ele devolve null e quem chamou usa o retrato do dia.
// Quem mantém o cache quente é o cron do api/bling-token.js, que é o único renovador.

const GRAPH = 'https://api.bling.com.br/Api/v3';

function parseEC() {
  try {
    const u = new URL(process.env.EDGE_CONFIG || '');
    const ecId = u.pathname.replace(/^\//, '');
    const token = u.searchParams.get('token');
    return ecId && token ? { ecId, token } : null;
  } catch (e) { return null; }
}

/* O mesmo formato que o estoque-sync grava: {token, expires}. Só leitura. */
export async function tokenDoCache(msLimite = 2500) {
  const ec = parseEC();
  if (!ec) return null;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), msLimite);
  try {
    const r = await fetch('https://edge-config.vercel.com/' + ec.ecId + '/item/bling_access_cache?token=' + ec.token,
      { signal: c.signal });
    if (!r.ok) return null;
    const raw = await r.json();
    if (!raw) return null;
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    /* 60s de folga: um token que vence enquanto a chamada está no ar vira 401 e o
       cliente é quem espera o erro. */
    if (p && p.token && p.expires && Date.now() < p.expires - 60000) return p.token;
    return null;
  } catch (e) {
    return null;
  } finally { clearTimeout(t); }
}

export async function blingGet(caminho, token, msLimite = 4000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), msLimite);
  try {
    const r = await fetch(GRAPH + caminho, { headers: { Authorization: 'Bearer ' + token }, signal: c.signal });
    const d = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data: d };
  } catch (e) {
    return { ok: false, status: 0, data: null, erro: e.message };
  } finally { clearTimeout(t); }
}

/* O saldo que o Bling chama de "virtual" é o que a loja enxerga (físico menos reservado).
   É o mesmo campo que a varredura diária usa, então ao vivo e retrato falam a mesma língua. */
function saldoDe(p) {
  const e = p && p.estoque;
  if (!e) return null;
  const v = e.saldoVirtualTotal != null ? e.saldoVirtualTotal : e.saldoFisicoTotal;
  return v == null ? null : Number(v);
}

/**
 * Confere no Bling, AGORA, o saldo de SKUs específicos.
 * Devolve um Map sku(minúsculo) -> saldo, ou null quando não deu (cache frio, Bling
 * fora do ar, formato inesperado). NUNCA lança e NUNCA demora mais que o teto.
 *
 * Limite de SKUs de propósito: são 3 req/s no Bling e isto roda com a cliente esperando.
 */
export async function saldoAoVivo(skus, { max = 6, msTotal = 3500 } = {}) {
  try {
    const lista = [...new Set((skus || []).map(s => String(s || '').trim()).filter(Boolean))].slice(0, max);
    if (!lista.length) return null;

    const token = await tokenDoCache();
    if (!token) return null;                       // cache frio: quem chamou usa o retrato

    const ate = Date.now() + msTotal;
    const mapa = new Map();
    for (const sku of lista) {
      const resta = ate - Date.now();
      if (resta < 600) break;                      // acabou o tempo: devolve o que já tem
      const r = await blingGet('/produtos?codigo=' + encodeURIComponent(sku) + '&limite=2', token, Math.min(resta, 2500));
      if (!r.ok) continue;
      const arr = (r.data && r.data.data) || [];
      /* codigo=... é filtro, não busca exata garantida: só aceita o que bate igual. */
      const achado = arr.find(p => String(p.codigo || '').toLowerCase() === sku.toLowerCase());
      const s = saldoDe(achado);
      if (s != null) mapa.set(sku.toLowerCase(), s);
    }
    return mapa.size ? mapa : null;
  } catch (e) {
    return null;
  }
}
