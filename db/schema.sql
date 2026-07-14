-- ============================================================
--  Módulo "Cadê Meu Pedido" — schema Supabase (Postgres)
--  Tabelas prefixadas com cmp_ para não colidir com o suite.
--  Rode este SQL no Supabase (SQL Editor) uma vez.
-- ============================================================

create table if not exists cmp_orders (
  id              bigint generated always as identity primary key,
  li_id           text unique,                 -- id/numero do pedido na Loja Integrada
  numero          text,
  nota_fiscal     text,
  cliente_nome    text,
  cliente_email   text,
  cliente_cpf     text,                          -- só dígitos
  destino         text,
  uf              text,
  preco           numeric default 0,
  transportadora  text,                          -- correios | motoboy | melhorenvio | jt
  servico         text,
  tracking_code   text,
  status          text default 'criado',
  li_situacao     text,
  ocorrencia      text,
  skus            jsonb default '[]'::jsonb,
  visitas         integer default 0,
  acareacao_aberta boolean default false,
  acareacao_em    timestamptz,
  criado_em       timestamptz default now(),
  data_envio      timestamptz,
  data_entrega    timestamptz,
  prazo_entrega   timestamptz,
  last_tracked_at timestamptz,
  raw             jsonb,
  updated_at      timestamptz default now()
);
create index if not exists idx_cmp_orders_status   on cmp_orders(status);
create index if not exists idx_cmp_orders_email     on cmp_orders(lower(cliente_email));
create index if not exists idx_cmp_orders_cpf        on cmp_orders(cliente_cpf);
create index if not exists idx_cmp_orders_numero     on cmp_orders(numero);

create table if not exists cmp_events (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references cmp_orders(id) on delete cascade,
  data       timestamptz,
  status     text,
  descricao  text,
  local      text,
  hash       text,
  created_at timestamptz default now(),
  unique(order_id, hash)
);
create index if not exists idx_cmp_events_order on cmp_events(order_id);

create table if not exists cmp_rules (
  id         bigint generated always as identity primary key,
  name       text not null,
  enabled    boolean default true,
  priority   integer default 100,
  when_json  jsonb not null,
  then_json  jsonb not null,
  created_at timestamptz default now()
);

create table if not exists cmp_status_history (
  id          bigint generated always as identity primary key,
  order_id    bigint references cmp_orders(id) on delete cascade,
  from_status text,
  to_status   text,
  source      text,
  created_at  timestamptz default now()
);

-- ------------------------------------------------------------
--  Ocorrências (igual ao cademeupedido): o sistema abre uma
--  ocorrência automaticamente conforme os eventos de rastreio /
--  status, notifica o cliente por e-mail e guarda comentários
--  (do Sistema e manuais). Botões: Realizar Tratativa / Fechar.
-- ------------------------------------------------------------
create table if not exists cmp_ocorrencias (
  id                    bigint generated always as identity primary key,
  order_id              bigint references cmp_orders(id) on delete cascade,
  tipo                  text not null,               -- ver TIPOS em lib/ocorrencias.js
  status                text default 'aberta',        -- aberta | tratativa | fechada
  nota_fiscal           text,
  auto                  boolean default false,        -- aberta automaticamente pelo sistema
  notif_cliente         boolean default false,        -- cliente notificado por e-mail?
  notif_cliente_em      timestamptz,
  notif_transportadora  boolean default false,
  comentarios           jsonb default '[]'::jsonb,    -- [{autor:'sistema'|'usuario', texto, em}]
  criada_em             timestamptz default now(),
  fechada_em            timestamptz,
  updated_at            timestamptz default now()
);
create index if not exists idx_cmp_ocorr_order  on cmp_ocorrencias(order_id);
create index if not exists idx_cmp_ocorr_status on cmp_ocorrencias(status);

alter table cmp_ocorrencias enable row level security;

-- ------------------------------------------------------------
--  RLS: as funções /api usam a SERVICE ROLE KEY (ignora RLS).
--  A página pública do cliente NÃO acessa o banco direto — ela
--  passa por /api/rastreio-lookup. Então mantemos RLS ligado e
--  sem policies públicas (acesso só via service role no backend).
-- ------------------------------------------------------------
alter table cmp_orders          enable row level security;
alter table cmp_events          enable row level security;
alter table cmp_rules           enable row level security;
alter table cmp_status_history  enable row level security;

-- ------------------------------------------------------------
--  Regras padrão (equivalentes às do cademeupedido).
--  Ajuste os prefixos de SKU (BORD/PERS) para os seus reais.
-- ------------------------------------------------------------
insert into cmp_rules (name, enabled, priority, when_json, then_json)
select * from (values
  ('Entrega local (Personalizada) sem bordado -> Entregue em 3 dias', true, 10,
   '{"carrier":["local"],"statusIn":["enviado"],"skuNotContains":["BORD","PERS"],"daysSinceSentGte":3}'::jsonb,
   '{"setStatus":"entregue","syncLI":true,"notifyCustomer":true}'::jsonb),
  ('Entrega local (Personalizada) COM bordado -> Entregue em 6 dias', true, 11,
   '{"carrier":["local"],"statusIn":["enviado"],"skuContains":["BORD","PERS"],"daysSinceSentGte":6}'::jsonb,
   '{"setStatus":"entregue","syncLI":true,"notifyCustomer":true}'::jsonb),
  ('Correios sem rastreio há 2 dias -> alerta interno', true, 50,
   '{"carrier":["correios"],"statusIn":["enviado"],"noTrackingCode":true,"daysSinceSentGte":2}'::jsonb,
   '{"alertInternal":true}'::jsonb)
) as v(name, enabled, priority, when_json, then_json)
where not exists (select 1 from cmp_rules);
