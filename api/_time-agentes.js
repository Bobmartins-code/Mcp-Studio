// =====================================================================
//  TIME DE AGENTES (roda no servidor, sozinho)
//  Estuda os numeros reais de UMA loja (que chegam do Reportei a cada
//  5 minutos em contas_meta.metricas), completados pela Meta (fala dos
//  videos, texto dos anuncios e comentarios, em api/_meta-leitura.js), e entrega o dossie da conta que o
//  Agente MCP (api/_agente-mcp.js) usa em todos os roteiros.
//
//  1. Agente Organico e Agente de Anuncios analisam ao mesmo tempo
//  2. Agente de Publico monta o retrato do publico com o que eles acharam
//  3. Diretor junta tudo no dossie (com uma orientacao por metodo)
//
//  Cada loja aprende so com os proprios dados: nada passa de uma loja
//  para outra. Chamado pela atualizacao automatica (api/atualizar.js) e
//  pelo botao "Analisar" do painel admin (api/connect.js).
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const crypto = require("crypto");
const { banco } = require("./_seguranca.js");
const { connect, clienteDoUsuario, integracoesDoCliente } = require("./_reportei.js");
const { blocoDaResposta, diaSP, assinaturaDe } = require("./_coleta.js");
const { enriquecerLoja, esperarFalas, aplicarMeta, comentariosDaLoja } = require("./_meta-leitura.js");

const MODELO = "claude-sonnet-5";
const VERSAO = 3; // 3: com a Meta (falas dos videos, texto dos anuncios e comentarios reais)
const NICHOS = ["moda feminina", "moda masculina", "moda infantil", "moda fitness", "lingerie e moda intima", "calcados", "bolsas e acessorios", "joias e bijuterias", "beleza e cosmeticos", "saude e suplementos", "casa e decoracao", "alimentos e doces", "pet", "servicos", "cursos e infoprodutos", "outros"];

// quando o time volta a analisar uma loja
const DIA_MS = 24 * 3600 * 1000;
const NOVIDADE_MS = 2 * 3600 * 1000;     // entrou post ou anuncio novo: analisa de novo, no maximo a cada 2 horas
const TRAVADA_MS = 10 * 60 * 1000;       // "Analisando" ha mais que isso e considerado travado

const SISTEMA_TIME = `
QUEM VOCÊS SÃO
Vocês são o time de analistas do MCP Studio. Vocês estudam os dados reais de UMA loja brasileira (Instagram e anúncios da Meta dos últimos 90 dias) para que o Agente MCP escreva roteiros de Reels que dão resultado para ela.

REGRAS
- Use só os dados desta loja que vierem na mensagem. Nunca invente número, depoimento, produto ou público. Se faltar dado para uma conclusão, diga que falta em vez de chutar.
- Cada conclusão precisa se apoiar no que os dados mostram (exemplo: os 3 Reels acima da média abrem com uma pergunta direta).
- Com poucos dados (menos de 5 posts ou anúncios), seja cauteloso, marque a confiança como baixa e diga isso no resumo.
- Seja específico desta loja. Frases genéricas como "conteúdo de valor" ou "engaje seu público" são proibidas.
- Escreva em português do Brasil com acentuação completa e correta em todas as palavras (é, ê, á, ã, õ, ç, í, ú), inclusive quando os dados ou os nomes chegarem sem acento. Frases curtas e linguagem simples de dona de loja. Nunca use travessão. Sem clichês de IA.
- Quem lê os resumos é a própria dona da loja, no celular. Não use siglas como CTR, CPC ou ROAS sem explicar em palavras.
- Nunca use etiquetas de ação para anúncios como Escalar, Manter ou Otimizar.

COMO MEDIMOS RESULTADO
- Orgânico: engajamento (curtidas, comentários, salvamentos) e compartilhamentos, com compartilhamento valendo o dobro, sempre em relação ao alcance. O índice compara cada post com a média da própria conta: 1,0 é na média, 2,0 é o dobro. Posts dos últimos 30 dias pesam mais que os 60 dias anteriores.
- Anúncios: resultado é venda. Se a loja não tem pixel e vende pelo WhatsApp ou Direct, resultado são as conversas iniciadas. Quando as campanhas têm objetivos diferentes (alcance, visitas ao perfil, cliques), compare cada anúncio só com os de mesmo objetivo e nunca some objetivos diferentes.
- Ficaram nos 3 primeiros segundos (Reels, vem da Meta): quem não pulou o vídeo logo no começo. Mostra a força do gancho no orgânico.
- Tempo médio assistido (Reels, vem da Meta): quantos segundos, em média, as pessoas assistem. Compare entre os Reels da própria loja: o que segura mais tempo mostra o assunto e o ritmo que prendem.
- Taxa de gancho = quem assistiu 3 segundos dividido pelas impressões (força do gancho). Retenção = quem assistiu até o fim dividido por quem assistiu 3 segundos (força do corpo). Taxa de clique = cliques dividido pelas impressões (força da chamada).
`.trim();

