-- Aprendizado do Agente MCP entre lojas
-- Guarda SO padroes por nicho e metodo. Nao guarda nome de loja, cliente,
-- video nem texto de roteiro. Todos os usuarios logados podem ler;
-- so o admin grava (pelo botao "Atualizar aprendizado do agente" no painel).
-- Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.

create table if not exists public.aprendizado_agente (
  chave text primary key,              -- "nicho|metodo", ex: "moda feminina|dsb"
  nicho text not null,                 -- nicho ou "geral"
  metodo text not null,                -- fftopo, ffmeio, fffundo, dsb, angulo
  padroes text not null,               -- padroes abstratos separados por " | "
  amostras int not null default 0,     -- quantos roteiros de resultado foram estudados
  lojas int not null default 0,        -- de quantas lojas diferentes (minimo 2)
  atualizado_em timestamptz not null default now()
);

alter table public.aprendizado_agente enable row level security;

drop policy if exists "logados leem padroes" on public.aprendizado_agente;
create policy "logados leem padroes" on public.aprendizado_agente
  for select to authenticated using (true);

drop policy if exists "admin grava padroes" on public.aprendizado_agente;
create policy "admin grava padroes" on public.aprendizado_agente
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com');
