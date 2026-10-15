-- Ligacao com o CRM (supabase/crm-relatorio-mcp.sql roda no CRM)
-- lojas.crm_tenants: as contas da loja no CRM (a Julia tem duas, somadas)
-- contas_meta.vendas: os padroes de venda calculados a partir do CRM (so totais)
alter table public.lojas add column if not exists crm_tenants uuid[];
alter table public.contas_meta add column if not exists vendas jsonb;

update public.lojas set crm_tenants = array['c8c0b233-eefa-41a6-abb5-3972889beb7a']::uuid[] where user_id = 'f86a857f-256b-4c2a-8bed-d34e207f94d6'; -- Lilu Store
update public.lojas set crm_tenants = array['79cc9ebb-f729-459b-9f7a-cb5821f37483']::uuid[] where user_id = '56e74acd-9571-4a3b-a9b6-b56690c8b431'; -- Duda Modas
update public.lojas set crm_tenants = array['cf55b6ff-cd0e-4cc6-98c7-f7d9c27a3fde', '09f20090-afc6-42bc-a58c-f990f37db30a']::uuid[] where user_id = '46f85877-4d53-496f-9fff-b6be70e9470b'; -- Julia Basso (as duas contas)
update public.lojas set crm_tenants = array['42e4c8ff-0567-40f8-8c76-e7d9f3e16c87']::uuid[] where user_id = 'bac76fb0-351f-4c55-aa95-61b33c352de9'; -- Tainara Almeida
update public.lojas set crm_tenants = array['6c57ca43-50a9-4b36-8bc3-460a18befaef']::uuid[] where user_id = '5b3e711f-7c07-4773-8797-c4b540bb336f'; -- Mary Acessorios
