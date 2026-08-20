-- Nome da atendente na bolha da mensagem (em vez do e-mail).
--
-- O que estava acontecendo: quando a atendente mandava mensagem, o servidor gravava
-- o E-MAIL dela no campo "autor". Aí, em cima de cada balão, aparecia
-- "jomila2000santos@gmail.com" em vez de "Camila".
--
-- Já foi corrigido em dois lugares:
--   1) o servidor (whatsapp-send / -media / -templates) agora grava o NOME;
--   2) a tela de Conversas troca e-mail por nome na hora de mostrar, então o
--      histórico antigo também já aparece certo, mesmo sem rodar este SQL.
--
-- Este script é o acabamento: arruma o que ficou gravado no banco, pra relatório
-- e auditoria também mostrarem nome. Pode rodar quantas vezes quiser.

-- ============================================================
-- 1) CONFIRA OS NOMES ANTES — é daqui que sai o que aparece na bolha
--    Se algum "nome_que_vai_aparecer" estiver com cara de e-mail
--    (ex.: "jomila2000santos"), arrume em Suíte > Usuários antes de seguir.
-- ============================================================
select email,
       full_name as nome_que_vai_aparecer,
       case when coalesce(full_name,'') = '' then 'SEM NOME — arrume'
            when full_name like '%@%'       then 'ESTA COM E-MAIL — arrume'
            when full_name = split_part(email,'@',1) then 'é o começo do e-mail — confira'
            else 'ok' end as situacao
  from public.profiles
 order by situacao, email;

-- ============================================================
-- 2) Troca e-mail por nome no histórico já gravado
--    Só mexe em quem tem perfil com nome de verdade. O resto fica como está.
-- ============================================================
update public.at_mensagens m
   set autor = p.full_name
  from public.profiles p
 where m.autor is not null
   and m.autor like '%@%'
   and lower(m.autor) = lower(p.email)
   and coalesce(p.full_name,'') <> ''
   and p.full_name not like '%@%';

-- ============================================================
-- 3) CONFERÊNCIA — quantas mensagens ainda estão com e-mail no autor
--    Se sobrar algo, é gente sem nome no perfil (volte no passo 1).
--    Mesmo assim a TELA já mostra nome; isto aqui é só o banco.
-- ============================================================
select count(*) as mensagens_ainda_com_email,
       count(distinct autor) as pessoas_sem_nome_no_perfil
  from public.at_mensagens
 where autor like '%@%';
