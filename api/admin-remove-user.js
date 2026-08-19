// api/admin-remove-user.js
// Tira o acesso de alguém que saiu da empresa. Duas ações:
//
//   acao: 'desativar'  (RECOMENDADO) — bloqueia o login no Auth (ban de 100 anos), zera os
//                       módulos, tira de todos os quadros e marca profiles.ativo = false.
//                       O HISTÓRICO FICA INTEIRO: comentários, menções, log de atividade e
//                       os cards que a pessoa mexeu continuam com o nome dela.
//   acao: 'reativar'   — desfaz o ban e volta ativo = true (os módulos e quadros precisam
//                       ser marcados de novo na mão, de propósito).
//   acao: 'excluir'    — apaga a conta do Auth e a linha de profiles de verdade. Se o banco
//                       tiver vínculo (comentários, log…), o Postgres recusa e a resposta
//                       explica que o caminho é desativar.
//
// Segurança: SERVICE ROLE só no servidor, só o admin chama, e o admin não pode
// desativar/excluir a si mesmo.

const ADMIN_EMAIL = 'marcioborgesaraujojr@gmail.com';
const BAN_LONGO = '876000h'; // ~100 anos

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

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const quem = await callerEmail(token);
  if(!quem || quem !== ADMIN_EMAIL){
    return res.status(403).json({ error: 'Apenas o administrador pode mexer em acessos.' });
  }

  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
  const userId = body && body.userId;
  const acao = String((body && body.acao) || 'desativar');
  if(!userId) return res.status(400).json({ error: 'userId ausente' });
  if(!['desativar','reativar','excluir'].includes(acao)) return res.status(400).json({ error: 'Ação inválida' });

  const H = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  };
  const AUTH = process.env.SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(userId);
  const REST = process.env.SUPABASE_URL + '/rest/v1/';

  // Trava: não deixa o admin se desativar/excluir sozinho e ficar sem ninguém no comando.
  try{
    const r = await fetch(AUTH, { headers: H });
    const u = await r.json();
    if(u && String(u.email || '').toLowerCase() === ADMIN_EMAIL){
      return res.status(400).json({ error: 'Você não pode desativar nem excluir a própria conta de administrador.' });
    }
  }catch(e){ /* segue: as ações abaixo já respondem erro se o id não existir */ }

  // Atualiza profiles tolerando a coluna 'ativo' ainda não existir no banco.
  async function patchProfile(campos){
    const r = await fetch(REST + 'profiles?id=eq.' + encodeURIComponent(userId), {
      method: 'PATCH', headers: H, body: JSON.stringify(campos)
    });
    if(r.ok) return { ok: true };
    let t = ''; try{ t = await r.text(); }catch(e){}
    return { ok: false, erro: t };
  }

  if(acao === 'desativar'){
    const r = await fetch(AUTH, { method: 'PUT', headers: H, body: JSON.stringify({ ban_duration: BAN_LONGO }) });
    if(!r.ok){
      let j = null; try{ j = await r.json(); }catch(e){}
      return res.status(400).json({ error: (j && (j.msg || j.error)) || 'Não consegui bloquear o login.' });
    }
    // Tira dos quadros (best-effort) e zera os módulos.
    try{ await fetch(REST + 'board_members?user_id=eq.' + encodeURIComponent(userId), { method: 'DELETE', headers: H }); }catch(e){}
    let p = await patchProfile({ access: {}, ativo: false, desativado_em: new Date().toISOString() });
    if(!p.ok) p = await patchProfile({ access: {} });   // banco sem as colunas novas
    return res.status(200).json({ ok: true, acao: 'desativar', perfilAtualizado: p.ok });
  }

  if(acao === 'reativar'){
    const r = await fetch(AUTH, { method: 'PUT', headers: H, body: JSON.stringify({ ban_duration: 'none' }) });
    if(!r.ok){
      let j = null; try{ j = await r.json(); }catch(e){}
      return res.status(400).json({ error: (j && (j.msg || j.error)) || 'Não consegui liberar o login.' });
    }
    let p = await patchProfile({ ativo: true, desativado_em: null });
    if(!p.ok) p = { ok: false };
    return res.status(200).json({ ok: true, acao: 'reativar', perfilAtualizado: p.ok });
  }

  // acao === 'excluir'
  try{ await fetch(REST + 'board_members?user_id=eq.' + encodeURIComponent(userId), { method: 'DELETE', headers: H }); }catch(e){}

  const rp = await fetch(REST + 'profiles?id=eq.' + encodeURIComponent(userId), { method: 'DELETE', headers: H });
  if(!rp.ok){
    let t = ''; try{ t = await rp.text(); }catch(e){}
    if(/foreign key|violates|constraint/i.test(t)){
      return res.status(409).json({
        error: 'Essa pessoa tem histórico no sistema (comentários, menções ou log), então o banco não deixa apagar. Use "Desativar acesso" — o login é bloqueado e o histórico continua legível.'
      });
    }
    return res.status(400).json({ error: 'Não consegui apagar o perfil: ' + (t || 'erro desconhecido') });
  }

  const ra = await fetch(AUTH, { method: 'DELETE', headers: H });
  if(!ra.ok){
    let j = null; try{ j = await ra.json(); }catch(e){}
    return res.status(400).json({ error: 'Perfil apagado, mas a conta de login continuou: ' + ((j && (j.msg || j.error)) || 'erro') });
  }
  return res.status(200).json({ ok: true, acao: 'excluir' });
}
