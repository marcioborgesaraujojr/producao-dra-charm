// api/admin-create-user.js
// Cria o acesso de um usuário SEM DEPENDER DE E-MAIL.
//
// Por que existe: a tela usava `supabase.auth.signUp()` no navegador, que manda e-mail de
// confirmação. O serviço de e-mail embutido do Supabase só entrega 2 mensagens por hora e
// só para endereços que são membros do projeto — por isso dava "email rate limit exceeded"
// e ninguém de fora conseguia ser cadastrado.
//
// Aqui a conta nasce pela Admin API com `email_confirm: true`: já confirmada, nenhum e-mail
// enviado, nenhum limite. O admin passa e-mail + senha provisória pra pessoa na mão.
//
// Segurança: SERVICE ROLE KEY só no servidor e só executa se quem chamou for o admin.
// Reusa as env vars que já existem no Vercel (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).

const ADMIN_EMAIL = 'marcioborgesaraujojr@gmail.com';

async function callerEmail(token){
  if(!token) return null;
  try{
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + token
      }
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

  // 1) Só o admin pode criar acesso
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const quem = await callerEmail(token);
  if(!quem || quem !== ADMIN_EMAIL){
    return res.status(403).json({ error: 'Apenas o administrador pode criar acessos.' });
  }

  // 2) Corpo
  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = String((body && body.password) || '');
  const nome = String((body && body.nome) || '').trim();
  const setor = String((body && body.setor) || '').trim();
  if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if(password.length < 6) return res.status(400).json({ error: 'A senha precisa ter ao menos 6 caracteres.' });

  const H = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  };

  // 3) Cria a conta já confirmada (sem e-mail nenhum)
  const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ email, password, email_confirm: true })
  });
  let j = null; try{ j = await r.json(); }catch(e){}

  if(!r.ok){
    const msg = (j && (j.msg || j.error_description || j.error)) || 'Erro ao criar acesso';
    // Mensagem clara para o caso mais comum, em vez do texto cru da API.
    if(/already been registered|already exists|duplicate/i.test(String(msg))){
      return res.status(409).json({ error: 'Esse e-mail já tem acesso. Use "Definir senha" na ficha da pessoa.' });
    }
    return res.status(400).json({ error: msg });
  }

  const userId = j && j.id;

  // 4) Garante a linha em profiles (o trigger pode já ter criado — por isso é upsert/merge).
  if(userId){
    try{
      const linha = { id: userId, email };
      if(nome)  linha.full_name = nome;
      if(setor) linha.setor = setor;
      await fetch(process.env.SUPABASE_URL + '/rest/v1/profiles?on_conflict=id', {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(linha)
      });
    }catch(e){ /* best-effort: a conta já existe, o perfil dá pra ajustar na tela */ }
  }

  return res.status(200).json({ ok: true, id: userId, email });
}
