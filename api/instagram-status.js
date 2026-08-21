// api/instagram-status.js — diagnóstico do Instagram Direct. SÓ LEITURA.
//
// Antes de escrever uma linha de webhook do Instagram, a pergunta é: a conta Meta que já
// manda WhatsApp por aqui tem permissão pra ler e responder Direct? Se tiver, o caminho é
// curto. Se não tiver, passa por revisão da Meta e leva dias — e isso muda o plano inteiro.
//
// Este endpoint não configura nada, não liga nada e não manda mensagem. Ele só pergunta pra
// Meta o que a gente já tem: quais permissões o token carrega, quais páginas do Facebook o
// token enxerga, e se alguma delas tem conta profissional do Instagram ligada.
//
// GET (Bearer da suíte) -> { token, paginas, instagram, oQueFalta }

const GRAPH = 'https://graph.facebook.com/v20.0';

async function g(caminho, params) {
  const u = new URL(GRAPH + caminho);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) u.searchParams.set(k, v); });
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 10000);
  try {
    const r = await fetch(u.toString(), { signal: c.signal });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, j };
  } catch (e) {
    return { ok: false, status: 0, j: null, erro: e.message };
  } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'não autorizado' });

  const TOKEN = process.env.IG_ACCESS_TOKEN || process.env.WA_ACCESS_TOKEN;
  if (!TOKEN) return res.status(200).json({ ok: false, resultado: 'sem token da Meta configurado' });

  const saida = { usandoToken: process.env.IG_ACCESS_TOKEN ? 'IG_ACCESS_TOKEN' : 'WA_ACCESS_TOKEN' };

  // 1) o que este token pode fazer
  const dbg = await g('/debug_token', { input_token: TOKEN, access_token: TOKEN });
  const d = dbg.j && dbg.j.data;
  saida.token = d ? {
    tipo: d.type, app: d.application, valido: d.is_valid,
    expira: d.expires_at ? new Date(d.expires_at * 1000).toISOString().slice(0, 10) : 'não expira',
    permissoes: d.scopes || d.granular_scopes && d.granular_scopes.map(x => x.scope) || []
  } : { erro: (dbg.j && dbg.j.error && dbg.j.error.message) || 'não deu pra ler o token' };

  const perms = new Set((saida.token && saida.token.permissoes) || []);
  saida.temPermissaoDirect = perms.has('instagram_manage_messages');
  saida.temPermissaoBasica = perms.has('instagram_basic');
  saida.temPaginas        = perms.has('pages_show_list') || perms.has('pages_messaging');

  // 2) páginas do Facebook que o token enxerga (o Instagram profissional pendura numa página)
  const pg = await g('/me/accounts', { access_token: TOKEN, fields: 'id,name,instagram_business_account{id,username,name}' });
  const paginas = (pg.j && Array.isArray(pg.j.data)) ? pg.j.data : [];
  saida.paginas = paginas.map(p => ({
    id: p.id, nome: p.name,
    instagram: p.instagram_business_account
      ? { id: p.instagram_business_account.id, arroba: p.instagram_business_account.username }
      : null
  }));
  if (!paginas.length && pg.j && pg.j.error) saida.paginasErro = pg.j.error.message;

  const comIG = saida.paginas.filter(p => p.instagram);
  saida.instagramLigado = comIG.length ? comIG.map(p => p.instagram.arroba) : [];

  /* O diagnóstico só serve se disser o que FAZER. Sem isto vira uma pilha de JSON e alguém
     tem que interpretar. */
  const falta = [];
  if (!saida.temPermissaoDirect) falta.push('permissão instagram_manage_messages no app da Meta (passa por revisão deles)');
  if (!saida.temPermissaoBasica) falta.push('permissão instagram_basic');
  if (!comIG.length) falta.push('conta profissional do Instagram ligada a uma página do Facebook que este token enxergue');
  if (!process.env.IG_ACCESS_TOKEN && comIG.length) falta.push('token próprio do Instagram (IG_ACCESS_TOKEN) — o do WhatsApp costuma não servir pra Direct');
  saida.oQueFalta = falta.length ? falta : ['nada: dá pra ligar o Direct'];

  return res.status(200).json(saida);
}
