// lib/estoque.js — o que TEM em estoque, pra cliente que pergunta "tem na cor lilás?".
//
// Por que existe: medindo 586 conversas de 19 e 20/08, "produto / estoque / cor / modelo" é
// 27% do motivo do contato — de longe o maior. E era justamente onde o robô era mais fraco:
// respondia mandando o link de busca do site, o que empurra o trabalho de volta pra cliente.
//
// O dado já existia e ninguém estava usando: o api/estoque-sync.js grava todo dia às 07:30
// um retrato do catálogo no Storage — 233 produtos com SALDO POR TAMANHO.
//
// Só LEITURA. Nunca escreve nada.

import { saldoAoVivo } from './bling.js';

const URL_ESTOQUE = () =>
  (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
  + '/storage/v1/object/public/reposicao-data/reposicao/estoque.json';

const VALIDADE_MS = 30 * 60 * 1000;         // o arquivo muda 1x por dia; 30 min é folgado
let _cache = { em: 0, dados: null };

export async function carregarEstoque() {
  if (_cache.dados && Date.now() - _cache.em < VALIDADE_MS) return _cache.dados;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);          // o robô não pode ficar pendurado
  try {
    const r = await fetch(URL_ESTOQUE(), { signal: c.signal });
    if (!r.ok) return _cache.dados;                     // devolve o retrato velho, se houver
    const j = await r.json();
    if (!j || !Array.isArray(j.produtos)) return _cache.dados;
    _cache = { em: Date.now(), dados: j };
    return j;
  } catch (e) {
    return _cache.dados;                                 // falhou: melhor o velho que nada
  } finally { clearTimeout(t); }
}

const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* Palavras que aparecem em NOME DE PRODUTO mas não distinguem nada. Sem esta lista,
   "tem scrub?" casaria com os 233 produtos e o bloco viraria um catálogo inteiro dentro
   do prompt. */
const GENERICAS = new Set([
  'feminino', 'masculino', 'unissex', 'infantil', 'com', 'sem', 'para', 'the', 'dra', 'charm',
  'plus', 'size', 'manga', 'longa', 'curta', 'linha', 'kit', 'novo', 'nova'
]);

/* O vocabulário sai do PRÓPRIO catálogo: nome de modelo (Moove, Chloé, Maya) e cor (Preto,
   Lilás) são só as palavras que existem nos nomes dos produtos. Assim a busca nunca inventa
   termo: se a palavra não está no catálogo, ela não vira busca. */
function vocabulario(dados) {
  if (dados.__vocab) return dados.__vocab;
  const v = new Set();
  (dados.produtos || []).forEach(p => {
    semAcento(p.nome).split(/[^a-z0-9]+/).forEach(w => {
      if (w.length >= 3 && !GENERICAS.has(w) && !/^\d+$/.test(w)) v.add(w);
    });
  });
  Object.defineProperty(dados, '__vocab', { value: v, enumerable: false });
  return v;
}

function resumirProduto(p, aoVivo) {
  const tam = (Array.isArray(p.tamanhos) ? p.tamanhos : [])
    .filter(t => t.ativo !== false)
    .map(t => {
      /* O retrato é de madrugada; o Bling é de agora. Quando o Bling respondeu por este
         SKU, é ele que vale — foi pra isso que a gente foi lá. */
      const vivo = aoVivo && t.sku ? aoVivo.get(String(t.sku).toLowerCase()) : undefined;
      const saldo = vivo !== undefined ? vivo : Number(t.saldo);
      return { tamanho: t.tamanho, tem: Number(saldo) > 0, conferido: vivo !== undefined };
    });
  return {
    nome: p.nome,
    preco: p.preco != null ? Number(p.preco) : null,
    // saldo exato NÃO vai pro prompt de propósito: "só resta 1" vira pressão de venda e
    // promessa que o site não garante. O robô só precisa saber se tem ou não tem.
    disponiveis: tam.filter(t => t.tem).map(t => t.tamanho),
    esgotados:   tam.filter(t => !t.tem).map(t => t.tamanho),
    temAlgum: tam.some(t => t.tem),
    conferidoAoVivo: tam.some(t => t.conferido)
  };
}

