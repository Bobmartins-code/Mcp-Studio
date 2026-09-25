# Como conectar a Meta ao MCP Studio

Feito uma vez só, pelo admin. A Meta completa o que o Reportei não traz: o **vídeo** (para transcrever o que foi falado), a **capa e o texto dos anúncios** e os **comentários** das seguidoras.

São duas fases:
- **Fase 1 (hoje, ~20 min):** criar o app e entrar com o seu Facebook. Funciona na hora e vale **60 dias**.
- **Fase 2 (depois de ~2 semanas de uso):** trocar por um **usuário do sistema**, com acesso que **nunca expira**. A Meta só libera isso depois que o app já fez algumas centenas de consultas.

Os nomes dos botões podem mudar um pouco nas telas da Meta. Se algo não bater, mande o print que eu indico onde clicar.

---

## Antes de começar: confira seus acessos

O app enxerga exatamente o que o seu Facebook já acessa. Em cada loja, você precisa ter acesso a:
- a **conta de anúncios** (se você já roda os anúncios, está ok);
- a **Página do Facebook ligada ao Instagram** da loja (é o que traz posts, vídeos e comentários).

Teste rápido: se você abre o **Meta Business Suite** da loja e vê os posts do Instagram dela, está certo.

Se a loja te deu acesso como **parceiro**, entre em **Configurações do negócio** → **Contas** (Páginas, Contas do Instagram, Contas de anúncios) e confira se **você está atribuído como pessoa** a esses ativos compartilhados.
Link: https://business.facebook.com/settings

---

## Fase 1: criar o app e conectar (vale 60 dias)

### 1. Criar o app
1. Abra **https://developers.facebook.com/apps/creation/** (entre com o seu Facebook).
2. **Detalhes do app:** nome `MCP Studio` e o seu e-mail → **Avançar**.
3. **Casos de uso:** marque
   - **Criar e gerenciar anúncios com a API de Marketing** (em inglês: *Create & manage ads with Marketing API*);
   - **Gerenciar mensagens e conteúdo no Instagram** (*Manage messaging & content on Instagram*). Se ele perguntar o tipo de login, escolha **com Login do Facebook** (não "com login do Instagram").
   → **Avançar**.
4. **Empresa:** escolha **o seu portfólio empresarial** (Gerenciador de Negócios). Isso é necessário para a Fase 2 → **Avançar**.
5. **Requisitos** e **Visão geral:** **Avançar** até **Ir para o painel**.

O app fica em **modo de desenvolvimento**. Não publique nem mande para revisão: como só você usa, não precisa.

### 2. Configurar o login
1. No painel do app, menu da esquerda: **Login do Facebook para Empresas** → **Configurações**.
   - Em **URIs de redirecionamento do OAuth válidos**, cole exatamente:
     `https://mcp-studio-zeta.vercel.app/meta-callback.html`
   - Salve.
2. Ainda em **Login do Facebook para Empresas** → **Configurações** (aba *Configurations*) → **Criar configuração**:
   - Nome: `MCP Studio`
   - Tipo de token: **Token de acesso do usuário**
   - Permissões: `instagram_basic`, `instagram_manage_insights`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`, `ads_read`, `business_management`
   - Salve e **copie o ID da configuração**.
3. **Configurações do app** → **Básico**:
   - **Domínios do app:** `mcp-studio-zeta.vercel.app`
   - Copie o **ID do app** e a **Chave secreta do app** (clique em "Mostrar").

### 3. Colocar os códigos no Vercel
Abra **https://vercel.com/bob-martins/mcp-studio/settings/environment-variables** → **Add Environment Variable**, um de cada vez (ambiente **Production**):

| Key | Value |
|---|---|
| `META_APP_ID` | ID do app |
| `META_APP_SECRET` | Chave secreta do app |
| `META_CONFIG_ID` | ID da configuração |

Depois me avise: eu republico o site para os códigos valerem.

### 4. Conectar
1. **Painel Admin** → aba **Conexões** → quadro **Meta** → **Entrar com o Facebook (vale 60 dias)**.
2. Na janela do Facebook, marque **todas** as empresas, Páginas, Instagrams e contas de anúncios das lojas.
3. O quadro mostra quantos Instagrams e contas de anúncios o acesso enxerga. Se faltar alguma loja, veja "Se algo não aparecer" no fim.

---

## Fase 2: acesso que nunca expira (usuário do sistema)

A Meta só deixa o usuário do sistema usar a API de anúncios quando o app tem o nível **Marketing API Access Tier** (antigo "Acesso Padrão"). Para pedir, o app precisa ter feito cerca de **500 consultas nos últimos 15 dias com poucos erros**. Com a Fase 1 rodando, isso acontece sozinho em umas 2 semanas.

### 1. Pedir o nível de acesso
No painel do app: **Revisão do app** → **Permissões e recursos** → procure **Marketing API Access Tier** (ou *Ads Management Standard Access*) → **Solicitar**. Se ainda não estiver liberado, a tela mostra quantas consultas faltam.
A Meta também pode pedir a **verificação da empresa** (documentos do CNPJ) em **Configurações do negócio** → **Central de segurança**.

### 2. Criar o usuário do sistema
1. **https://business.facebook.com/settings/system-users** → **Adicionar**.
2. Nome: `MCP Studio Robo` · Função: **Administrador** → **Criar usuário do sistema**.
3. Com ele selecionado → **Atribuir ativos**:
   - **Apps:** o app MCP Studio (controle total);
   - **Páginas** das lojas: acesso a conteúdo e insights (ou controle total);
   - **Contas do Instagram** das lojas;
   - **Contas de anúncios** das lojas: pelo menos "Ver desempenho".
   Ativos que chegaram como parceiro também aparecem aqui.

### 3. Gerar o código
1. Ainda no usuário do sistema → **Gerar novo token**.
2. App: **MCP Studio** · Validade: **Nunca** · marque as mesmas permissões da Fase 1 (`instagram_basic`, `instagram_manage_insights`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`, `ads_read`, `business_management`).
3. **Gerar token** e copie o código (ele aparece uma vez só).

### 4. Colar no painel
**Painel Admin** → **Conexões** → quadro **Meta** → **Trocar a conexão** → cole o código → **Salvar código**.
O painel confere com a Meta e passa a mostrar **"acesso sem prazo para expirar"**. Se faltar permissão, ele avisa qual.

Loja nova depois disso: basta atribuir a Página, o Instagram e a conta de anúncios dela ao usuário do sistema (passo 2.3). Não precisa gerar outro código.

---

## Se algo não aparecer

- **Instagram não aparece:** ele precisa ser conta profissional e estar ligado a uma Página que o seu acesso enxerga.
- **Conta de anúncios não aparece:** confira no Gerenciador de Negócios se você (ou o usuário do sistema) está atribuído a ela.
- **"Este código foi gerado para outro app":** gere de novo escolhendo o app MCP Studio.
- **O acesso de 60 dias vai vencer:** o quadro mostra os dias restantes; clique em **Entrar com o Facebook** de novo (ou faça a Fase 2).

O código fica guardado criptografado no servidor e nunca aparece no navegador. O MCP Studio só **lê** dados: não cria, pausa nem altera anúncios.
