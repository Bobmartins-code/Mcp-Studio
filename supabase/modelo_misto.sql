-- =====================================================================
--  MODELO MISTO DOS AGENTES (set/2026)
--  - acessos: ultima vez que a dona abriu o app (a sessao fica guardada,
--    entao o "ultimo login" do Supabase nao serve para saber quem usa)
--  - uso_ia: quanto cada chamada de IA gastou, por loja e por funcao
--  - lojas: produtos e ofertas do momento (a versao da dona vale mais que
--    a da consultoria) e ajustes da consultoria sobre o publico
--  - contas_meta.dossie_job: a analise diaria em lote (etapa e lote na Anthropic)
--  Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.
-- =====================================================================

alter table public.contas_meta add column if not exists dossie_job jsonb;

alter table public.lojas add column if not exists produtos_dona text;
alter table public.lojas add column if not exists produtos_dona_em timestamptz;
alter table public.lojas add column if not exists produtos_admin text;
alter table public.lojas add column if not exists publico_admin text;

-- ultimo acesso real ao app
create table if not exists public.acessos (
  user_id uuid primary key references auth.users on delete cascade,
  em timestamptz not null default now()
);
alter table public.acessos enable row level security;
drop policy if exists "acessos: admin le" on public.acessos;
create policy "acessos: admin le" on public.acessos for select to authenticated using ((select public.is_admin()));

create or replace function public.registrar_acesso()
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.acessos (user_id, em) values (auth.uid(), now())
  on conflict (user_id) do update set em = now();
$$;
revoke all on function public.registrar_acesso() from public, anon;
grant execute on function public.registrar_acesso() to authenticated;

-- a dona conta o que quer vender agora (so esse campo; o resto da loja continua com o admin)
create or replace function public.salvar_produtos_da_loja(p_texto text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sem login'; end if;
  if char_length(coalesce(p_texto, '')) > 2000 then raise exception 'texto longo demais'; end if;
  insert into public.lojas (user_id, nome, produtos_dona, produtos_dona_em)
  values (auth.uid(), coalesce((select c.nome from public.connect_clientes c where c.user_id = auth.uid()), 'Minha loja'), nullif(trim(p_texto), ''), now())
  on conflict (user_id) do update set produtos_dona = nullif(trim(p_texto), ''), produtos_dona_em = now(), atualizado_em = now();
end $$;
revoke all on function public.salvar_produtos_da_loja(text) from public, anon;
grant execute on function public.salvar_produtos_da_loja(text) to authenticated;

-- gasto de IA (gravado so pelo servidor, com a chave de servico)
create table if not exists public.uso_ia (
  id bigserial primary key,
  user_id uuid,
  funcao text not null,
  modelo text not null,
  entrada integer not null default 0,
  saida integer not null default 0,
  cache_leitura integer not null default 0,
  cache_escrita integer not null default 0,
  lote boolean not null default false,
  custo_usd numeric(12, 6) not null default 0,
  criado_em timestamptz not null default now()
);
create index if not exists uso_ia_loja_data on public.uso_ia (user_id, criado_em desc);
alter table public.uso_ia enable row level security;
drop policy if exists "uso_ia: admin le" on public.uso_ia;
create policy "uso_ia: admin le" on public.uso_ia for select to authenticated using ((select public.is_admin()));
