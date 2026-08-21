// api/bling-token.js — mantém o token do Bling quente. Cron de 30 em 30 minutos.
//
// POR QUE ISTO EXISTE:
// O robô consulta o saldo ao vivo no Bling, mas de propósito NÃO renova token (o refresh
// token do Bling rotaciona; várias clientes escrevendo ao mesmo tempo com o cache frio
// viraria uma corrida que invalida a integração inteira). Ele só lê o cache.
//
// Só que o cache dura 55 minutos e, até hoje, quem o renovava era o cron do estoque —
// uma vez por dia, às 4h30. Ou seja: 55 minutos quentes e 23 horas frios. O robô cairia
// no retrato do dia quase sempre e a consulta ao vivo seria enfeite.
//
// Este cron resolve isso sendo o ÚNICO renovador: de 30 em 30 minutos ele chama
// getBlingToken(), que só renova de verdade quando o cache está para vencer. Como o cache
// vive 55 minutos e a batida é a cada 30, ele nunca esfria — e a varredura diária, quando
// roda, encontra o cache quente e também não renova. Um renovador, sem corrida.
//
// Não escreve nada além do cache. Devolve só se está quente e quando vence.

import { getBlingToken } from '../lib/bling-token.js';
import { saldoAoVivo } from '../lib/bling.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const daVercel = String(req.headers['user-agent'] || '').includes('vercel-cron')
    || req.headers['x-vercel-cron'] != null;
  if (!daVercel && !String(req.headers.authorization || '').startsWith('Bearer ')) {
    return res.status(401).json({ error: 'não autorizado' });
  }

  try {
    const t0 = Date.now();
    const token = await getBlingToken();

    /* ?sku=00243-gg — prova que a consulta ao vivo está de pé de ponta a ponta.
       Sem isto, um filtro que o Bling ignorasse faria o robô cair no retrato em silêncio:
       nada quebra, nada avisa, e a gente acharia que está consultando ao vivo sem estar.
       Só leitura, e não devolve o token. */
    if (req.query.sku) {
      const skus = String(req.query.sku).split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
      const t1 = Date.now();
      const mapa = await saldoAoVivo(skus);
      return res.status(200).json({
        ok: true, quente: !!token,
        aoVivo: !!mapa,
        saldos: mapa ? Object.fromEntries(mapa) : null,
        naoAchou: skus.filter(s => !mapa || !mapa.has(s.toLowerCase())),
        ms: Date.now() - t1
      });
    }

    /* Nunca devolver o token. Este endpoint diz SE tem, não QUAL é. */
    return res.status(200).json({ ok: true, quente: !!token, ms: Date.now() - t0 });
  } catch (e) {
    /* Falhar aqui não pode derrubar nada: o robô cai no retrato do dia sozinho.
       Mas o erro precisa aparecer, senão a consulta ao vivo morre em silêncio. */
    return res.status(200).json({ ok: false, erro: String(e && e.message || e).slice(0, 200) });
  }
}
