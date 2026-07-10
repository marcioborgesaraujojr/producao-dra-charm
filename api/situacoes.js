// /api/situacoes.js
// IMPORTANTE: sem ?token= retorna fallback estatico SEM chamar o Bling
// Isso evita rotacionar o refresh token ao carregar a pagina

const FALLBACK = [
  { id: 6,   nome: "Em aberto" },
  { id: 9,   nome: "Atendido" },
  { id: 11,  nome: "Verificado" },
  { id: 12,  nome: "Cancelado" },
  { id: 15,  nome: "Em andamento" },
  { id: 3,   nome: "Checkout parcial" },
  { id: 4,   nome: "Aguardando pagamento" },
  { id: 8,   nome: "Devolucao total" },
  { id: 2,   nome: "Nao utilizada" },
  { id: 118079, nome: "Atendido: TAYMAH" },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const passedToken = req.query.token;

  // Sem token: retorna fallback imediatamente, nao consome o refresh token
  if (!passedToken) {
    return res.json({ situacoes: FALLBACK, source: "fallback" });
  }

  // Com token passado pelo frontend (ja obtido pelo /api/pedidos): usa direto
  try {
    const r = await fetch("https://www.bling.com.br/Api/v3/situacoes?tipo=2", {
      headers: { Authorization: "Bearer " + passedToken },
    });

    if (!r.ok) return res.json({ situacoes: FALLBACK, source: "fallback_err" });

    const d = await r.json();
    const situacoes = (d.data || []).map(s => ({ id: s.id, nome: s.nome }));

    // Merge: FALLBACK como base + customizadas do Bling por cima
    const mapa = {};
    FALLBACK.forEach(s => { mapa[s.id] = s.nome; });
    situacoes.forEach(s => { if (s.id && s.nome) mapa[s.id] = s.nome; });
    const resultado = Object.entries(mapa).map(([id, nome]) => ({ id: Number(id), nome }));

    return res.json({ situacoes: resultado.length ? resultado : FALLBACK, source: "bling" });
  } catch (err) {
    return res.json({ situacoes: FALLBACK, source: "fallback_catch" });
  }
}
