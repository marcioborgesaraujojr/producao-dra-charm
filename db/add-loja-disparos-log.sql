-- Fila de envios POR LOJA.
--
-- Hoje o at_disparos_log guarda todo disparo de gatilho (Loja Integrada e TroqueCommerce)
-- misturado, sem dizer de qual loja veio. Esta coluna separa.
--
-- Rodar uma vez no SQL Editor do Supabase. É seguro rodar de novo.

alter table public.at_disparos_log
  add column if not exists loja text;

comment on column public.at_disparos_log.loja is
  'loja_integrada | troquecommerce | fidelizar — de onde veio o evento que disparou o aviso.';

-- Backfill do que já existe:
-- a TroqueCommerce usa códigos NUMÉRICOS em evento_key (1, 6, 11...); a Loja Integrada usa
-- texto (pedido_pago, pedido_enviado...). Dá pra separar com segurança por isso.
update public.at_disparos_log
   set loja = case when evento_key ~ '^[0-9]+$' then 'troquecommerce' else 'loja_integrada' end
 where loja is null;

create index if not exists at_disparos_log_loja_criado
  on public.at_disparos_log (loja, created_at desc);

-- Conferência:
-- select loja, count(*) from public.at_disparos_log group by loja order by 2 desc;