// Os 5 metodos em poucas linhas e com acento: o Diretor so precisa saber para que serve cada um
// (a regra completa fica no Agente MCP, em api/_agente-mcp.js, que esta sem acento e fazia o Diretor escrever sem acento)
const METODOS_RESUMO = `
OS 5 MÉTODOS DE ROTEIRO DO MCP STUDIO
- fftopo, Full Funnel Topo (Consciência): para quem ainda não conhece a loja. Começa numa situação do dia a dia, desperta a dor e só depois apresenta a solução.
- ffmeio, Full Funnel Meio (Conceito Criativo): para quem já está pensando. Mostra o produto de um jeito criativo: comparação, antes e depois, look completo, estilo de vida, bastidor.
- fffundo, Full Funnel Fundo (Decisão e Prova): para quem já quer comprar mas trava. Responde uma objeção (preço, tamanho, qualidade, prazo, troca) com prova: garantia, cálculo ou detalhe do produto.
- dsb, DSB (Dor, Solução, Benefício): parte de uma dor real da cliente, apresenta o produto como a solução e fecha no benefício sentido na prática.
- angulo, Ângulo (Diferencial concreto): cada roteiro foca em um diferencial real do produto e mostra por que ele faz diferença.
`.trim();

// ---------- esquemas das respostas (a API garante o formato) ----------
const lista = { type: "array", items: { type: "string" } };
const confianca = { type: "string", enum: ["baixa", "media", "alta"] };
function objeto(props) { return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false }; }

const ESQ_ORGANICO = objeto({ resumo: { type: "string" }, o_que_funciona: lista, ganchos_que_funcionam: lista, temas: lista, formatos: lista, evitar: lista, confianca: confianca });
const ESQ_ANUNCIOS = objeto({ resumo: { type: "string" }, o_que_vende: lista, ganchos_que_convertem: lista, argumentos_e_ofertas: lista, ctas: lista, diagnostico_dos_fracos: lista, confianca: confianca });
const ESQ_PUBLICO = objeto({ resumo: { type: "string" }, quem_e: { type: "string" }, idade_genero: { type: "string" }, regioes: { type: "string" }, quem_compra: { type: "string" }, dores: lista, desejos: lista, objecoes: lista, expressoes_reais: lista, confianca: confianca });
// a descricao de cada campo reforca a acentuacao (o Diretor tendia a escrever sem acento)
const PT = "Em português do Brasil com acentuação completa (exemplo: Os vídeos que mostram um erro de gestão são os que mais geram comentário).";
function textoPT(d) { return { type: "string", description: d + " " + PT }; }
const ESQ_DIRETOR = objeto({
    texto: textoPT("Dossiê para o Agente MCP, até 1400 caracteres."),
    resumo_loja: textoPT("2 ou 3 frases curtas para a dona da loja ler no celular."),
    por_metodo: objeto({ fftopo: textoPT("Full Funnel Topo nesta loja."), ffmeio: textoPT("Full Funnel Meio nesta loja."), fffundo: textoPT("Full Funnel Fundo nesta loja."), dsb: textoPT("DSB nesta loja."), angulo: textoPT("Ângulo nesta loja.") }),
    nicho: { type: "string", enum: NICHOS }
});

// Agente de Ideias: cerca de 15 ideias de conteudo (nao sao roteiros), no estilo das sugestoes
// que a consultoria entrega para as lojas: titulo curto e concreto + como fazer
const FORMATOS_IDEIA = ["rápido com transições", "narrado", "provador"];
const ESQ_IDEIAS = objeto({
    resumo: textoPT("2 frases para a dona ler no celular: por onde começar esta semana e por quê."),
    ideias: {
        type: "array",
        items: objeto({
            titulo: textoPT("A ideia em uma frase curta e concreta, do jeito que a dona entende na hora (exemplos: POV: você foi convidada para ser madrinha de casamento; 1 peça, 5 looks; Looks por menos de R$ 150)."),
            como_fazer: textoPT("1 ou 2 frases práticas: o que mostrar e como gravar, só com o celular."),
            formatos: { type: "array", items: { type: "string", enum: FORMATOS_IDEIA }, description: "Em quais formatos esta ideia funciona: rápido com transições (até 15 segundos, sem fala), narrado (30 a 45 segundos, a dona falando) e provador (mostrando no corpo, com transições e narração leve)." },
            funil: { type: "string", enum: ["topo", "meio", "fundo"] },
            metodo: { type: "string", enum: ["fftopo", "ffmeio", "fffundo", "dsb", "angulo"], description: "O método de roteiro mais próximo, usado se a dona quiser transformar a ideia narrada em roteiro." },
            por_que: textoPT("De onde veio a ideia nesta loja, em uma frase curta (post, anúncio, comentário, público ou data do calendário).")
        })
    }
});

