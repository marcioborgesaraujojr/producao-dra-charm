-- Treinamento do Chatbot IA: perguntas e respostas, intenções e verificação de links.
-- Mesma estrutura do Notificações Inteligentes, mas SEM o limite de 10.000 caracteres:
-- aqui é tudo campo `text` do Postgres.
--
-- Rodar uma vez no SQL Editor do Supabase. É seguro rodar de novo.

-- ---------- Perguntas e respostas ----------
create table if not exists public.at_chatbot_faq (
  id          bigserial primary key,
  pergunta    text not null,
  resposta    text not null,
  ordem       int  not null default 0,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- Intenções (situações que mudam o rumo do atendimento) ----------
create table if not exists public.at_chatbot_intencoes (
  id            bigserial primary key,
  nome          text not null,
  comportamento text not null,
  acao          text not null default 'humano',   -- 'humano' = transfere na hora
  ordem         int  not null default 0,
  ativo         boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------- Sites em que o bot pode confiar ao mandar link ----------
alter table public.at_chatbot add column if not exists sites_permitidos text;

comment on table  public.at_chatbot_faq        is 'Perguntas frequentes que entram no prompt do chatbot.';
comment on table  public.at_chatbot_intencoes  is 'Situações que o bot NÃO deve tentar resolver — transfere pro humano.';
comment on column public.at_chatbot.sites_permitidos is 'Domínios liberados para o bot mandar link, um por linha ou separados por vírgula.';

-- ---------- Acesso: só quem está logado na suíte ----------
alter table public.at_chatbot_faq       enable row level security;
alter table public.at_chatbot_intencoes enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='at_chatbot_faq' and policyname='faq_suite') then
    create policy faq_suite on public.at_chatbot_faq
      for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='at_chatbot_intencoes' and policyname='intencoes_suite') then
    create policy intencoes_suite on public.at_chatbot_intencoes
      for all to authenticated using (true) with check (true);
  end if;
end $$;

-- Conferência:
-- select count(*) from public.at_chatbot_faq;
-- select count(*) from public.at_chatbot_intencoes;
