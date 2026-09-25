-- =====================================================================
--  PERFIL DA LOJA EDITADO PELA DONA (tela Conta do app)
--  - lojas.logo_url: a logo da loja
--  - atualizar_minha_loja(): a dona muda so o nome e a logo da propria loja
--    (as outras colunas continuam so com o admin)
--  - bucket "logos": cada loja grava so na pasta com o proprio id
--  Rodar uma vez no Supabase: SQL Editor > New query > colar > Run.
-- =====================================================================

alter table public.lojas add column if not exists logo_url text;

create or replace function public.atualizar_minha_loja(p_nome text, p_logo_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sem login'; end if;
  if p_nome is not null and char_length(trim(p_nome)) not between 1 and 80 then raise exception 'nome invalido'; end if;
  -- a logo so pode ser um arquivo da propria loja no bucket de logos
  if p_logo_url is not null and p_logo_url <> '' and position('/storage/v1/object/public/logos/' || auth.uid()::text || '/' in p_logo_url) = 0 then
    raise exception 'logo invalida';
  end if;
  -- conta sem loja cadastrada (o proprio admin): cria a linha
  insert into public.lojas (user_id, nome, logo_url)
  values (auth.uid(), coalesce(nullif(trim(p_nome), ''), 'Minha loja'), nullif(p_logo_url, ''))
  on conflict (user_id) do update
     set nome = coalesce(nullif(trim(p_nome), ''), public.lojas.nome),
         logo_url = case when p_logo_url is null then public.lojas.logo_url when p_logo_url = '' then null else p_logo_url end,
         atualizado_em = now();
end $$;
revoke all on function public.atualizar_minha_loja(text, text) from public, anon;
grant execute on function public.atualizar_minha_loja(text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

drop policy if exists "logo: dona grava na propria pasta" on storage.objects;
create policy "logo: dona grava na propria pasta" on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "logo: dona troca na propria pasta" on storage.objects;
create policy "logo: dona troca na propria pasta" on storage.objects for update to authenticated
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "logo: dona apaga na propria pasta" on storage.objects;
create policy "logo: dona apaga na propria pasta" on storage.objects for delete to authenticated
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text);
