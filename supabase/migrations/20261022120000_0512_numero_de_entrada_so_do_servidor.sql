-- 0512: o número de entrada só se resolve no servidor, e public tem search_path fixo
--
-- Porte do item 3 da triagem #36 (issue #65). Origem: upstream melgarafael/DeskcommCRM,
-- commit b31ff5ce8, migration upstream 0502_avisos_do_security_advisor. O número e o
-- timestamp são do fork: aqui a 0502 é uma migration Green.
--
-- (1) `fn_resolve_inbound_number(text)` é SECURITY DEFINER e devolve organização,
--     modo de roteamento, agente e atendente de reserva do número discado, sem
--     conferir a organização de quem chama. A 0347 revogou public/anon e concedeu a
--     service_role, mas o grant a authenticated vem do DEFAULT PRIVILEGES do baseline
--     e ficou. Pelo PostgREST, qualquer usuário logado descobria organização e agente
--     de qualquer número de qualquer tenant. O único chamador é o worker de voz
--     (`workers/voice-agent`, cliente admin).
--
-- (2) `function_search_path_mutable`: 7 funções de public sem `search_path` fixo,
--     medido no baseline do fork num Postgres descartável (as mesmas 7 do upstream).
--     Nenhuma lê tabela sem schema: 6 só usam built-ins e `fn_resolve_inbound_number`
--     já qualifica `public.phone_numbers`. Então `search_path = ''` não muda
--     comportamento. A que importa é a definer.
--
-- (3) `rls_auto_enable()` não está no baseline, mas o Supabase a cria em projeto novo
--     com EXECUTE para authenticated. Só existe em alguns bancos: o bloco confere antes.
--
-- Idempotente: `alter function ... set` e `revoke` de privilégio ausente são no-op.
-- Não cria função, então não há revoke de criação a fazer.

alter function public.fn_agent_versions_immutable() set search_path = '';
alter function public.fn_ai_agent_version_content_immutable() set search_path = '';
alter function public.fn_contato_anonimizado_limpa_campos_personalizados() set search_path = '';
alter function public.fn_degraus_de_lembrete_validos(integer[]) set search_path = '';
alter function public.fn_corpos_de_lembrete_validos(jsonb) set search_path = '';
alter function public.fn_lancamento_pago_e_imutavel() set search_path = '';
alter function public.fn_resolve_inbound_number(text) set search_path = '';

revoke execute on function public.fn_resolve_inbound_number(text) from public, anon, authenticated;
grant execute on function public.fn_resolve_inbound_number(text) to service_role;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end
$$;
