-- Conexao com a Meta e dossie de cada cliente (time de agentes)
-- Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.

-- 1) Conexao do admin com a Meta (uma linha so). Ninguem alem do admin le o token.
create table if not exists public.meta_conexao (
  id int primary key default 1 check (id = 1),
  access_token text not null,
  nome text,
  meta_user_id text,
  expires_at timestamptz,
  atualizado_em timestamptz not null default now()
);
alter table public.meta_conexao enable row level security;
drop policy if exists "so admin" on public.meta_conexao;
create policy "so admin" on public.meta_conexao
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com');

-- 2) Qual Instagram e qual conta de anuncios pertencem a cada cliente + o dossie do time de agentes
create table if not exists public.contas_meta (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ig_id text,
  ig_username text,
  ad_account_id text,
  ad_account_nome text,
  dossie jsonb,
  status text,
  atualizado_em timestamptz not null default now()
);
alter table public.contas_meta enable row level security;
drop policy if exists "cliente le a propria conta" on public.contas_meta;
create policy "cliente le a propria conta" on public.contas_meta
  for select to authenticated
  using (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com');
drop policy if exists "admin grava contas" on public.contas_meta;
create policy "admin grava contas" on public.contas_meta
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com');

-- 3) Meta no time de agentes (so leitura): o que ja veio da Meta por loja (capas, textos e falas
--    dos anuncios, falas e tempo assistido dos Reels, comentarios) e a pausa automatica
alter table public.contas_meta add column if not exists meta jsonb;
alter table public.meta_conexao add column if not exists pausa_ate timestamptz;
alter table public.meta_conexao add column if not exists pausa_motivo text;
alter table public.meta_conexao add column if not exists erro text;
