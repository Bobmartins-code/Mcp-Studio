-- =====================================================================
--  FALHAS (set/2026): cada erro que a dona viu (roteiro, chat, ideias,
--  analise do video...), gravado pelo servidor. O Painel Admin mostra as
--  falhas dos ultimos 7 dias por loja.
--  Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.
-- =====================================================================
create table if not exists public.falhas (
  id bigserial primary key,
  user_id uuid,
  onde text not null,
  erro text,
  criado_em timestamptz not null default now()
);
create index if not exists falhas_loja_data on public.falhas (user_id, criado_em desc);
alter table public.falhas enable row level security;
drop policy if exists "falhas: admin le" on public.falhas;
create policy "falhas: admin le" on public.falhas for select to authenticated using ((select public.is_admin()));
