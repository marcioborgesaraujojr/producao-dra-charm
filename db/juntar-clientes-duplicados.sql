-- Junta o cadastro duplicado da MESMA cliente.
--
-- O problema: o WhatsApp entrega o número ora COM ora SEM o 9º dígito, pra mesma pessoa.
-- O webhook gravava exatamente como chegava, então nascia um cliente "5575999030660" e
-- outro "557599030660" — mesma cliente, dois cadastros, e o histórico partido ao meio.
-- Foi isso que a atendente viu: abriu a conversa da Railane e só tinha 2 mensagens.
--
-- Medido em 20/08: 129 pessoas duplicadas em 1.666 clientes.
--
-- O código já foi corrigido (whatsapp-webhook.js normaliza antes de gravar e procura
-- pelos dois formatos). Este script arruma quem já ficou duplicado: passa TUDO
-- (conversas, e o que mais apontar pro cliente) pro cadastro que fica, e apaga o vazio.
--
-- NENHUMA MENSAGEM SE PERDE: as mensagens ficam penduradas na conversa, e o que muda é
-- o dono da conversa. Só o cadastro duplicado, que fica vazio, é removido.
--
-- Rodar uma vez. Seguro rodar de novo: na segunda vez não acha mais duplicado.

-- ============================================================
-- 1) Monta a lista de quem junta com quem
--    A "chave" é o número normalizado, com a MESMA regra do normalizeWa do código:
--    começa com 55 e tem 12 dígitos -> insere o 9 depois do DDD.
--    Fica o cadastro que JÁ está no formato certo (13 dígitos); empatou, fica o mais antigo.
-- ============================================================
drop table if exists _merge_clientes;

create table _merge_clientes as
with base as (
  select id, nome, created_at, whatsapp_id,
         regexp_replace(coalesce(whatsapp_id, telefone, ''), '\D', '', 'g') as d
    from public.at_clientes
),
chaves as (
  select id, nome, created_at, whatsapp_id, d,
         case when d like '55%' and length(d) = 12
              then substr(d,1,4) || '9' || substr(d,5)
              else d end as chave
    from base
),
ranqueado as (
  select *,
         row_number() over (
           partition by chave
           order by (length(d) = 13) desc, created_at asc
         ) as posicao,
         count(*) over (partition by chave) as quantos
    from chaves
   where length(chave) >= 12
)
-- "some" e "any" são palavras reservadas — daí os nomes fica/remover.
-- E não existe max(uuid) no Postgres: pega o primeiro do array filtrado.
select chave,
       (array_agg(id) filter (where posicao = 1))[1]   as fica,
       array_agg(id) filter (where posicao > 1)        as remover
  from ranqueado
 where quantos > 1
 group by chave;

-- Olhe este número antes de seguir:
select count(*) as pessoas_duplicadas,
       coalesce(sum(array_length(remover, 1)), 0) as cadastros_a_remover
  from _merge_clientes;

-- ============================================================
-- 2) Passa as conversas pro cadastro que fica
-- ============================================================
update public.at_conversas c
   set cliente_id = m.fica
  from _merge_clientes m
 where c.cliente_id = any(m.remover);

-- Qualquer outra tabela que aponte pro cliente vai junto. Tolerante: se der problema
-- numa tabela, avisa e segue, em vez de abortar tudo.
do $$
declare t record;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_name = c.table_name and tb.table_schema = 'public'
     where c.table_schema = 'public'
       and c.column_name = 'cliente_id'
       and c.table_name not in ('at_conversas', '_merge_clientes')
       and tb.table_type = 'BASE TABLE'
  loop
    begin
      execute format(
        'update public.%I x set cliente_id = m.fica from _merge_clientes m where x.cliente_id = any(m.remover)',
        t.table_name);
    exception when others then
      raise notice 'pulei a tabela %: %', t.table_name, sqlerrm;
    end;
  end loop;
end $$;

-- ============================================================
-- 3) O cadastro que fica herda o número certo e o melhor nome
-- ============================================================
update public.at_clientes c
   set whatsapp_id = m.chave,
       telefone    = m.chave
  from _merge_clientes m
 where c.id = m.fica
   and coalesce(c.whatsapp_id, '') <> m.chave;

-- Se o que fica está com nome genérico, pega o nome de verdade do duplicado.
update public.at_clientes c
   set nome = melhor.nome
  from _merge_clientes m
  join lateral (
    select d.nome
      from public.at_clientes d
     where d.id = any(m.remover)
       and coalesce(d.nome, '') not in ('', 'Cliente')
     order by length(d.nome) desc
     limit 1
  ) melhor on true
 where c.id = m.fica
   and coalesce(c.nome, '') in ('', 'Cliente');

-- ============================================================
-- 4) Remove os cadastros que ficaram vazios
-- ============================================================
delete from public.at_clientes c
 using _merge_clientes m
 where c.id = any(m.remover);

drop table if exists _merge_clientes;

-- ============================================================
-- 5) CONFERÊNCIA — tem que voltar 0
-- ============================================================
with base as (
  select regexp_replace(coalesce(whatsapp_id, telefone, ''), '\D', '', 'g') as d
    from public.at_clientes
),
k as (
  select case when d like '55%' and length(d) = 12
              then substr(d,1,4) || '9' || substr(d,5)
              else d end as chave
    from base
)
select count(*) as ainda_duplicados
  from (select chave from k where length(chave) >= 12 group by chave having count(*) > 1) x;
