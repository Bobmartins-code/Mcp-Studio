-- Ideias de conteudo que a loja marcou ("Ja gravei" ou "Nao curti"): o Agente de Ideias nao repete
-- e aprende com elas. A propria loja le e grava as suas; o servidor le com a chave de servico.
create table if not exists public.ideias_marcadas (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  titulo text not null,
  status text not null check (status in ('gravei', 'nao_curti')),
  criado_em timestamptz not null default now(),
  primary key (user_id, titulo)
);
alter table public.ideias_marcadas enable row level security;
drop policy if exists "dona le as suas" on public.ideias_marcadas;
create policy "dona le as suas" on public.ideias_marcadas for select to authenticated
  using (user_id = auth.uid() or (auth.jwt() ->> 'email') = 'rrubensmartins@gmail.com');
drop policy if exists "dona grava as suas" on public.ideias_marcadas;
create policy "dona grava as suas" on public.ideias_marcadas for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "dona apaga as suas" on public.ideias_marcadas;
create policy "dona apaga as suas" on public.ideias_marcadas for delete to authenticated
  using (user_id = auth.uid());
revoke all on public.ideias_marcadas from anon;
