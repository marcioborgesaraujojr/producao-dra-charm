// lib/foto.js
// Busca a FOTO DE PERFIL do WhatsApp do cliente via API de TERCEIRO (ex.: RapidAPI "WhatsApp profile pic").
// Genérico/configurável por env var — funciona com qualquer serviço de "foto por número" sem mexer no código.
//
// Env vars no Vercel (o Marcio cadastra depois de assinar a API; NUNCA no código):
//   FOTO_API_URL   -> URL do endpoint, com o marcador {PHONE} onde entra o número.
//                     Ex.: https://whatsapp-profile-pic.p.rapidapi.com/wspic/url?phone={PHONE}
//                     (se não tiver {PHONE}, a gente anexa ?phone=NUMERO automaticamente)
//   FOTO_API_HOST  -> valor do header X-RapidAPI-Host (ex.: whatsapp-profile-pic.p.rapidapi.com)
//   FOTO_API_KEY   -> a chave do RapidAPI (header X-RapidAPI-Key)
//   FOTO_API_HEADER_AUTH (opcional) -> se o serviço NÃO for RapidAPI e usar Authorization (ex.: "Bearer xxx")
//
// Retorna a URL da foto (string) ou null. Nunca lança — degrada com elegância.

function primeiraUrlImagem(obj, depth = 0) {
  if (obj == null || depth > 5) return null;
  if (typeof obj === 'string') {
    const s = obj.trim();
    return /^https?:\/\/\S+/i.test(s) ? s : null;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) { const u = primeiraUrlImagem(v, depth + 1); if (u) return u; }
    return null;
  }
  if (typeof obj === 'object') {
    const prefer = ['profile_pic', 'profilePic', 'profile_picture', 'profilePicUrl', 'picture', 'avatar', 'image', 'imageUrl', 'url', 'link', 'result', 'dp', 'photo'];
    for (const k of prefer) { if (obj[k] != null) { const u = primeiraUrlImagem(obj[k], depth + 1); if (u) return u; } }
    for (const k of Object.keys(obj)) { const u = primeiraUrlImagem(obj[k], depth + 1); if (u) return u; }
  }
  return null;
}

export async function buscarFotoWhatsApp(numero) {
  try {
    const n = String(numero || '').replace(/\D/g, '');
    if (!n) return null;
    const tpl = process.env.FOTO_API_URL;
    if (!tpl) return null;   // serviço ainda não configurado -> sem foto (usa iniciais)
    const url = tpl.includes('{PHONE}')
      ? tpl.replace(/\{PHONE\}/g, encodeURIComponent(n))
      : (tpl + (tpl.includes('?') ? '&' : '?') + 'phone=' + encodeURIComponent(n));
    const headers = {};
    if (process.env.FOTO_API_KEY)  headers['X-RapidAPI-Key'] = process.env.FOTO_API_KEY;
    if (process.env.FOTO_API_HOST) headers['X-RapidAPI-Host'] = process.env.FOTO_API_HOST;
    if (process.env.FOTO_API_HEADER_AUTH) headers['Authorization'] = process.env.FOTO_API_HEADER_AUTH;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);   // não trava o webhook
    let r;
    try { r = await fetch(url, { headers, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    if (!r || !r.ok) return null;

    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { j = txt; }
    const u = (typeof j === 'string' && /^https?:\/\//i.test(j.trim())) ? j.trim() : primeiraUrlImagem(j);
    // alguns serviços devolvem uma imagem "sem foto"/placeholder; deixamos passar (o front tem fallback).
    return u || null;
  } catch (e) { return null; }
}
