-- =====================================================================
--  STORIES e CEREBRO CENTRAL (out/2026)
--  stories: cada story de cada loja, guardado enquanto esta no ar (a Meta
--  so entrega os numeros por 24 horas) e mantido depois com os numeros finais.
--  cerebro_central: licoes anonimas (padroes de formato vistos em 3 lojas ou
--  mais), sem nome, @, produto, preco ou numero de nenhuma loja. So o admin le.
-- =====================================================================

create table if not exists public.stories (
    user_id uuid not null references auth.users(id) on delete cascade,
    story_id text not null,
    publicado_em timestamptz,
    tipo text,
    capa_url text,
    link text,
    metricas jsonb not null default '{}'::jsonb,
    final boolean not null default false,      -- saiu do ar: os numeros guardados sao os finais
    visto_em timestamptz,                      -- ultima vez que os numeros foram lidos
    criado_em timestamptz not null default now(),
    primary key (user_id, story_id)
);
create index if not exists stories_loja_data on public.stories (user_id, publicado_em desc);
alter table public.stories enable row level security;
drop policy if exists "stories: dona e admin leem" on public.stories;
create policy "stories: dona e admin leem" on public.stories for select
    using (user_id = (select auth.uid()) or (select is_admin()));

create table if not exists public.cerebro_central (
    id bigserial primary key,
    gerado_em timestamptz not null default now(),
    licoes jsonb not null default '[]'::jsonb,
    resumo jsonb,
    usar_nas_ideias boolean not null default false   -- modo observacao: so o admin ve
);
alter table public.cerebro_central enable row level security;
drop policy if exists "central: admin le" on public.cerebro_central;
create policy "central: admin le" on public.cerebro_central for select using ((select is_admin()));

-- capas dos stories (a Meta manda um link que vence em poucos dias)
insert into storage.buckets (id, name, public) values ('stories', 'stories', true) on conflict (id) do nothing;
