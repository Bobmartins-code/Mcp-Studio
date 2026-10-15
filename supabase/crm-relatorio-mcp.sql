-- =====================================================================
--  RELATORIO FECHADO PARA O MCP STUDIO (roda no Supabase do CRM, nao no do MCP)
--  So totais somados: faturamento, numero de vendas, faixas de preco, dias
--  fortes, clientes que voltam e DDD. Nunca sai nome, telefone, e-mail ou
--  uma venda individual. So responde a quem tem o segredo do MCP (guardado
--  aqui so como hash; o segredo fica no Vercel do MCP).
-- =====================================================================

create table if not exists public.mcp_acesso (
  id int primary key default 1 check (id = 1),
  segredo_hash text not null,
  criado_em timestamptz not null default now()
);
alter table public.mcp_acesso enable row level security;
revoke all on table public.mcp_acesso from anon, authenticated;

create or replace function public.mcp_ok(p_segredo text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.mcp_acesso where id = 1 and segredo_hash = encode(extensions.digest(coalesce(p_segredo, ''), 'sha256'), 'hex'));
$$;
revoke all on function public.mcp_ok(text) from public, anon, authenticated;

-- faturamento de cada loja do CRM no periodo (p_inicio nulo = desde a primeira venda)
create or replace function public.mcp_faturamento(p_segredo text, p_inicio date, p_fim date)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.mcp_ok(p_segredo) then raise exception 'sem acesso'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('tenant', x.tenant_id, 'faturamento', x.fat, 'vendas', x.n, 'primeira_venda', x.pri, 'ultima_venda', x.ult)) from (
    select s.tenant_id,
      round(coalesce(sum(s.valor) filter (where s.data between coalesce(p_inicio, '1900-01-01'::date) and p_fim), 0), 2) as fat,
      count(*) filter (where s.data between coalesce(p_inicio, '1900-01-01'::date) and p_fim) as n,
      min(s.data) as pri, max(s.data) as ult
    from public.sales s where s.valor > 0 group by s.tenant_id) x), '[]'::jsonb);
end $$;
revoke all on function public.mcp_faturamento(text, date, date) from public;
grant execute on function public.mcp_faturamento(text, date, date) to anon;

