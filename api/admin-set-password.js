// api/admin-set-password.js
// Permite que o ADMIN defina/redefina a senha de um usuário diretamente.
// Segurança: usa a SERVICE ROLE KEY (só no servidor, nunca no client) e só executa
// se quem chamou for o e-mail admin. Não cria env vars novas — reusa as que já existem
// no Vercel (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).

const ADMIN_EMAIL = 'marcioborgesaraujojr@gmail.com';

// Descobre o e-mail de quem chamou, validando o token de acesso dele.
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

  // 1) Só o admin pode
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const email = await callerEmail(token);
  if(!email || email !== ADMIN_EMAIL){
    return res.status(403).json({ error: 'Apenas o administrador pode definir senhas.' });
  }

  // 2) Corpo
  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
  const userId = body && body.userId;
  const password = body && body.password;
  if(!userId) return res.status(400).json({ error: 'userId ausente' });
  if(!password || String(password).length < 6){
    return res.status(400).json({ error: 'A senha precisa ter ao menos 6 caracteres.' });
  }

  // 3) Define a senha via Admin API do GoTrue (service role)
  const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
    method: 'PUT',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ password: String(password) })
  });
  let j = null; try{ j = await r.json(); }catch(e){}
  if(!r.ok){
    return res.status(400).json({ error: (j && (j.msg || j.error_description || j.error)) || 'Erro ao definir senha' });
  }
  return res.status(200).json({ ok: true });
}
