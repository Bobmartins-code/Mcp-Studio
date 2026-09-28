-- quantas analises seguidas deram erro (espera 2 h, 8 h e 24 h antes de tentar de novo)
alter table public.contas_meta add column if not exists falhas_analise integer not null default 0;