// ---------- chamada da IA ----------
function espera(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// garantia final: troca qualquer travessao que escape por virgula (mesma regra do api/generate.js)
function semTravessao(v) {
    if (typeof v === "string") return v.replace(/,?[ \t]*[—–][ \t]*/g, ", ");
    if (Array.isArray(v)) return v.map(semTravessao);
    if (v && typeof v === "object") { const o = {}; Object.keys(v).forEach(function (k) { o[k] = semTravessao(v[k]); }); return o; }
    return v;
}

async function perguntar(nome, pedido, esquema) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY nao configurada no Vercel.");
    const corpo = {
        model: MODELO,
        max_tokens: 12000,
        system: [{ type: "text", text: SISTEMA_TIME, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: pedido }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: esquema } }
    };
    for (let t = 0; t < 3; t++) {
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, 120000);
        let r;
        try {
            r = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
                body: JSON.stringify(corpo),
                signal: ctrl.signal
            });
        } catch (e) {
            clearTimeout(timer);
            if (t < 2) { await espera(1500 * (t + 1)); continue; }
            throw new Error(nome + ": " + (e.name === "AbortError" ? "a IA demorou demais" : "falha de rede"));
        }
        clearTimeout(timer);
        const d = await r.json().catch(function () { return {}; });
        // 429, 529 e 5xx podem passar na proxima tentativa
        if ((r.status === 429 || r.status >= 500) && t < 2) { await espera(2000 * (t + 1)); continue; }
        if (!r.ok) throw new Error(nome + ": " + ((d.error && d.error.message) || ("erro " + r.status)));
        if (d.stop_reason === "refusal") throw new Error(nome + ": a IA recusou o pedido");
        if (d.stop_reason === "max_tokens") throw new Error(nome + ": resposta cortada");
        const bloco = (d.content || []).find(function (b) { return b.type === "text"; });
        if (!bloco) throw new Error(nome + ": resposta vazia");
        return semTravessao(JSON.parse(bloco.text));
    }
}

// ---------- preparo dos dados para cada agente ----------
function arred(n, c) { const f = Math.pow(10, c || 0); return Math.round((n || 0) * f) / f; }
function corta(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; }
function brl(n) { return "R$ " + arred(n, 2).toFixed(2).replace(".", ","); }

function postsDaLoja(met) {
    const posts = (met && met.organico && met.organico.posts) || [];
    const desde30 = Date.now() - 30 * 864e5;
    const peso = function (p) { return (p.indice || 0) * (p.recente ? 1.3 : 1); };
    const ord = posts.filter(function (p) { return p.alcance > 0; })
        .map(function (p) { return Object.assign({}, p, { recente: !!(p.data && new Date(p.data).getTime() >= desde30) }); })
        .sort(function (a, b) { return peso(b) - peso(a); });
    // conta pequena: manda tudo; conta grande: os 15 melhores e os 5 piores
    return ord.length <= 20 ? ord : ord.slice(0, 15).concat(ord.slice(-5));
}
function linhaPost(p, i) {
    return (i + 1) + ") " + (p.tipo || "Post") + " de " + String(p.data || "").slice(0, 10) + (p.recente ? " (ultimos 30 dias)" : "") +
        " | " + String(arred(p.indice, 2)).replace(".", ",") + "x a media | alcance " + p.alcance + " | visualizacoes " + (p.visualizacoes || 0) +
        (p.tempo_medio_s ? " | tempo medio assistido " + String(p.tempo_medio_s).replace(".", ",") + " s" : "") +
        (p.retencao_3s != null ? " | ficaram nos 3 primeiros segundos " + String(p.retencao_3s).replace(".", ",") + "%" : "") +
        " | curtidas " + p.curtidas + " | comentarios " + p.comentarios + " | salvamentos " + p.salvamentos + " | compartilhamentos " + p.compartilhamentos +
        " | legenda: " + corta(p.legenda, 300) + (p.transcricao ? " | FALA DO VIDEO: " + corta(p.transcricao, 700) : "");
}

function anunciosDaLoja(met) {
    const a90 = met && met.anuncios && met.anuncios.p90;
    if (!a90 || !(a90.anuncios || []).length) return null;
    const r30 = {};
    ((met.anuncios.p30 && met.anuncios.p30.anuncios) || []).forEach(function (x) { r30[x.id] = x.resultados; });
    return { tipo: a90.tipo_resultado, totais: a90.totais || {}, medias: a90.medias || {}, lista: a90.anuncios.slice(0, 25).map(function (x) { return Object.assign({}, x, { resultados_30d: r30[x.id] || 0 }); }) };
}
function nomeResultado(tipo, a) {
    if (tipo === "vendas") return "compras";
    if (tipo === "conversas") return "conversas";
    return (a && a.res_nome && a.res_nome[1]) || "resultados da campanha";
}
function linhaAnuncio(tipo, a, i) {
    return (i + 1) + ") " + corta(a.nome, 140) + " | objetivo medido: " + nomeResultado(tipo, a) + " | investido " + brl(a.gasto) +
        " | resultados em 90 dias " + a.resultados + " (ultimos 30 dias: " + a.resultados_30d + ")" +
        (a.custo_por_resultado ? " | custo por resultado " + brl(a.custo_por_resultado) : "") +
        (a.taxa_gancho != null ? " | taxa de gancho " + a.taxa_gancho + "%" : "") + (a.retencao != null ? " | retencao " + a.retencao + "%" : "") +
        (a.ctr != null ? " | taxa de clique " + a.ctr + "%" : "") + (a.compras ? " | compras " + a.compras : "") + (a.conversas ? " | conversas " + a.conversas : "") +
        (a.diagnostico ? " | " + a.diagnostico : "") + (a.titulo ? " | TITULO: " + corta(a.titulo, 120) : "") + (a.texto ? " | TEXTO DO ANUNCIO: " + corta(a.texto, 400) : "") +
        (a.transcricao ? " | FALA DO VIDEO: " + corta(a.transcricao, 700) : "");
}

// idade, genero e cidades de quem segue (Reportei), uma vez por analise
async function publicoDoReportei(userId) {
    try {
        const cli = await clienteDoUsuario(userId);
        const ints = await integracoesDoCliente(cli);
        const ig = ints.find(function (i) { return i.plataforma === "instagram_business" && i.status === "active"; }) || ints.find(function (i) { return i.plataforma === "instagram_business"; });
        if (!ig) return null;
        const fim = diaSP(new Date()), inicio = diaSP(new Date(Date.now() - 29 * 864e5));
        const pedidos = {
            idade_genero: { reference_key: "ig:followers_gender_age", component: "chart_v1", metrics: ["followers"], dimensions: ["age", "gender"] },
            cidades: { reference_key: "ig:followers_city", component: "datatable_v1", metrics: ["followers"], dimensions: ["city"], sort: ["-followers"] }
        };
        const out = {};
        await Promise.all(Object.keys(pedidos).map(async function (k) {
            const w = Object.assign({ id: crypto.randomUUID() }, pedidos[k]);
            try {
                const d = await connect("/metrics/get-data", { method: "POST", customerToken: cli.api_token, timeout: 60000, body: { customer_integration: ig.uuid, start: inicio, end: fim, client_timezone: "America/Sao_Paulo", metrics: [w] } });
                const b = blocoDaResposta(d, w.id);
                if (!b || b.warning) return;
                const v = k === "cidades" && Array.isArray(b.values) ? { values: b.values.slice(0, 10) } : b;
                out[k] = JSON.stringify(v).slice(0, 1500);
            } catch (e) { /* sem esse dado o agente de publico segue com o resto */ }
        }));
        return Object.keys(out).length ? out : null;
    } catch (e) { return null; }
}

function montarSobreLoja(loja, projetos, met) {
    const produtos = (projetos || []).map(function (p) { return corta((p.form && p.form.produto) || p.nome, 200); }).filter(Boolean).slice(0, 5);
    return "LOJA: " + (loja.nome || "sem nome") + (loja.nicho ? " | nicho informado: " + loja.nicho : "") + (loja.site ? " | site: " + loja.site : "") +
        (met.conta && met.conta.username ? " | Instagram @" + met.conta.username : "") + (met.conta && met.conta.seguidores ? " | " + met.conta.seguidores + " seguidores" : "") +
        (produtos.length ? "\nPRODUTOS DOS ULTIMOS PROJETOS DE ROTEIRO: " + produtos.join(" | ") : "");
}

// "Gerar mais ideias" pedido pela dona: so o Agente de Ideias, com o que o time ja estudou (sem nova analise)
const MAX_LEVAS_DIA = 3;
class ErroIdeias extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function gerarMaisIdeias(userId) {
    const id = encodeURIComponent(userId);
    const [contas, lojas, projetos] = await Promise.all([
        banco("contas_meta?user_id=eq." + id + "&select=metricas,dossie,meta"),
        banco("lojas?user_id=eq." + id + "&select=nome,nicho,site").catch(function () { return []; }),
        banco("projetos?user_id=eq." + id + "&select=nome,form&order=criado_em.desc&limit=5").catch(function () { return []; })
    ]);
    const conta = (contas && contas[0]) || {}, met = conta.metricas, dossie = conta.dossie || {};
    if (!met || !(dossie.organico || dossie.anuncios || dossie.publico)) throw new ErroIdeias(409, "O time de agentes ainda está estudando a sua conta. Assim que a análise terminar, você pode pedir mais ideias.");
    const hoje = diaSP(new Date()), ant = dossie.ideias || {};
    const levas = ant.levas_dia === hoje ? (ant.levas || 0) : 0;
    if (levas >= MAX_LEVAS_DIA) throw new ErroIdeias(429, "Você já pediu mais ideias " + MAX_LEVAS_DIA + " vezes hoje. Amanhã tem mais!");
    aplicarMeta(met, conta.meta);
    const ads = anunciosDaLoja(met);
    const r = await perguntar("Agente de Ideias", pedidoIdeias({
        sobreLoja: montarSobreLoja((lojas && lojas[0]) || {}, projetos, met), posts: postsDaLoja(met), ads: ads, comentarios: comentariosDaLoja(met, conta.meta),
        relOrg: dossie.organico && dossie.organico.relatorio, relAds: dossie.anuncios && dossie.anuncios.relatorio, relPub: dossie.publico,
        anteriores: (ant.lista || []).map(function (i) { return i.titulo; }), marcadas: []
    }) + "\n\nESTA É UMA NOVA LEVA PEDIDA PELA DONA: traga ideias diferentes de todas as anteriores, explorando outros formatos, situações e ângulos, sempre com base nos dados desta loja.", ESQ_IDEIAS);
    const novas = (r && r.ideias) || [];
    if (!novas.length) throw new ErroIdeias(502, "Não consegui gerar ideias agora. Tente de novo em alguns minutos.");
    const ideias = { gerado_em: new Date().toISOString(), resumo: ant.resumo || r.resumo, lista: novas.map(function (i) { return Object.assign({}, i, { nova: true }); }).concat((ant.lista || []).map(function (i) { const c = Object.assign({}, i); delete c.nova; return c; })).slice(0, 60), levas_dia: hoje, levas: levas + 1 };
    await banco("contas_meta?user_id=eq." + id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { dossie: Object.assign({}, dossie, { ideias: ideias }) } });
    return { ok: true, novas: novas.length, total: ideias.lista.length, restam_hoje: MAX_LEVAS_DIA - levas - 1 };
}

