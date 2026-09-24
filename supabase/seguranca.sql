-- =====================================================================
--  REFORCO DE SEGURANCA DO BANCO (MCP Studio)
--  - admin reconhecido pelo ID da conta (nao pelo e-mail) e, depois que a
--    verificacao em 2 etapas for ativada, so com a sessao verificada (aal2)
--  - tokens da Meta e do Reportei Connect: nenhum usuario le pelo navegador;
--    so o servidor (chave de servico) acessa, e eles ficam criptografados
--  - e-mails das clientes deixam de ser publicos
--  - funcoes internas nao podem mais ser chamadas de fora
--  - registro de auditoria das acoes do admin
-- =====================================================================

-- ---------- quem e o admin ----------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select auth.uid()) = '1c4d2a2b-c60b-4e99-982b-5b4a09e8cc0f'::uuid
    and (
      -- com a verificacao em 2 etapas ativa, exige a sessao verificada
      coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      )
    ),
    false
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- perfis: cada um ve so o proprio (antes era publico) ----------
drop policy if exists "Perfis visiveis" on public.profiles;
drop policy if exists "perfil proprio ou admin" on public.profiles;
create policy "perfil proprio ou admin" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
revoke all on public.profiles from anon;

-- ---------- projetos e publico: so do proprio usuario ----------
drop policy if exists "projetos_select_own" on public.projetos;
drop policy if exists "projetos_insert_own" on public.projetos;
drop policy if exists "projetos_update_own" on public.projetos;
drop policy if exists "projetos_delete_own" on public.projetos;
create policy "projetos_select_own" on public.projetos for select to authenticated using (user_id = (select auth.uid()));
create policy "projetos_insert_own" on public.projetos for insert to authenticated with check (user_id = (select auth.uid()));
create policy "projetos_update_own" on public.projetos for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "projetos_delete_own" on public.projetos for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.projetos from anon;

drop policy if exists "perfil_select_own" on public.perfil_publico;
drop policy if exists "perfil_insert_own" on public.perfil_publico;
drop policy if exists "perfil_update_own" on public.perfil_publico;
create policy "perfil_select_own" on public.perfil_publico for select to authenticated using (user_id = (select auth.uid()));
create policy "perfil_insert_own" on public.perfil_publico for insert to authenticated with check (user_id = (select auth.uid()));
create policy "perfil_update_own" on public.perfil_publico for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.perfil_publico from anon;

-- ---------- aprendizado entre lojas: todos leem os padroes, so o admin grava ----------
drop policy if exists "logados leem padroes" on public.aprendizado_agente;
drop policy if exists "admin grava padroes" on public.aprendizado_agente;
create policy "logados leem padroes" on public.aprendizado_agente for select to authenticated using (true);
create policy "admin insere padroes" on public.aprendizado_agente for insert to authenticated with check ((select public.is_admin()));
create policy "admin altera padroes" on public.aprendizado_agente for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin apaga padroes" on public.aprendizado_agente for delete to authenticated using ((select public.is_admin()));
revoke all on public.aprendizado_agente from anon;

-- ---------- dossie da conta: a cliente le o dela, o admin le e grava ----------
drop policy if exists "cliente le a propria conta" on public.contas_meta;
drop policy if exists "admin grava contas" on public.contas_meta;
create policy "cliente le a propria conta" on public.contas_meta for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "admin insere contas" on public.contas_meta for insert to authenticated with check ((select public.is_admin()));
create policy "admin altera contas" on public.contas_meta for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin apaga contas" on public.contas_meta for delete to authenticated using ((select public.is_admin()));
revoke all on public.contas_meta from anon;

-- ---------- tokens (Meta e Reportei Connect): ninguem le pelo navegador, nem o admin ----------
-- sem politicas = nenhum acesso para usuarios; so o servidor, com a chave de servico
drop policy if exists "so admin" on public.meta_conexao;
drop policy if exists "so admin" on public.connect_clientes;
revoke all on public.meta_conexao from anon, authenticated;
revoke all on public.connect_clientes from anon, authenticated;

-- tabela antiga, vazia e sem uso: removida (so se estiver mesmo vazia)
do $$
begin
  if to_regclass('public.meta_tokens') is not null and not exists (select 1 from public.meta_tokens) then
    drop table public.meta_tokens;
  end if;
end $$;

-- ---------- funcoes do painel admin ----------
create or replace function public.get_all_users()
returns table(id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at
  from auth.users u
  where public.is_admin()
  order by u.last_sign_in_at desc nulls last;
$$;

create or replace function public.get_all_projetos()
returns setof public.projetos
language sql
security definer
set search_path = ''
as $$
  select * from public.projetos
  where public.is_admin()
  order by criado_em desc;
$$;

create or replace function public.delete_user(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'acesso negado';
  end if;
  if target = (select auth.uid()) then
    raise exception 'o admin nao pode apagar a propria conta';
  end if;
  insert into public.auditoria(admin_id, acao, alvo) values ((select auth.uid()), 'apagou usuario', target::text);
  delete from public.projetos where user_id = target;
  delete from auth.users where id = target;
end;
$$;

-- so usuarios logados chamam; a checagem de admin acontece dentro
revoke all on function public.get_all_users() from public, anon;
revoke all on function public.get_all_projetos() from public, anon;
revoke all on function public.delete_user(uuid) from public, anon;
grant execute on function public.get_all_users() to authenticated;
grant execute on function public.get_all_projetos() to authenticated;
grant execute on function public.delete_user(uuid) to authenticated;

-- funcoes internas (gatilhos): ninguem chama de fora
alter function public.handle_new_user() set search_path = '';
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

-- sobra antiga, sem uso e chamavel sem login
drop function if exists public.encrypt_token(text);

-- ---------- auditoria: o que o admin fez e quando ----------
create table if not exists public.auditoria (
  id bigint generated always as identity primary key,
  admin_id uuid not null,
  acao text not null,
  alvo text,
  detalhe jsonb,
  criado_em timestamptz not null default now()
);
alter table public.auditoria enable row level security;
drop policy if exists "admin le auditoria" on public.auditoria;
drop policy if exists "admin registra auditoria" on public.auditoria;
create policy "admin le auditoria" on public.auditoria for select to authenticated using ((select public.is_admin()));
create policy "admin registra auditoria" on public.auditoria for insert to authenticated with check ((select public.is_admin()) and admin_id = (select auth.uid()));
revoke all on public.auditoria from anon;