/**
 * Procura no catálogo com as palavras que a cliente usou.
 * Devolve { termos, produtos, atualizado_em } ou null quando não há o que dizer.
 * NUNCA lança.
 */
export async function procurarNoEstoque(texto, limite = 4) {
  try {
    const dados = await carregarEstoque();
    if (!dados || !Array.isArray(dados.produtos) || !dados.produtos.length) return null;

    const vocab = vocabulario(dados);
    const palavras = [...new Set(semAcento(texto).split(/[^a-z0-9]+/).filter(w => w.length >= 3))];
    const termos = palavras.filter(w => vocab.has(w));
    if (!termos.length) return null;                    // não falou de nada que existe no catálogo

    // pontua por quantos termos o nome contém: quem casa "moove" E "lilas" vem antes de
    // quem casa só "moove"
    const achados = [];
    for (const p of dados.produtos) {
      const nome = semAcento(p.nome);
      const pontos = termos.reduce((s, t) => s + (nome.includes(t) ? 1 : 0), 0);
      if (pontos) achados.push({ pontos, p });
    }
    if (!achados.length) return null;

    const melhor = Math.max(...achados.map(a => a.pontos));

    /* ===== A COMBINAÇÃO QUE NÃO EXISTE =====
       Caso real, cliente Marta: ela pediu "Zoe cinza". A Zoe existe (amarelo, lilás,
       marinho, rosé) e cinza existe (Alice, Lucy, Maya, Megan) — mas Zoe cinza NÃO existe.
       Devolvendo os dois grupos juntos, o modelo somou um com o outro e respondeu
       "a gente tem a Zoe em cinza, sim". Inventou com convicção, que é pior que não saber.

       Quando nenhum produto casa com TUDO que ela pediu, o dado que interessa não é a lista:
       é o FATO de que a combinação não existe, e quais cores aquele modelo tem. */
    if (melhor < termos.length) {
      const porTermo = termos.map(t => ({
        termo: t,
        quantos: achados.filter(a => semAcento(a.p.nome).includes(t)).length,
        produtos: achados.filter(a => semAcento(a.p.nome).includes(t)).slice(0, 8).map(a => a.p.nome)
      })).sort((x, y) => x.quantos - y.quantos);   // o mais específico primeiro (costuma ser o modelo)
      return { termos, combinacaoNaoExiste: true, porTermo, atualizado_em: dados.atualizado_em || null };
    }

    // só os que casam com o MAIOR número de termos: "moove lilas" não devolve todo Moove
    const finalistas = achados.filter(a => a.pontos === melhor);

    /* "tem scrub feminino?" casa com uns 100 produtos. Mostrar 4 deles seria pior que não
       mostrar nada: o robô responderia com quatro produtos quaisquer, os primeiros do
       arquivo, como se fossem A resposta. Nesse caso a busca do site é a resposta honesta. */
    if (finalistas.length > 12) {
      return { termos, produtos: [], muitos: finalistas.length, atualizado_em: dados.atualizado_em || null };
    }

    const escolhidos = finalistas.slice(0, limite);

    /* ===== O RETRATO DIZ QUAL, O BLING DIZ SE TEM =====
       O retrato é puxado uma vez por dia, às 4h30 da manhã (o cron da Vercel roda em UTC,
       então aquele "30 7" é 4h30 em Fortaleza). Às 16h de uma sexta ele tem quase 12
       horas. Medido em 21/08: de 1.094 variações ativas, 32 estão com 1 a 3 peças — são
       essas que podem acabar durante o dia e fazer o robô dizer "tem sim" pra uma peça
       que já foi.

       Varrer o catálogo ao vivo está fora de questão: são 233 produtos em páginas de 100
       com pausa de 250ms pro limite de 3 req/s do Bling, dezenas de segundos. Ninguém
       segura uma conversa por isso.

       Então divide-se o trabalho: o retrato responde QUAL produto ela quer (é ele que tem
       os nomes, o vocabulário, o preço — essa busca precisa estar pronta), e o Bling
       responde SE TEM, só pros finalistas, uma chamada por SKU. ~500ms com o token quente.

       Se o Bling não responder, saldoAoVivo devolve null e tudo segue com o retrato: o
       robô fica igual ao que era ontem, nunca pior.

       O saldo do retrato vai junto porque o Bling só aguenta 3 chamadas por segundo: dá
       pra conferir uns poucos tamanhos, e quem escolhe quais é o lib/bling.js — pelos que
       podem estar mentindo (pouca peça ou zerado), não pelos que têm estoque de sobra. */
    let aoVivo = null;
    try {
      const alvos = [];
      for (const a of escolhidos) {
        for (const t of (a.p.tamanhos || [])) if (t.ativo !== false && t.sku) alvos.push({ sku: t.sku, saldo: t.saldo });
      }
      if (alvos.length) aoVivo = await saldoAoVivo(alvos);
    } catch (e) { aoVivo = null; }

    const lista = escolhidos.map(a => resumirProduto(a.p, aoVivo));
    return {
      termos, produtos: lista, atualizado_em: dados.atualizado_em || null,
      achadosNoTotal: finalistas.length,
      aoVivo: !!aoVivo
    };
  } catch (e) {
    return null;
  }
}

/* Vira texto pro prompt. Curto de propósito: cada linha custa token em toda resposta. */
const BUSCA = 'https://www.dracharm.com.br/buscar?q=';

export function estoqueEmTexto(r) {
  if (!r) return '';

  if (r.combinacaoNaoExiste) {
    const l = ['A cliente pediu "' + r.termos.join(' ') + '" e NENHUM produto do catálogo tem essas coisas '
      + 'juntas. NÃO diga que tem — não existe.'];
    r.porTermo.forEach(t => {
      l.push('O que existe com "' + t.termo + '"' + (t.quantos > t.produtos.length ? (' (' + t.quantos + ' no total)') : '') + ': '
        + t.produtos.join('; '));
    });
    const alvo = r.porTermo[0];      // o termo mais específico: quase sempre o nome do modelo
    l.push('COMO RESPONDER: diga que nesse modelo não tem essa cor, e mande a busca do MODELO pra ela ver '
      + 'as cores que existem — ' + BUSCA + encodeURIComponent(alvo.termo) + ' . '
      + 'Deixe claro, sem rodeio, que só existe o que está no site: a Dra. Charm não faz sob encomenda.');
    return l.join('\n');
  }

  if (r.muitos) {
    return 'A cliente falou de algo amplo (' + r.muitos + ' produtos do catálogo batem com "' + r.termos.join(' ')
      + '"). NÃO liste produto nenhum: mande a busca do site pra ela ver tudo.';
  }
  if (!r.produtos || !r.produtos.length) return '';
  const l = r.produtos.map(p => {
    const partes = [p.nome];
    if (p.preco != null) partes.push('R$ ' + p.preco.toFixed(2).replace('.', ','));
    partes.push(p.temAlgum ? ('tem: ' + p.disponiveis.join(', ')) : 'esgotado em todos os tamanhos');
    if (p.temAlgum && p.esgotados.length) partes.push('sem: ' + p.esgotados.join(', '));
    return '- ' + partes.join(' | ');
  });
  if (r.achadosNoTotal > r.produtos.length) {
    l.push('(há mais ' + (r.achadosNoTotal - r.produtos.length) + ' produtos parecidos; se ela quiser ver tudo, mande a busca do site)');
  }
  return l.join('\n');
}
