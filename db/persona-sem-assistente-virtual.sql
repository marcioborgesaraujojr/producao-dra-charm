-- Persona e saudação do robô — tirar o "assistente virtual" da frente da cliente.
--
-- POR QUE: ele reparou que anunciar "assistente virtual" afasta a cliente, e tem razão:
-- ninguém da equipe abre uma conversa dizendo o próprio cargo.
--
-- CUIDADO QUE ESTE SQL TOMA: a persona tem 9.969 caracteres de regra de negócio escrita
-- por ele (horário, tabela de tamanhos, o que não responder, quando transferir). Este SQL
-- NÃO reescreve a persona — ele troca só os dois trechos onde ela se apresenta, e acrescenta
-- um bloco no fim. Todo o resto fica intacto, caractere por caractere.
--
-- O QUE ELE NÃO FAZ: não manda ela fingir ser humana. Se a cliente perguntar direto se é
-- robô, ela diz a verdade — está escrito aqui E travado no código
-- (api/chatbot-reply.js, bloco "QUEM VOCÊ É"), pra não sumir numa edição de campo.
--
-- Rodar uma vez. Seguro rodar de novo (as trocas não acham mais nada e o bloco não duplica).

-- ============================================================
-- 0) BACKUP — dá pra voltar exatamente ao que estava
-- ============================================================
create table if not exists public.at_chatbot_persona_bkp (
  id       bigserial primary key,
  salvo_em timestamptz not null default now(),
  nome     text,
  cargo    text,
  persona  text,
  saudacao text
);

insert into public.at_chatbot_persona_bkp (nome, cargo, persona, saudacao)
select nome, cargo, persona, saudacao from public.at_chatbot where id = 1;

-- ============================================================
-- 1) As duas apresentações dentro da persona
-- ============================================================
update public.at_chatbot set
  persona = replace(
              replace(persona,
                'Você é Aline, assistente virtual de atendimento da Dra. Charm',
                'Você é Aline, do atendimento da Dra. Charm'),
              'Sou a Aline, assistente virtual da Dra. Charm. Nossa equipe humana retorna',
              'Aqui é a Aline, da Dra. Charm. A equipe retorna')
where id = 1;

-- ============================================================
-- 2) O bloco de identidade, no fim da persona (só entra uma vez)
-- ============================================================
update public.at_chatbot set
  persona = persona || E'\n\nQUEM VOCÊ É\n'
    || 'Não se anuncie como robô, IA nem assistente virtual — você é o atendimento da Dra. Charm. '
    || 'Mas NUNCA afirme ser uma pessoa: se a cliente perguntar direto se está falando com gente ou com um robô, '
    || 'responda a verdade em uma linha ("sou o atendimento automático da Dra. Charm") e siga ajudando na mesma mensagem. '
    || 'Se ela pedir pra falar com alguém, passe na hora, sem insistir e sem se justificar. '
    || 'Não fale de si mesma nem comente que está aqui para ajudar.'
where id = 1
  and position('QUEM VOCÊ É' in persona) = 0;

-- ============================================================
-- 3) Cargo e saudação
--    O cargo entra no prompt como "Seu nome é Aline, <cargo>." — "Sucesso do cliente"
--    virava uma frase estranha. A saudação só aparece na tela de Treinamento (no WhatsApp
--    quem abre a conversa é a cliente), mas fica no mesmo tom pro teste refletir a realidade.
-- ============================================================
update public.at_chatbot set
  cargo    = 'do atendimento da Dra. Charm',
  saudacao = 'Oi! Aqui é a Aline, da Dra. Charm. Como posso te ajudar?'
where id = 1;

-- ============================================================
-- 4) CONFERÊNCIA — "sobrou_assistente_virtual" tem que voltar 0
-- ============================================================
select cargo,
       saudacao,
       left(persona, 60) as inicio_da_persona,
       length(persona)   as tamanho_da_persona,
       -- só o que ela FALA: o bloco QUEM VOCÊ É cita a expressão de propósito, pra proibir
       (select count(*) from regexp_matches(split_part(persona, 'QUEM VOCÊ É', 1),
                                            'assistente virtual', 'gi')) as sobrou_assistente_virtual
  from public.at_chatbot where id = 1;
