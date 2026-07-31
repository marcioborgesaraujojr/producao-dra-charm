// api/version.js — versão do deploy atual.
// A Vercel preenche VERCEL_GIT_COMMIT_SHA sozinha em cada deploy, então
// não precisa atualizar nada à mão: quando muda o commit, muda a versão,
// e os apps (via theme.js) recarregam sozinhos.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ v: process.env.VERCEL_GIT_COMMIT_SHA || 'dev' });
}
