-- 20261022130000_0513_nota_interna_somente_autor_ou_manager.sql
-- 0513 — RLS por operação em `conversation_notes`: editar/apagar só o autor ou
-- manager+ (issue #66, item 4 da triagem #36).
--
-- Porte do upstream melgarafael/DeskcommCRM, commit d9c3afdfc (migration upstream
-- 0505_nota_interna_somente_autor_ou_manager, issues upstream #1870 e #1868). Número
-- e timestamp são do fork: aqui a 0505 e a 0509 são migrations Green. Os números de
-- issue abaixo são do upstream.
--
-- ─── O buraco que isto fecha ────────────────────────────────────────────────
-- A #1868 do upstream (0478) fez a nota seguir a visibilidade da conversa na leitura e na
-- escrita, via `fn_can_view_conversation`. Mas a ESCRITA continuava numa policy
-- única `for all` (`conversation_notes_write`) cuja condição era org + papel +
-- visibilidade — sem distinguir o AUTOR. Entre quem VÊ a conversa, qualquer
-- `agent` podia pelo PostgREST (com a anon key e o JWT da sessão dele) editar
-- ou apagar a nota de um colega, inclusive uma nota sigilosa, sem passar pela
-- rota. A rota DELETE (`app/api/v1/conversations/[id]/notes/[noteId]/route.ts`)
-- já exigia autor+ ou manager+ no app, mas o banco era porta tão aberta quanto
-- ela — o PostgREST fala com a tabela direto pelo JWT (ver 0150).
--
-- ─── A regra ───────────────────────────────────────────────────────────────
--   INSERT: org + papel `agent` + ver a conversa + autor = a própria sessão.
--   UPDATE/DELETE: org + papel `agent` + ver a conversa E (é o autor da nota
--                  OU manager+ da organização).
-- A coluna do autor é `created_by_user_id` (desde a 0063; a própria rota
-- grava `created_by_user_id: user.id` ao criar).
--
-- ─── Por que por operação (formato 0464/0489/0490) ─────────────────────────
-- Policies são OR e `for all` concede SELECT junto — além de a condição de
-- UPDATE/DELETE ser MENOS restritiva que a de INSERT (manager+), cada operação
-- precisa da SUA policy para o PostgREST aplicar a regra certa por verbo.
--
-- Idempotente: `drop policy if exists` + `create policy` (a cadeia não sobe do
-- zero — o clone atualiza aplicando esta migration e o apêndice do baseline,
-- que refletem o mesmo estado final). Nenhuma função nova, nenhum dado tocado.
--
-- ─── Por que a definição antiga sai do corpo do dump ───────────────────────
-- `conversation_notes_write` (for all) não pode sobreviver no dump: cada
-- `update.sh` a instalaria ANTES da regra final, reabrindo por uma janela o
-- mesmo buraco — o gate `baseline-nao-constroi-o-que-derruba` chama isso de
-- "definição intermediária". O `drop policy if exists` do apêndice cuida do
-- clone antigo.

-- ─── A policy antiga sai PRIMEIRO ─────────────────────────────────────────
-- Policies permissivas são OR: se a `for all` da 0478 ficasse ao lado das três
-- por operação, ela seguiria deixando qualquer agent que vê a conversa editar e
-- apagar a nota de um colega, e as regras novas não valeriam nada. O baseline já
-- a derrubava; a migration (o caminho do Supabase CLI) não, e o upstream também
-- não. Revisão do PR #69 (P1), medido em
-- `tests/invariants/nota-interna-somente-autor-ou-manager.test.ts`.
drop policy if exists "conversation_notes_write" on public.conversation_notes;

-- ─── INSERT: autor = a própria sessão ──────────────────────────────────────
-- O autor da nota nasce = quem está criando; ninguém cria nota em nome de
-- outro. Mantém o piso `agent` e a visibilidade da conversa herdados da 0478.
drop policy if exists "conversation_notes_insert" on public.conversation_notes;
create policy "conversation_notes_insert" on public.conversation_notes
  for insert
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and created_by_user_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

-- ─── UPDATE: autor OU manager+ ─────────────────────────────────────────────
-- `using` diz quais linhas a sessão pode tocar; `with check` diz qual estado
-- ela pode gravar. O autor continua autor (criado_by permanece), e o manager+
-- pode editar (o `author = auth.uid() OR manager` passa nos dois). O manager
-- editando a nota de outro mantém o autor original — a condição não exige
-- `created_by_user_id = auth.uid()` no with-check porque o manager+, por
-- definição, não é o autor da linha que está editando.
drop policy if exists "conversation_notes_update" on public.conversation_notes;
create policy "conversation_notes_update" on public.conversation_notes
  for update
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

-- ─── DELETE: autor OU manager+ ─────────────────────────────────────────────
-- Sem `with check` (não há linha nova a validar); o `using` decide o que pode
-- sumir. Deleção em cascata de FK e o motor (service_key) não passam por RLS.
drop policy if exists "conversation_notes_delete" on public.conversation_notes;
create policy "conversation_notes_delete" on public.conversation_notes
  for delete
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );
