-- =====================================================================
--  CONTAGENS DO CEREBRO MCP (pagina cerebro.html, so o admin)
--  Devolve so numeros prontos por loja (sem nome, sem id), na ordem em que
--  as lojas entraram: a Loja 1 e a mais antiga. Leve: nao traz os dados
--  das lojas, so as contagens.
-- =====================================================================
create or replace function public.cerebro_contagens()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    saida jsonb;
begin
    if not is_admin() then
        raise exception 'somente o admin';
    end if;
    select jsonb_build_object(
        'em', now(),
        'licoes', coalesce((select jsonb_array_length(cc.licoes) from cerebro_central cc where not (coalesce(cc.resumo, '{}'::jsonb) ? 'erro') order by cc.gerado_em desc limit 1), 0),
        'lojas', coalesce(jsonb_agg(x.v order by x.criado), '[]'::jsonb)
    ) into saida
    from (
        select l.criado_em as criado, jsonb_build_object(
            'posts', jsonb_array_length(coalesce(c.metricas->'organico'->'posts', '[]'::jsonb)),
            'ads', jsonb_array_length(coalesce(c.metricas->'anuncios'->'p90'->'anuncios', '[]'::jsonb)),
            'stories', (select count(*) from stories s where s.user_id = l.user_id),
            'videos', (select count(*) from jsonb_each(coalesce(c.meta->'posts', '{}'::jsonb)) e where e.value ? 'visual')
                    + (select count(*) from jsonb_each(coalesce(c.meta->'anuncios', '{}'::jsonb)) e where e.value ? 'visual'),
            'falas', (select count(*) from jsonb_each(coalesce(c.meta->'posts', '{}'::jsonb)) e where e.value ? 'transcricao')
                   + (select count(*) from jsonb_each(coalesce(c.meta->'anuncios', '{}'::jsonb)) e where e.value ? 'transcricao'),
            'cerebro', jsonb_array_length(coalesce(c.caderno->'comprovado', '[]'::jsonb)) + jsonb_array_length(coalesce(c.caderno->'a_testar', '[]'::jsonb))
                     + jsonb_array_length(coalesce(c.caderno->'nao_funciona', '[]'::jsonb)) + jsonb_array_length(coalesce(c.caderno->'publico', '[]'::jsonb)),
            'ideias', case when jsonb_typeof(c.dossie->'ideias'->'lista') = 'array' then jsonb_array_length(c.dossie->'ideias'->'lista') else 0 end,
            'roteiros', (select count(*) from projetos pj, jsonb_array_elements(coalesce(pj.rodadas, '[]'::jsonb)) r, jsonb_array_elements(coalesce(r->'resultado'->'roteiros', '[]'::jsonb)) rt where pj.user_id = l.user_id)
        ) as v
        from lojas l
        join contas_meta c on c.user_id = l.user_id
    ) x;
    return saida;
end;
$$;
revoke all on function public.cerebro_contagens() from public, anon;
grant execute on function public.cerebro_contagens() to authenticated;