// pedido do Agente de Ideias (nao escreve roteiros: entrega ideias de conteudo)
// O repertorio abaixo vem das sugestoes que a consultoria ja entrega para as lojas (moda, acessorios,
// moda praia e fitness): e referencia de estilo e de formato, nao lista para copiar.
const REPERTORIO_IDEIAS = [
    "POV: você foi convidada para ser madrinha de casamento",
    "POV: você tem um casamento de dia e não sabe o que usar",
    "Looks para show sertanejo / para Barretos / para formatura / para batizado",
    "1 peça, 5 looks (a peça mais vendida em várias combinações)",
    "1 vestido, várias ocasiões (mudando só os acessórios)",
    "Looks por menos de R$ X (se vestir bem gastando pouco)",
    "Do dia para a noite: o look simples que vira sofisticado",
    "Do trabalho ao happy hour",
    "Arrume-se comigo para um dia de trabalho",
    "O que eu usaria em um aero look",
    "Close no tecido e na costura: a diferença que você sente no toque",
    "Será que essa calça veste bem no quadril? (prova real com cliente)",
    "Por que todo mundo está falando da nossa [peça campeã de vendas]?",
    "Lançamentos: as peças que chegaram (as que têm mais estoque)",
    "As cores que vão dominar a estação já estão aqui",
    "Não é a peça, é como usar (truques de styling)",
    "X peças que toda mulher precisa no guarda-roupa",
    "Sabe aquela bolsa que todo mundo pergunta onde você comprou? É essa aqui",
    "Depoimento: o sapato mais confortável que eu já usei",
    "Apresentação da loja: onde fica, quanto tempo de mercado, o que vende",
    "Se essa peça fosse sua, em qual look você usaria? (pergunta nos stories)"
].join("\n- ");

function pedidoIdeias(o) {
    const gravadas = o.marcadas.filter(function (m) { return m.status === "gravei"; }).map(function (m) { return m.titulo; });
    const hoje = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "long", year: "numeric" }).format(new Date());
    return "Você é o AGENTE DE IDEIAS, especialista em conteúdo de Reels para lojas brasileiras. Você NÃO escreve roteiros: você entrega uma pauta de ideias de conteúdo que a dona da loja consegue gravar sozinha, com o celular.\n\n" +
        "COMO SÃO AS BOAS IDEIAS (é o estilo que a consultoria já entrega para as lojas; use como referência de jeito e formato, sem copiar):\n- " + REPERTORIO_IDEIAS + "\n\n" +
        "O QUE ENTREGAR: cerca de 15 ideias.\n" +
        "- Títulos curtos e concretos, ligados a peças, ocasiões, eventos e situações da vida da cliente (casamento, date, trabalho, viagem, show, praia, treino). Nada de tema abstrato.\n" +
        "- Cada ideia diz em quais formatos funciona: rápido com transições (até 15 segundos, sem fala, conteúdo visual e dopaminérgico que prende pelo ritmo), narrado (30 a 45 segundos, a dona falando) e provador (mostrando no corpo, com transições e narração leve). O mesmo tema pode render mais de um formato, porque cada pessoa consome de um jeito.\n" +
        "- Pelo menos 6 ideias precisam funcionar como rápido com transições, principalmente para atrair gente nova.\n" +
        "- Distribua entre topo (atrair gente nova), meio (fazer desejar) e fundo (fazer comprar: prova, depoimento, dúvida de tamanho, preço, qualidade), pesando para a etapa em que esta conta está mais fraca.\n" +
        "- Hoje é " + hoje + ". Aproveite datas e eventos das próximas semanas que combinem com esta loja e com a região do público (feriados, datas do varejo, estação, festas e eventos locais). Só use evento que você tem certeza que existe.\n\n" +
        "COMO USAR OS DADOS DESTA LOJA\n" +
        "- Parta do que já funcionou: os assuntos e ganchos que mais seguram gente nos 3 primeiros segundos e por mais tempo, os posts acima da média, os anúncios que mais venderam.\n" +
        "- Transforme as dúvidas e desejos dos comentários em ideias (exemplo: perguntaram do tamanho, vira uma prova real no corpo).\n" +
        "- Use o perfil do público (idade, cidades, ocasiões da vida) para escolher as situações das ideias.\n" +
        "- Em por_que, diga em poucas palavras de onde veio cada ideia.\n\n" +
        "REGRAS\n" +
        "- Nunca invente produto, preço, promoção, depoimento ou número. Se a ideia precisar de um valor ou de uma peça específica, deixe em aberto para a dona completar (Looks por menos de R$ X, a peça campeã de vendas).\n" +
        "- Nunca use estatística ou porcentagem que não esteja escrita nos dados desta loja.\n" +
        "- Quando a ideia for boa para virar anúncio, lembre em como_fazer de conferir o estoque da peça antes de anunciar.\n" +
        "- Não repita as ideias já sugeridas nem as já gravadas listadas abaixo.\n" +
        "- Português do Brasil com acentuação e grafia corretas (pró-labore, não prolabora), mesmo quando os comentários, legendas ou falas trazem erro de digitação. Sem travessão, sem jargão de marketing.\n\n" +
        o.sobreLoja +
        "\n\nPOSTS DA LOJA (do melhor para o pior):\n" + o.posts.slice(0, 15).map(linhaPost).join("\n") +
        (o.ads ? "\n\nANÚNCIOS (do que mais deu resultado para o que menos deu):\n" + o.ads.lista.slice(0, 12).map(function (a, i) { return linhaAnuncio(o.ads.tipo, a, i); }).join("\n") : "") +
        (o.comentarios.length ? "\n\nCOMENTÁRIOS REAIS DAS SEGUIDORAS:\n" + o.comentarios.slice(0, 40).map(function (c) { return "- " + c; }).join("\n") : "") +
        "\n\nRELATÓRIO ORGÂNICO: " + JSON.stringify(o.relOrg) + "\nRELATÓRIO DE ANÚNCIOS: " + JSON.stringify(o.relAds) + "\nRELATÓRIO DE PÚBLICO: " + JSON.stringify(o.relPub) +
        (o.anteriores.length ? "\n\nIDEIAS JÁ SUGERIDAS ANTES (não repita): " + o.anteriores.join(" | ") : "") +
        (gravadas.length ? "\nIDEIAS QUE A DONA JÁ GRAVOU (não repita): " + gravadas.join(" | ") : "");
}

