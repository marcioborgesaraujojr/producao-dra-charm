-- Funil de Leads no nível do Notificações Inteligentes.
--
-- O que faltava: cor por fase, etiquetas no card, ordem dentro da coluna e um lugar
-- pra guardar observação. O resto (arrastar, buscar, recolher coluna) é tela.
--
-- Rodar uma vez no SQL Editor do Supabase. É seguro rodar de novo.

-- ============================================================
-- 1) Fases com cor
--    `fases` continua sendo o array de nomes (não mexer: é o que a tela lê pra montar
--    as colunas, e já tem funil usando). A cor entra separada, mapeando NOME -> cor,
--    pra não quebrar nada que já existe.
-- ============================================================
alter table public.at_pipelines add column if not exists fases_cor jsonb not null default '{}'::jsonb;
comment on column public.at_pipelines.fases_cor is
  'Cor de cada fase: {"Entrega atrasada":"rosa","PROCON":"azul"}. Nome da cor, não hex — quem traduz é a tela.';

-- ============================================================
-- 2) Etiquetas do card
--    No Notificações cada card mostra etiquetas agrupadas: "Status pedido: Pedido
--    entregue", "Problema: Reclame Aqui". É uma lista de pares.
-- ============================================================
alter table public.at_pipeline_cards add column if not exists tags jsonb not null default '[]'::jsonb;
alter table public.at_pipeline_cards add column if not exists obs  text;
comment on column public.at_pipeline_cards.tags is
  'Etiquetas do card: [{"grupo":"Problema","valor":"Reclame Aqui"}]. Grupo é o rótulo cinza, valor é o colorido.';
comment on column public.at_pipeline_cards.obs is 'Anotação livre de quem está cuidando do caso.';

-- ============================================================
-- 3) Ordem dentro da coluna
--    A coluna `ordem` já existe, mas sem índice a lista saía em ordem imprevisível —
--    o card mudava de lugar sozinho a cada recarga.
-- ============================================================
create index if not exists at_pipeline_cards_ordem
  on public.at_pipeline_cards (pipeline_id, fase, ordem, id);

-- Quem nunca teve ordem entra na ordem de criação, pra não começar tudo empilhado no 0.
update public.at_pipeline_cards c
   set ordem = s.n
  from (select id, row_number() over (partition by pipeline_id, fase order by created_at) as n
          from public.at_pipeline_cards) s
 where c.id = s.id and coalesce(c.ordem, 0) = 0;

-- ============================================================
-- 4) Um lead não pode estar duas vezes no mesmo funil
--    A tela já checava isso no navegador, mas duas abas abertas furavam a checagem.
-- ============================================================
create unique index if not exists at_pipeline_cards_unico
  on public.at_pipeline_cards (pipeline_id, cliente_id);

-- Conferência:
-- select nome, fases, fases_cor from public.at_pipelines;
-- select fase, count(*) from public.at_pipeline_cards group by fase order by 2 desc;

-- ============================================================
-- 5) Robô "escrevendo" na lista de conversas
--    O webhook carimba aqui antes de chamar a IA e limpa quando a resposta sai.
--    A lista do atendimento troca o ícone parado do robô pelas bolinhas.
-- ============================================================
alter table public.at_conversas add column if not exists bot_digitando_em timestamptz;
comment on column public.at_conversas.bot_digitando_em is
  'Momento em que o robô começou a pensar. Nulo = não está escrevendo.';
