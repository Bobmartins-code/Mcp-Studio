-- =====================================================================
--  LEVA 3 (set/2026): plano da semana, lojas de referencia e veredito por video
--  - semana: ideias que a dona colocou em cada dia (ela marca, move e tira)
--  - lojas.referencias: ate 5 perfis publicos que a dona admira
--  - contas_meta.referencias: os melhores posts desses perfis (gravado pelo servidor)
--  - vereditos: o "como melhorar este video" de cada post ou anuncio (guardado 7 dias)
--  Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.
-- =====================================================================

create table if not exists public.semana (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  dia date not null,
  titulo text not null check (char_length(titulo) <= 300),
  ideia jsonb check (pg_column_size(ideia) < 30000),
  feito boolean not null default false,
  criado_em timestamptz not null default now()
);
create index if not exists semana_loja_dia on public.semana (user_id, dia);
alter table public.semana enable row level security;
drop policy if exists "semana: dona e admin leem" on public.semana;
create policy "semana: dona e admin leem" on public.semana for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists "semana: dona coloca" on public.semana;
create policy "semana: dona coloca" on public.semana for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "semana: dona muda" on public.semana;
create policy "semana: dona muda" on public.semana for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "semana: dona tira" on public.semana;
create policy "semana: dona tira" on public.semana for delete to authenticated using (user_id = (select auth.uid()));

alter table public.lojas add column if not exists referencias text[];
alter table public.contas_meta add column if not exists referencias jsonb;

create table if not exists public.vereditos (
  user_id uuid not null references auth.users on delete cascade,
  chave text not null,
  resposta jsonb,
  criado_em timestamptz not null default now(),
  primary key (user_id, chave)
);
alter table public.vereditos enable row level security;
drop policy if exists "vereditos: dona e admin leem" on public.vereditos;
create policy "vereditos: dona e admin leem" on public.vereditos for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