// ---------- a analise completa de uma loja ----------
async function analisarLoja(userId, motivo) {
    const id = encodeURIComponent(userId);
    const [contas, lojas, projetos, marcadas] = await Promise.all([
        banco("contas_meta?user_id=eq." + id + "&select=metricas,dossie,meta"),
        banco("lojas?user_id=eq." + id + "&select=nome,nicho,site").catch(function () { return []; }),
        banco("projetos?user_id=eq." + id + "&select=nome,form&order=criado_em.desc&limit=5").catch(function () { return []; }),
        banco("ideias_marcadas?user_id=eq." + id + "&select=titulo,status&order=criado_em.desc&limit=60").catch(function () { return []; })
    ]);
    const conta = (contas && contas[0]) || {};
    const met = conta.metricas;
    const postsTodos = (met && met.organico && met.organico.posts) || [];
    if (!postsTodos.length && !anunciosDaLoja(met)) throw new Error("Ainda nao ha numeros desta loja. Conecte o Instagram e os anuncios e atualize os dados.");

    await marcar(userId, "Analisando");
    let cacheMeta = null;
    try {
        const sobreLoja = montarSobreLoja((lojas && lojas[0]) || {}, projetos, met);

        // 1) Meta (so o que e novo: falas, textos dos anuncios, comentarios) + publico do Reportei, ao mesmo tempo
        const [daMeta, seguidores] = await Promise.all([
            enriquecerLoja(met, conta.meta).catch(function (e) { console.error("[time] meta: " + (e && e.message)); return { cache: conta.meta || null, pendentes: [] }; }),
            publicoDoReportei(userId)
        ]);
        cacheMeta = daMeta.cache;
        await esperarFalas(daMeta.pendentes);
        aplicarMeta(met, cacheMeta);
        const posts = postsDaLoja(met);
        const comentarios = comentariosDaLoja(met, cacheMeta);
        const ads = anunciosDaLoja(met);
        const comTexto = ads ? ads.lista.filter(function (a) { return a.texto || a.transcricao; }).length : 0;

        // 2) Agente Organico e Agente de Anuncios, ao mesmo tempo
        const pOrg = posts.length ? perguntar("Agente Organico",
            "Você é o AGENTE ORGÂNICO. Estude os posts do Instagram desta loja nos últimos 90 dias, ordenados do melhor para o pior pelo índice (com peso maior para os últimos 30 dias). Descubra o que os posts acima da média têm em comum (gancho, formato, assunto, tamanho, fala) e o que os abaixo da média fazem diferente. Em ganchos_que_funcionam, traga os ganchos reais dos melhores posts (da legenda ou da fala), reescritos de forma curta. Em resumo, 2 frases para a dona da loja.\n\n" +
            sobreLoja + "\nTOTAL DE POSTS NOS 90 DIAS: " + postsTodos.length + " | taxa media de engajamento da conta: " + ((met.organico && met.organico.taxa_media) || 0) + "%\nPOSTS:\n" + posts.map(linhaPost).join("\n"),
            ESQ_ORGANICO) : Promise.resolve(null);
        const tipoTxt = !ads ? "" : ads.tipo === "vendas" ? "compras (a loja tem pixel)" : ads.tipo === "conversas" ? "conversas iniciadas no WhatsApp ou Direct (a loja vende por conversa)" : (ads.totais.misto ? "cada campanha tem o proprio objetivo (veja objetivo medido em cada anuncio); compare so anuncios de mesmo objetivo" : "o objetivo da campanha, indicado em cada anuncio");
        const pAds = ads ? perguntar("Agente de Anuncios",
            "Você é o AGENTE DE ANÚNCIOS. Estude os anúncios desta loja nos últimos 90 dias. " +
            (comTexto ? "Os números vêm do Reportei. Em " + comTexto + " de " + ads.lista.length + " anúncios também vêm o TEXTO DO ANÚNCIO e a FALA DO VÍDEO (da Meta): use-os como fonte principal do gancho e do argumento. Nos outros só há o nome, que costuma descrever o vídeo." : "Só há o nome de cada anúncio (que costuma descrever o vídeo) e os números.") +
            " Descubra o que os anúncios que mais dão resultado têm em comum (gancho, assunto, argumento, oferta, chamada) e onde os fracos perdem gente (no gancho, no corpo ou na chamada). Em resumo, 2 frases para a dona da loja.\n\n" +
            sobreLoja + "\nRESULTADO = " + tipoTxt + "\nTOTAIS 90 DIAS: investido " + brl(ads.totais.gasto) + " | alcance " + (ads.totais.alcance || 0) + " | cliques " + (ads.totais.cliques || 0) +
            (ads.tipo !== "resultados" ? " | " + ads.totais.resultados + " " + nomeResultado(ads.tipo) : "") +
            "\nMEDIAS DA CONTA: taxa de gancho " + (ads.medias.taxa_gancho || 0) + "% | retencao " + (ads.medias.retencao || 0) + "% | taxa de clique " + (ads.medias.ctr || 0) + "%\nANUNCIOS (do que mais deu resultado para o que menos deu):\n" +
            ads.lista.map(function (a, i) { return linhaAnuncio(ads.tipo, a, i); }).join("\n"),
            ESQ_ANUNCIOS) : Promise.resolve(null);
        const [relOrg, relAds] = await Promise.all([pOrg, pAds]);

        // 3) Agente de Publico, com o que os outros dois descobriram
        const relPub = await perguntar("Agente de Publico",
            "Você é o AGENTE DE PÚBLICO. Monte o retrato de quem é o público desta loja: quem é, idade e gênero, regiões, quem mais compra, dores, desejos e objeções. Use os dados de seguidores, as legendas e falas dos posts que mais funcionaram e o que os outros agentes descobriram. Idade, gênero e cidades vêm dos dados de seguidores; quem é, dores, desejos e objeções são leituras suas a partir do conteúdo que engajou, então diga isso quando não houver dado direto. " +
            (comentarios.length ? "Há COMENTÁRIOS REAIS das seguidoras nos melhores posts: são a fonte principal para dores, desejos, objeções e jeito de falar. Em expressoes_reais, traga de 5 a 10 expressões que as seguidoras usam de verdade nos comentários, copiadas como elas escreveram (corrigindo só a acentuação), sem inventar." : "Não há comentários do público nos dados. Em expressoes_reais, traga as frases das legendas ou falas da loja que mais engajaram (são palavras da loja, não do público); se não houver, deixe a lista vazia.") +
            " Em resumo, 2 frases para a dona da loja.\n\n" +
            sobreLoja + "\nSEGUIDORES POR IDADE E GENERO: " + ((seguidores && seguidores.idade_genero) || "nao disponivel") + "\nCIDADES DOS SEGUIDORES: " + ((seguidores && seguidores.cidades) || "nao disponivel") +
            (comentarios.length ? "\nCOMENTARIOS REAIS DAS SEGUIDORAS (dos melhores posts):\n" + comentarios.map(function (c) { return "- " + c; }).join("\n") : "") +
            "\nLEGENDAS E FALAS DOS MELHORES POSTS:\n" + (posts.slice(0, 6).map(function (p, i) { return (i + 1) + ") " + corta(p.legenda, 250) + (p.transcricao ? " | fala: " + corta(p.transcricao, 500) : ""); }).join("\n") || "nenhum") +
            "\nRELATORIO DO AGENTE ORGANICO: " + JSON.stringify(relOrg) + "\nRELATORIO DO AGENTE DE ANUNCIOS: " + JSON.stringify(relAds),
            ESQ_PUBLICO);

        // 4) Diretor (dossie para o Agente MCP) e Agente de Ideias (pauta para a dona), ao mesmo tempo
        const pIdeias = perguntar("Agente de Ideias", pedidoIdeias({ sobreLoja: sobreLoja, posts: posts, ads: ads, comentarios: comentarios, relOrg: relOrg, relAds: relAds, relPub: relPub, anteriores: ((conta.dossie && conta.dossie.ideias && conta.dossie.ideias.lista) || []).map(function (i) { return i.titulo; }), marcadas: marcadas || [] }), ESQ_IDEIAS)
            .catch(function (e) { console.error("[time] ideias: " + (e && e.message)); return null; });
        const pDir = perguntar("Diretor",
            "Você é o DIRETOR do time. Junte os relatórios num dossiê para o Agente MCP, que escreve os roteiros desta loja. Tudo com acentuação correta.\n" +
            "- texto: até 1400 caracteres, denso e específico, para o Agente MCP: quem é o público e como fala, o que funciona no orgânico, o que dá resultado nos anúncios, de 3 a 5 ganchos modelo no estilo do que já funcionou nesta conta e o que evitar.\n" +
            "- resumo_loja: 2 ou 3 frases curtas para a dona da loja ler no celular, sem jargão: o que mais tem dado certo e o que gravar a seguir.\n" +
            "- por_metodo: para cada um dos 5 métodos abaixo, 1 ou 2 frases de como aplicar nesta loja com base nos dados (fftopo = Full Funnel Topo, ffmeio = Full Funnel Meio, fffundo = Full Funnel Fundo, dsb = DSB, angulo = Ângulo).\n" +
            "- nicho: o nicho desta loja.\n\n" + METODOS_RESUMO + "\n\n" + sobreLoja +
            "\nRELATORIO ORGANICO: " + JSON.stringify(relOrg) + "\nRELATORIO DE ANUNCIOS: " + JSON.stringify(relAds) + "\nRELATORIO DE PUBLICO: " + JSON.stringify(relPub) +
            "\n\nLEMBRETE FINAL: texto, resumo_loja e por_metodo vão para a tela da loja e para o Agente MCP, então escreva todos com acentuação completa do português (não, são, vídeo, anúncio, começam, gestão, prática).",
            ESQ_DIRETOR);
        const [dir, ideias] = await Promise.all([pDir, pIdeias]);

        const dossie = {
            versao: VERSAO, periodo_dias: 90, gerado_em: new Date().toISOString(), motivo: motivo || "manual",
            assinatura: met.assinatura || assinaturaDe(met), modelo: MODELO,
            texto: dir.texto, resumo_loja: dir.resumo_loja, por_metodo: dir.por_metodo, nicho: dir.nicho,
            organico: relOrg ? { relatorio: relOrg, total_posts: postsTodos.length, videos: posts.filter(function (p) { return p.transcricao; }).map(function (p) { return { id: p.id, link: p.link, legenda: corta(p.legenda, 80), transcricao: p.transcricao }; }) } : null,
            anuncios: ads ? { relatorio: relAds, tipo_resultado: ads.tipo, total: ads.lista.length, com_texto: comTexto, anuncios: ads.lista.filter(function (a) { return a.transcricao; }).map(function (a) { return { id: a.id, nome: a.nome, transcricao: a.transcricao }; }) } : null,
            ideias: ideias ? Object.assign({ gerado_em: new Date().toISOString(), resumo: ideias.resumo, lista: ideias.ideias || [] }, (conta.dossie && conta.dossie.ideias && conta.dossie.ideias.levas_dia) ? { levas_dia: conta.dossie.ideias.levas_dia, levas: conta.dossie.ideias.levas } : {}) : ((conta.dossie && conta.dossie.ideias) || null),
            publico: relPub, publico_fonte: comentarios.length ? "comentarios" : "legendas",
            meta: cacheMeta ? { em: cacheMeta.em, erro: cacheMeta.erro, comentarios: comentarios.length } : null
        };
        // o cache da Meta vai junto: falas que terminaram durante a analise tambem ficam guardadas
        await banco("contas_meta", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: Object.assign({ user_id: userId, dossie: dossie, status: "Analisada", atualizado_em: dossie.gerado_em }, cacheMeta ? { meta: cacheMeta } : {}) });
        const falas = posts.filter(function (p) { return p.transcricao; }).length + (ads ? ads.lista.filter(function (a) { return a.transcricao; }).length : 0);
        return { ok: true, ideias: ideias ? (ideias.ideias || []).length : 0, posts: posts.length, anuncios: ads ? ads.lista.length : 0, falas: falas, comentarios: comentarios.length, meta_erro: cacheMeta ? cacheMeta.erro : null, nicho: dossie.nicho };
    } catch (e) {
        await marcar(userId, "Erro na analise: " + corta(e && e.message, 160)).catch(function () {});
        // o que ja veio da Meta nao se perde se um agente falhar
        if (cacheMeta) await banco("contas_meta?user_id=eq." + id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { meta: cacheMeta } }).catch(function () {});
        throw e;
    }
}

