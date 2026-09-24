-- =====================================================================
--  LOJAS, RECADOS E NUMEROS ATUALIZADOS
--  - lojas: dados de cada loja (o login da dona e a conta dela no auth).
--    O admin cadastra a loja com o e-mail da dona; o servidor cria o login
--    e a dona entra pelo link de convite.
--  - recados: mensagens do admin para a loja (aparecem no app dela)
--  - contas_meta.metricas: numeros de posts e anuncios, atualizados todo dia
--  - metricas_diarias: uma foto por dia de cada loja (para mostrar se subiu)
--  Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.
-- =====================================================================

-- ---------- lojas ----------
create table if not exists public.lojas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  nicho text,
  site text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.lojas enable row level security;
drop policy if exists "loja le a propria" on public.lojas;
drop policy if exists "admin insere lojas" on public.lojas;
drop policy if exists "admin altera lojas" on public.lojas;
drop policy if exists "admin apaga lojas" on public.lojas;
create policy "loja le a propria" on public.lojas for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "admin insere lojas" on public.lojas for insert to authenticated with check ((select public.is_admin()));
create policy "admin altera lojas" on public.lojas for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin apaga lojas" on public.lojas for delete to authenticated using ((select public.is_admin()));
revoke all on public.lojas from anon;

-- ---------- recados do admin para a loja ----------
create table if not exists public.recados (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  projeto_id uuid references public.projetos(id) on delete cascade,
  texto text not null check (char_length(texto) between 1 and 1000),
  criado_em timestamptz not null default now(),
  lido_em timestamptz
);
create index if not exists recados_user_idx on public.recados(user_id, criado_em desc);
alter table public.recados enable row level security;
drop policy if exists "loja le os seus recados" on public.recados;
drop policy if exists "loja marca recado como lido" on public.recados;
drop policy if exists "admin insere recados" on public.recados;
drop policy if exists "admin apaga recados" on public.recados;
create policy "loja le os seus recados" on public.recados for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "loja marca recado como lido" on public.recados for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "admin insere recados" on public.recados for insert to authenticated with check ((select public.is_admin()));
create policy "admin apaga recados" on public.recados for delete to authenticated using ((select public.is_admin()));
revoke all on public.recados from anon;
-- a loja so consegue mudar a data de leitura, nunca o texto
revoke update on public.recados from authenticated;
grant update (lido_em) on public.recados to authenticated;

-- ---------- numeros atualizados todo dia (gravados so pelo servidor) ----------
alter table public.contas_meta add column if not exists metricas jsonb;
alter table public.contas_meta add column if not exists metricas_em timestamptz;

create table if not exists public.metricas_diarias (
  user_id uuid not null references auth.users(id) on delete cascade,
  dia date not null,
  resumo jsonb not null,
  primary key (user_id, dia)
);
alter table public.metricas_diarias enable row level security;
drop policy if exists "loja le o proprio historico" on public.metricas_diarias;
create policy "loja le o proprio historico" on public.metricas_diarias for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
-- sem politica de escrita: so o servidor (chave de servico) grava
revoke all on public.metricas_diarias from anon;
revoke insert, update, delete on public.metricas_diarias from authenticated;
