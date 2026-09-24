-- Reportei Connect: cada cliente do MCP Studio vira um "customer" no Connect.
-- O api_token dele so aparece uma vez (na criacao) e da acesso aos dados dela,
-- por isso esta tabela so e lida e gravada pelo admin.
-- Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.

create table if not exists public.connect_clientes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  customer_uuid text not null unique,
  api_token text not null,
  nome text,
  criado_em timestamptz not null default now()
);
alter table public.connect_clientes enable row level security;
drop policy if exists "so admin" on public.connect_clientes;
create policy "so admin" on public.connect_clientes
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com');
