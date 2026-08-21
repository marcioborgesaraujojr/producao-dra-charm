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

/* ===== O BLING SÃO 3 REQUISIÇÕES POR SEGUNDO =====
   Descoberto testando em produção, e é o tipo de erro que passaria batido: pedindo os 4
   tamanhos de um produto de uma vez, os 3 primeiros voltaram certos (184, 156, 192) e o
   quarto veio vazio. Sozinho, esse quarto respondia normalmente. Não era SKU errado, era
   429 — 4 chamadas em 829ms dá 4,8/s. E o código antigo fazia `if (!r.ok) continue`, ou
   seja, engolia o 429 em silêncio e devolvia um saldo a menos como se fosse resposta boa.

   Duas correções: uma pausa entre as chamadas, e um teto baixo de quantas fazer. */
const PAUSA_MS = 350;                              // ~2,9 req/s, com folga pro limite

/* Quais tamanhos vale a pena conferir, já que dá pra conferir poucos.
   O retrato só mente onde o saldo é pequeno: se de madrugada tinha 155 peças, não acabou
   até a tarde. O risco está nos extremos — pouca peça (pode ter acabado) e zero (pode ter
   chegado reposição). Medido em 21/08: das 1.094 variações ativas, 32 têm de 1 a 3 peças.
   Um tamanho com saldo alto não entra na fila: gastaria a chamada à toa. */
function porRisco(t) {
  const s = Number(t && t.saldo);
  if (!Number.isFinite(s)) return 0;
  if (s > 0 && s <= 5) return 0;                   // "tem" pode ter virado mentira: primeiro
  if (s === 0) return 1;                           // "não tem" pode ter virado mentira
  return 2;                                        // saldo folgado: não precisa conferir
}

/**
 * Confere no Bling, AGORA, o saldo de tamanhos específicos.
 * Recebe [{sku, saldo}] (o saldo do retrato, usado só pra escolher o que conferir).
 * Devolve Map sku(minúsculo) -> saldo, ou null. NUNCA lança e NUNCA passa do teto de tempo.
 */
export async function saldoAoVivo(tamanhos, { max = 3, msTotal = 3000 } = {}) {
  try {
    const vistos = new Set();
    const fila = (tamanhos || [])
      .map(t => (typeof t === 'string' ? { sku: t, saldo: null } : t))
      .filter(t => t && t.sku && !vistos.has(String(t.sku).toLowerCase()) && vistos.add(String(t.sku).toLowerCase()))
      .map(t => ({ ...t, risco: porRisco(t) }))
      .filter(t => t.risco < 2)                    // saldo folgado nem entra na fila
      .sort((a, b) => a.risco - b.risco)
      .slice(0, max);
    if (!fila.length) return null;

    const token = await tokenDoCache();
    if (!token) return null;                       // cache frio: quem chamou usa o retrato

    const ate = Date.now() + msTotal;
    const mapa = new Map();
    for (let i = 0; i < fila.length; i++) {
      if (i) {
        const espera = Math.min(PAUSA_MS, ate - Date.now());
        if (espera > 0) await new Promise(r => setTimeout(r, espera));
      }
      const resta = ate - Date.now();
      if (resta < 500) break;                      // acabou o tempo: devolve o que já tem
      const sku = fila[i].sku;
      const r = await blingGet('/produtos?codigo=' + encodeURIComponent(sku) + '&limite=2', token, Math.min(resta, 2200));
      if (!r.ok) {
        /* 429 quer dizer "vai devagar", não "não existe". Insistir aqui só piora o limite
           e ainda segura a cliente: para tudo e usa o retrato pro resto. */
        if (r.status === 429) break;
        continue;
      }
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