-- padroes de venda de uma loja (ate 5 contas do CRM somadas), para o cerebro da loja
create or replace function public.mcp_vendas(p_segredo text, p_tenants uuid[])
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb;
begin
  if not public.mcp_ok(p_segredo) then raise exception 'sem acesso'; end if;
  if p_tenants is null or coalesce(array_length(p_tenants, 1), 0) not between 1 and 5 then raise exception 'lojas invalidas'; end if;
  with v as (
    select s.data, s.valor, s.contact_id from public.sales s
    where s.tenant_id = any(p_tenants) and s.valor > 0 and s.data <= hoje
  ),
  ano as (select * from v where data > hoje - 365),
  -- compra = dia em que a cliente comprou (pedidos do mesmo dia contam como 1 compra)
  compras as (select contact_id, data, sum(valor) as valor from v where contact_id is not null group by contact_id, data),
  primeira as (select contact_id, min(data) as d1, count(*) as n from compras group by contact_id),
  segunda as (select c.contact_id, min(c.data) as d2 from compras c join primeira p using (contact_id) where c.data > p.d1 group by c.contact_id)
  select jsonb_build_object(
    'primeira_venda', (select min(data) from v),
    'ultima_venda', (select max(data) from v),
    'd90', (select jsonb_build_object('faturamento', round(coalesce(sum(valor), 0), 2), 'vendas', count(*), 'ticket_medio', round(coalesce(avg(valor), 0), 2),
              'ticket_mediana', round(coalesce(percentile_cont(0.5) within group (order by valor), 0)::numeric, 2)) from v where data > hoje - 90),
    'd365', (select jsonb_build_object('faturamento', round(coalesce(sum(valor), 0), 2), 'vendas', count(*), 'ticket_medio', round(coalesce(avg(valor), 0), 2),
              'ticket_mediana', round(coalesce(percentile_cont(0.5) within group (order by valor), 0)::numeric, 2)) from ano),
    'faixas', (select coalesce(jsonb_agg(jsonb_build_object('faixa', z.f, 'vendas', z.n, 'faturamento', z.fat) order by z.o), '[]'::jsonb) from (
        select case when valor < 100 then 1 when valor < 150 then 2 when valor < 200 then 3 when valor < 300 then 4 when valor < 500 then 5 else 6 end as o,
               case when valor < 100 then 'até R$ 99' when valor < 150 then 'R$ 100 a 149' when valor < 200 then 'R$ 150 a 199' when valor < 300 then 'R$ 200 a 299' when valor < 500 then 'R$ 300 a 499' else 'R$ 500 ou mais' end as f,
               count(*) as n, round(sum(valor), 2) as fat
        from ano group by 1, 2) z),
    'dia_semana', (select coalesce(jsonb_agg(jsonb_build_object('dia', z.d, 'vendas', z.n, 'faturamento', z.fat) order by z.d), '[]'::jsonb) from (
        select extract(isodow from data)::int as d, count(*) as n, round(sum(valor), 2) as fat from ano group by 1) z),
    'dia_mes', (select coalesce(jsonb_agg(jsonb_build_object('faixa', z.b, 'vendas', z.n, 'faturamento', z.fat) order by z.b), '[]'::jsonb) from (
        select least(5, (extract(day from data)::int - 1) / 5) as b, count(*) as n, round(sum(valor), 2) as fat from ano group by 1) z),
    'meses', (select coalesce(jsonb_agg(jsonb_build_object('mes', z.m, 'vendas', z.n, 'faturamento', z.fat) order by z.m), '[]'::jsonb) from (
        select to_char(data, 'YYYY-MM') as m, count(*) as n, round(sum(valor), 2) as fat from v
        where data >= (date_trunc('month', hoje) - interval '35 months')::date group by 1) z),
    'clientes', jsonb_build_object(
        'total', (select count(*) from primeira),
        'voltaram', (select count(*) from primeira where n >= 2),
        'voltaram_em_60_dias', (select count(*) from segunda s join primeira p using (contact_id) where s.d2 - p.d1 <= 60),
        'mediana_dias_segunda', (select round(percentile_cont(0.5) within group (order by (s.d2 - p.d1))::numeric) from segunda s join primeira p using (contact_id)),
        'd90_novas', (select count(*) from primeira where d1 > hoje - 90),
        'd90_voltaram', (select count(distinct c.contact_id) from compras c join primeira p using (contact_id) where c.data > hoje - 90 and p.d1 <= hoje - 90),
        'd90_fat_novas', (select round(coalesce(sum(c.valor), 0), 2) from compras c join primeira p using (contact_id) where c.data > hoje - 90 and p.d1 > hoje - 90),
        'd90_fat_voltaram', (select round(coalesce(sum(c.valor), 0), 2) from compras c join primeira p using (contact_id) where c.data > hoje - 90 and p.d1 <= hoje - 90)),
    -- so o DDD (2 digitos) e quantas clientes tem cada um
    'ddd', (select coalesce(jsonb_agg(jsonb_build_object('ddd', z.ddd, 'clientes', z.n) order by z.n desc), '[]'::jsonb) from (
        select substring(ct.telefone from 4 for 2) as ddd, count(*) as n from public.contacts ct
        where ct.telefone like '+55%' and ct.id in (select contact_id from ano where contact_id is not null)
        group by 1 order by 2 desc limit 20) z),
    'diario', (select coalesce(jsonb_agg(jsonb_build_object('d', z.data, 'f', z.fat, 'n', z.n) order by z.data), '[]'::jsonb) from (
        select data, round(sum(valor), 2) as fat, count(*) as n from v where data > hoje - 120 group by data) z)
  ) into r;
  return r;
end $$;
revoke all on function public.mcp_vendas(text, uuid[]) from public;
grant execute on function public.mcp_vendas(text, uuid[]) to anon;
