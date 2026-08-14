// api/version.js
// Retorna o identificador do deploy atual (muda a cada publicação no Vercel).
// O front consulta de tempos em tempos; se mudar, mostra o aviso "Nova versão disponível".
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const v = process.env.VERCEL_GIT_COMMIT_SHA
         || process.env.VERCEL_DEPLOYMENT_ID
         || process.env.VERCEL_URL
         || 'dev';
  res.status(200).json({ v: String(v) });
}
