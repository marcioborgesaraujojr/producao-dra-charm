// Envio de e-mail transacional (notificação de ocorrência ao cliente).
// Provedor: Resend (https://resend.com) — simples, HTTP, sem SDK.
// Configure no Vercel:  RESEND_API_KEY  e  RESEND_FROM (ex.: "Dra. Charm <contato@dracharm.com.br>")
// Se não houver credencial, vira no-op e devolve { sent:false, reason:'sem provedor' }.

const BRAND = '#FF3C6F';                 // rosa Dra. Charm
const LOGO = 'https://cdn.awsli.com.br/1930/1930166/logo/logo200px-q4s967v62f.png';
const BASE = process.env.PUBLIC_BASE_URL || 'https://sistema.dracharm.com.br';

export function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

export async function sendEmail({ to, subject, html }) {
  if (!isConfigured()) return { sent: false, reason: 'sem provedor de e-mail configurado' };
  if (!to) return { sent: false, reason: 'sem destinatário' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: `Resend ${res.status}: ${data?.message || ''}` };
    return { sent: true, id: data.id };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

// Mensagens amigáveis por tipo de ocorrência (voz Dra. Charm).
const MSG = {
  'Destinatário ausente': 'O entregador tentou entregar seu pedido, mas não havia ninguém no endereço. Uma nova tentativa será feita. Se preferir, entre em contato com a gente.',
  'Destinatário desconhecido': 'A transportadora não localizou o destinatário no endereço informado. Pode nos confirmar seus dados de entrega?',
  'Destinatário mudou-se': 'A transportadora informou que o destinatário mudou-se do endereço. Pode atualizar seu endereço com a gente?',
  'Endereço não localizado': 'A transportadora não conseguiu localizar o endereço de entrega. Pode conferir e nos confirmar o endereço completo?',
  'Entrega atrasada': 'Seu pedido está levando um pouco mais do que o previsto para chegar. Já estamos acompanhando de perto com a transportadora.',
  'Expedição atrasada': 'Houve um atraso na expedição do seu pedido, mas já estamos cuidando de tudo para ele sair o quanto antes.',
  'Faturamento atrasado': 'Estamos finalizando o faturamento do seu pedido. Em breve ele seguirá para o envio.',
  'Extravio': 'Identificamos uma possível ocorrência de extravio com a transportadora. Já abrimos uma tratativa e vamos resolver isso para você.',
  'Pedido recusado na entrega': 'A entrega do seu pedido foi recusada. Se foi engano, entre em contato para reagendarmos a entrega.',
  'Devolução': 'Seu pedido está retornando para a nossa loja. Assim que chegar, entramos em contato para combinar o reenvio.',
  'Aguardando Retirada': 'Seu pedido está disponível para retirada. Confira o local e o prazo no acompanhamento.',
  'Objeto retido na fiscalização': 'Seu pedido está retido na fiscalização da transportadora. Estamos acompanhando a liberação.',
  'CEP não atendido': 'A transportadora informou que o CEP não é atendido para entrega. Vamos verificar uma alternativa para você.',
  'Acareação da entrega': 'Abrimos uma verificação com a transportadora sobre a entrega do seu pedido. Já estamos acompanhando.',
  'Problemas diversos': 'Identificamos uma ocorrência no transporte do seu pedido. Já estamos acompanhando para resolver.',
};

export function ocorrenciaHtml(order, tipo, comentario) {
  const nome = (order.cliente_nome || '').split(' ')[0] || 'Olá';
  const msg = MSG[tipo] || MSG['Problemas diversos'];
  const link = `${BASE}/rastreio.html?pedido=${encodeURIComponent(order.numero || '')}`;
  return `<!doctype html><html><body style="margin:0;background:#f6f6f8;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="text-align:center;margin-bottom:18px"><img src="${LOGO}" alt="Dra. Charm" style="height:44px"></div>
    <div style="background:#fff;border-radius:16px;padding:26px 24px;box-shadow:0 1px 6px rgba(0,0,0,.06)">
      <div style="display:inline-block;background:${BRAND};color:#fff;font-weight:700;font-size:12px;padding:5px 12px;border-radius:20px;margin-bottom:14px">${tipo}</div>
      <h2 style="margin:0 0 10px;font-size:20px">${nome}, temos uma atualização sobre o seu pedido</h2>
      <p style="margin:0 0 14px;line-height:1.55;color:#444">${msg}</p>
      ${comentario ? `<p style="margin:0 0 14px;line-height:1.5;color:#666;font-size:14px;background:#faf0f3;border-left:3px solid ${BRAND};padding:10px 12px;border-radius:6px">${comentario}</p>` : ''}
      <p style="margin:0 0 20px;color:#666;font-size:14px">Pedido <b>#${order.numero || ''}</b></p>
      <a href="${link}" style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Acompanhar meu pedido</a>
    </div>
    <p style="text-align:center;color:#999;font-size:12px;margin-top:16px">Dra. Charm · Este é um e-mail automático de acompanhamento do seu pedido.</p>
  </div></body></html>`;
}

export default { sendEmail, ocorrenciaHtml, isConfigured };
