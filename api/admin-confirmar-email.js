// api/admin-confirmar-email.js
// Marca o e-mail de um usuário como confirmado, sem mexer na senha dele.
//
// Por que existe: o Supabase, com "Confirm email" LIGADO no painel, recusa o login com
// "Email not confirmed" enquanto o usuário não clicar num link que ele nunca vai receber
// (a gente não usa SMTP). Quem foi criado no tempo do signUp() ficou preso nesse estado.
// O admin-set-password já mandava email_confirm junto, mas só quando a senha era trocada —
// e ninguém quer trocar a senha da pessoa só pra destravar o login dela.
//
// SOLUÇÃO DEFINITIVA (uma vez, no painel do Supabase, e o Marcio é quem faz):
//   Authentication -> Sign In / Providers -> Email -> desligar "Confirm email".
//   Com isso ninguém mais nasce pendente. Este endpoint continua servindo pra destravar
//   quem já ficou preso antes.
//
// POST { email } ou { userId }   — só o admin pode chamar.

const ADMIN_EMAIL = 'marcioborgesaraujojr@gmail.com';

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
  Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
  'Content-Type': 'application/json'
});

// A Admin API não tem busca por e-mail confiável entre versões — então pagina e procura.
// A base de usuários daqui é de dezenas, não de milhares.
async function acharPorEmail(email){
  const alvo = String(email).toLowerCase().trim();
  for(let pagina = 1; pagina <= 20; pagina++){
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users?page=' + pagina + '&per_page=200', { headers: H() });
    if(!r.ok) return null;
    const j = await r.json();
    const lista = Array.isArray(j) ? j : (j.users || []);
    const achou = lista.find(u => String(u.email || '').toLowerCase() === alvo);
    if(achou) return achou;
    if(lista.length < 200) return null;
  }
  return null;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const quem = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if(!quem) return res.status(403).json({ error: 'Sessão inválida. Faça login na suíte.' });
  if(quem !== ADMIN_EMAIL) return res.status(403).json({ error: 'Só o administrador pode confirmar e-mail.' });

  let body = req.body; if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
  let userId = body && body.userId;
  const email = body && body.email;

  if(!userId && !email) return res.status(400).json({ error: 'Informe "email" ou "userId".' });

  if(!userId){
    const u = await acharPorEmail(email);
    if(!u) return res.status(404).json({ error: 'Não achei ninguém com o e-mail ' + email + '.' });
    userId = u.id;
    if(u.email_confirmed_at) {
      return res.status(200).json({ ok: true, jaEstava: true, userId, email: u.email,
        aviso: 'Esse e-mail já constava confirmado. Se o login ainda recusar, o problema é outro (senha errada ou usuário banido).' });
    }
  }

  const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users/' + userId, {
    method: 'PUT',
    headers: H(),
    body: JSON.stringify({ email_confirm: true, ban_duration: 'none' })
  });
  let j = null; try{ j = await r.json(); }catch(e){}
  if(!r.ok) return res.status(500).json({ error: 'Supabase recusou: ' + JSON.stringify(j).slice(0, 300) });

  return res.status(200).json({
    ok: true,
    userId,
    email: j && j.email,
    confirmadoEm: j && j.email_confirmed_at,
    banido: !!(j && j.banned_until && j.banned_until !== 'none')
  });
}
