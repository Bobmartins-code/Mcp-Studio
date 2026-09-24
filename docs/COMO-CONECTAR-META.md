# Como conectar a Meta ao MCP Studio

Feito uma vez só, pelo admin. Depois disso, todas as contas das clientes são conectadas pelo Painel Admin.

## Antes de começar

O seu Facebook (o do admin) precisa ter acesso, em cada cliente, a:
- a **Página do Facebook** ligada ao Instagram profissional dela
- a **conta de anúncios** dela

O jeito mais simples: a cliente adiciona você como **parceiro** no Gerenciador de Negócios dela, com acesso à Página, ao Instagram e à conta de anúncios.

## 1. Criar o app na Meta

1. Entre em **developers.facebook.com** → **Meus apps** → **Criar app**.
2. Tipo de app: **Empresa** (Business). Dê o nome "MCP Studio".
3. No painel do app, adicione os produtos:
   - **Login do Facebook para Empresas**
   - **API de Marketing**
   - **API do Instagram** (a versão "com Login do Facebook")

## 2. Configurar o login

1. Em **Login do Facebook para Empresas → Configurações**, no campo **URIs de redirecionamento do OAuth válidos**, coloque exatamente:
   `https://mcp-studio-zeta.vercel.app/meta-callback.html`
2. Em **Login do Facebook para Empresas → Configurações (Configurations)**, crie uma configuração:
   - Tipo de token: **Token de acesso do usuário**
   - Permissões: `instagram_basic`, `instagram_manage_insights`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`, `read_insights`, `ads_read`, `business_management`
   - Guarde o **ID da configuração**.
3. Em **Configurações do app → Básico**, em **Domínios do app**, coloque `mcp-studio-zeta.vercel.app`.

O app pode ficar em **modo de desenvolvimento**. Como só você (admin do app) faz o login, não precisa passar pela revisão da Meta.

## 3. Colocar as chaves no Vercel

Em **Configurações do app → Básico**, copie o **ID do app** e a **Chave secreta do app**.

No Vercel: projeto **mcp-studio** → **Settings** → **Environment Variables**, crie (ambiente Production):

| Nome | Valor |
|---|---|
| `META_APP_ID` | ID do app |
| `META_APP_SECRET` | Chave secreta do app |
| `META_CONFIG_ID` | ID da configuração do passo 2 |

Depois, em **Deployments**, clique em **Redeploy** no último deploy para as chaves valerem.

## 4. Conectar e analisar

1. Abra o **Painel Admin** → quadro **Contas Meta dos clientes** → **Conectar Meta**.
2. Faça login no Facebook e marque todas as empresas, páginas, Instagrams e contas de anúncios das clientes.
3. De volta ao painel, escolha, para cada cliente, o **Instagram** e a **conta de anúncios** dela e clique em **Analisar**.
4. O time de agentes coleta os últimos 90 dias, transcreve os vídeos vencedores e monta o dossiê. A cliente passa a ver a aba **Melhores Vídeos**, e o Agente MCP usa o dossiê em todos os roteiros dela.

O acesso da Meta vale **60 dias**. O painel mostra quantos dias faltam; quando estiver perto, clique em **Reconectar**.

## Se algo não aparecer

- **Instagram não aparece na lista:** confira se ele é conta profissional e está ligado a uma Página que o seu Facebook acessa.
- **Conta de anúncios não aparece:** confira se o seu Facebook tem acesso a ela no Gerenciador de Negócios. Se ainda assim não aparecer, a Meta pode exigir o **Acesso Avançado** da API de Marketing; nesse caso é um pedido feito no próprio painel do app.
