-- Cerebro da loja (api/_cerebro.js)
-- objetivo_anuncios: o que conta como resultado nos anuncios desta loja, escolhido no Painel Admin
--   null = automatico (compras quando houver; senao conversas)
--   'vendas' = compras
--   'conversas_visitas' = conversas iniciadas e visitas ao perfil (ex.: loja que vende pelo direct)
alter table public.lojas add column if not exists objetivo_anuncios text
  check (objetivo_anuncios is null or objetivo_anuncios in ('vendas', 'conversas_visitas'));

-- caderno: o que o time ja sabe da loja, tirado dos videos campeoes cruzados com o publico
-- (comprovado, a testar, nao funciona, publico); escrito so pelo servidor
alter table public.contas_meta add column if not exists caderno jsonb;