function marcar(userId, status) {
    return banco("contas_meta?user_id=eq." + encodeURIComponent(userId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { status: status, atualizado_em: new Date().toISOString() } });
}

// A loja precisa de uma analise nova? (linha de contas_meta com os campos do filtro em api/atualizar.js)
function precisaAnalisar(c, agora) {
    if (!c || !c.assinatura) return false;                                   // sem numeros ainda
    const desde = c.atualizado_em ? agora - new Date(c.atualizado_em).getTime() : Infinity;
    if (c.status === "Analisando" && desde < TRAVADA_MS) return false;       // ja tem uma rodando
    if (/^Erro/.test(c.status || "") && desde < NOVIDADE_MS) return false;   // deu erro: espera antes de tentar de novo
    if (String(c.dossie_versao) !== String(VERSAO) || !c.dossie_em) return true; // nunca analisada neste formato
    const idade = agora - new Date(c.dossie_em).getTime();
    if (idade >= DIA_MS) return true;
    return c.assinatura !== c.dossie_assinatura && idade >= NOVIDADE_MS;
}

module.exports = { analisarLoja, precisaAnalisar, gerarMaisIdeias, ErroIdeias, VERSAO, _interno: { postsDaLoja, linhaPost, anunciosDaLoja, linhaAnuncio, ESQ_DIRETOR, SISTEMA_TIME } };
