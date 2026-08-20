-- MODO TESTE do Chatbot IA.
--
-- Pra que serve: ligar o robô sem soltar ele em cima das 1.700 conversas de uma vez.
-- Ele pega um LOTE pequeno (5 por padrão), atende só essas, e PARA. Nada de novo entra
-- até você clicar "liberar novo lote" na aba Modo teste. Assim dá pra ler as cinco com
-- calma, ver como ele respondeu e mexer no prompt antes da próxima leva.
--
-- Rodar uma vez no SQL Editor do Supabase. É seguro rodar de novo.

-- ============================================================
-- 1) Configuração do modo teste (aba Modo teste)
-- ============================================================
-- Liga o modo teste. Só tem efeito com o chatbot ativo — teste ligado e chatbot
-- desligado continua sendo chatbot desligado.
alter table public.at_chatbot add column if not exists modo_teste   boolean not null default false;
-- Quantas conversas o robô pode pegar por lote.
alter table public.at_chatbot add column if not exists teste_limite int     not null default 5;
-- Carimbo do lote atual. Trocar este valor é o que "libera um novo lote": as conversas
-- do lote anterior ficam com o carimbo velho e param de contar como vaga ocupada.
alter table public.at_chatbot add column if not exists teste_lote   int     not null default 1;

comment on column public.at_chatbot.modo_teste   is 'Robô atende só um lote pequeno de conversas, pra você analisar antes de soltar geral.';
comment on column public.at_chatbot.teste_limite is 'Quantas conversas cabem no lote de teste.';
comment on column public.at_chatbot.teste_lote   is 'Número do lote atual. Subir este número libera um lote novo.';

-- ============================================================
-- 2) Marca na conversa: de qual lote de teste ela é
-- ============================================================
-- null = a conversa nunca entrou em teste nenhum.
-- Igual ao teste_lote de at_chatbot = está no lote de AGORA (ocupa vaga, o robô atende).
-- Menor que o teste_lote = é de um lote antigo (fica no histórico, não ocupa vaga).
alter table public.at_conversas add column if not exists bot_teste_lote int;
alter table public.at_conversas add column if not exists bot_teste_em   timestamptz;

comment on column public.at_conversas.bot_teste_lote is 'Lote de teste do chatbot em que esta conversa entrou. Null = nunca entrou.';

-- Contar as vagas ocupadas é a consulta mais quente do webhook (roda a cada mensagem
-- que chega enquanto o teste está ligado). Sem índice isso é varredura na tabela toda.
create index if not exists at_conversas_bot_teste_lote
  on public.at_conversas (bot_teste_lote) where bot_teste_lote is not null;

-- ============================================================
-- 3) CONFERÊNCIA — as três primeiras têm que voltar 1, e a última 0
-- ============================================================
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='at_chatbot' and column_name='modo_teste')     as col_modo_teste,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='at_chatbot' and column_name='teste_limite')   as col_teste_limite,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='at_conversas' and column_name='bot_teste_lote') as col_bot_teste_lote,
  (select count(*) from public.at_conversas where bot_teste_lote is not null)                 as conversas_em_teste;
