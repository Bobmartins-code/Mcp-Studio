-- =====================================================================
--  MEMORIA DO TIME DE AGENTES E CONVERSA COM O TIME (set/2026)
--  - contas_meta.memoria: o que o time aprendeu com a propria loja
--    (ideias que viraram post e o resultado, padroes das capas, gosto da dona)
--  - gostei: ideias e roteiros que a dona marcou com "Gostei"
--  - conversas: pedidos da dona no chat de ideias e de roteiros (e a resposta)
--  Cada loja aprende so com os proprios dados.
--  Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.
-- =====================================================================

alter table public.contas_meta add column if not exists memoria jsonb;

-- "Gostei" da dona (ela mesma marca e desmarca; o admin so le)
create table if not exists public.gostei (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  tipo text not null check (tipo in ('ideia', 'roteiro')),
  chave text not null check (char_length(chave) <= 200),
  titulo text check (char_length(titulo) <= 300),
  conteudo jsonb,
  criado_em timestamptz not null default now(),
  unique (user_id, tipo, chave)
);
create index if not exists gostei_loja_data on public.gostei (user_id, criado_em desc);
alter table public.gostei enable row level security;
drop policy if exists "gostei: dona le" on public.gostei;
create policy "gostei: dona le" on public.gostei for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists "gostei: dona marca" on public.gostei;
create policy "gostei: dona marca" on public.gostei for insert to authenticated with check (user_id = (select auth.uid()) and pg_column_size(conteudo) < 20000);
drop policy if exists "gostei: dona desmarca" on public.gostei;
create policy "gostei: dona desmarca" on public.gostei for delete to authenticated using (user_id = (select auth.uid()));

-- conversa com o time (gravada so pelo servidor, com a chave de servico)
create table if not exists public.conversas (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  area text not null check (area in ('ideias', 'roteiros')),
  projeto_id text,
  pedido text not null,
  resposta jsonb,
  criado_em timestamptz not null default now()
);
create index if not exists conversas_loja_data on public.conversas (user_id, criado_em desc);
alter table public.conversas enable row level security;
drop policy if exists "conversas: dona e admin leem" on public.conversas;
create policy "conversas: dona e admin leem" on public.conversas for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
