-- Marca quem saiu da empresa (botão "Desativar acesso" na ficha do usuário).
-- O login é bloqueado no Auth; estas colunas servem pra tela mostrar o estado.
--
-- Rodar uma vez no SQL Editor do Supabase. É seguro rodar de novo.

alter table public.profiles
  add column if not exists ativo boolean not null default true;

alter table public.profiles
  add column if not exists desativado_em timestamptz;

comment on column public.profiles.ativo is
  'false = pessoa saiu da empresa. O login fica bloqueado no Auth e o histórico dela continua intacto.';

-- Conferência:
-- select email, full_name, setor, ativo, desativado_em from public.profiles order by ativo, email;
