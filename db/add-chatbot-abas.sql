-- Abas novas do Chatbot IA: Configurações, Atendimento, Gatilhos, Métricas e Custos.
-- Espelha o que o Notificações Inteligentes tem nas páginas /settings, /timeout,
-- /triggers e /metrics — mas com os nomes e as regras da nossa casa.
--
-- Rodar uma vez no SQL Editor do Supabase. É seguro rodar de novo.

-- ============================================================
-- 1) Ajustes de comportamento (aba Configurações e aba Atendimento)
-- ============================================================
alter table public.at_chatbot add column if not exists descricao        text;
-- Quantas mensagens anteriores o robô lê antes de responder. Mais contexto = resposta
-- melhor e conta maior. O padrão 12 é o que o código já usava fixo.
alter table public.at_chatbot add column if not exists contexto_msgs    int     not null default 12;
-- Depois de quantas respostas do robô numa mesma conversa ele para e chama humano.
-- 0 = sem limite.
alter table public.at_chatbot add column if not exists limite_msgs      int     not null default 0;
-- Se o cliente repetir a MESMA mensagem várias vezes, é sinal de conversa travada
-- (ou outro robô do outro lado): passa pra humano em vez de ficar rodando em círculo.
alter table public.at_chatbot add column if not exists detectar_loop    boolean not null default true;
-- Marcar como lida no WhatsApp do cliente quando o robô responder.
alter table public.at_chatbot add column if not exists marcar_lida      boolean not null default true;
-- Encerrar o atendimento do robô depois de X minutos sem ninguém falar. 0 = nunca.
alter table public.at_chatbot add column if not exists inatividade_min  int     not null default 30;
alter table public.at_chatbot add column if not exists msg_encerramento text;
-- Quantas horas o cliente espera antes de o robô atendê-lo de novo. 0 = sem espera.
alter table public.at_chatbot add column if not exists reentrada_horas  int     not null default 0;

comment on column public.at_chatbot.contexto_msgs   is 'Mensagens anteriores que o robô lê antes de responder.';
comment on column public.at_chatbot.limite_msgs     is 'Respostas do robô por conversa antes de passar pra humano. 0 = sem limite.';
comment on column public.at_chatbot.inatividade_min is 'Minutos de silêncio até o robô encerrar o atendimento. 0 = nunca encerra.';
comment on column public.at_chatbot.reentrada_horas is 'Horas de espera até o mesmo cliente poder ser atendido pelo robô de novo.';

-- ============================================================
-- 2) Gatilhos (aba Gatilhos)
--    Frase ou palavra que faz o robô ENTRAR na conversa.
--    SEM NENHUM GATILHO ATIVO, o robô responde tudo — igual ao Notificações.
-- ============================================================
create table if not exists public.at_chatbot_gatilhos (
  id         bigserial primary key,
  texto      text not null,
  tipo       text not null default 'contem',   -- contem | igual | comeca
  ativo      boolean not null default true,
  ordem      int not null default 0,
  created_at timestamptz not null default now()
);
comment on table public.at_chatbot_gatilhos is
  'Frases que ligam o robô. Lista vazia (ou tudo desligado) = robô responde todas as conversas.';

alter table public.at_chatbot_gatilhos enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename='at_chatbot_gatilhos' and policyname='gatilhos_suite') then
    create policy gatilhos_suite on public.at_chatbot_gatilhos
      for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ============================================================
-- 3) Uso e custo (aba Custos)
--    Uma linha por resposta do robô, com os tokens que a Anthropic/OpenAI cobrou.
--    Assim o painel de custo mostra o gasto REAL, não um chute em cima do número
--    de mensagens.
-- ============================================================
create table if not exists public.at_chatbot_uso (
  id             bigserial primary key,
  conversa_id    bigint,
  modelo         text,
  tokens_in      int not null default 0,   -- entrada cobrada cheia
  tokens_out     int not null default 0,
  tokens_cache_w int not null default 0,   -- gravação do cache (custa 1,25x a entrada)
  tokens_cache_r int not null default 0,   -- leitura do cache (custa 0,10x a entrada)
  handoff        boolean not null default false,
  erro           text,
  created_at     timestamptz not null default now()
);
create index if not exists at_chatbot_uso_data on public.at_chatbot_uso (created_at desc);
comment on table public.at_chatbot_uso is
  'Consumo por resposta do robô. Base do painel de Custos. Só a API escreve aqui.';

alter table public.at_chatbot_uso enable row level security;
-- De propósito SEM política: quem lê é a /api/chatbot-metricas com a service role.
-- (Lembrete: RLS ligada e sem política faz o PostgREST devolver lista VAZIA sem erro
-- nenhum no navegador — foi o que aconteceu com o at_disparos_log.)

-- ============================================================
-- 4) Sessão do robô na conversa (encerramento por inatividade)
-- ============================================================
alter table public.at_conversas add column if not exists bot_ultima_em   timestamptz;
alter table public.at_conversas add column if not exists bot_encerrada_em timestamptz;

-- Conferência:
-- select contexto_msgs, limite_msgs, inatividade_min, reentrada_horas from public.at_chatbot where id=1;
-- select count(*) from public.at_chatbot_gatilhos;
-- select count(*) from public.at_chatbot_uso;
