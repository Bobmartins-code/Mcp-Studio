// =====================================================================
//  ROTEIROS NO SERVIDOR (Novo roteiro, "Gerar mais" e "Refazer")
//  A geracao roda aqui e cada roteiro e gravado no projeto assim que fica
//  pronto: a dona pode fechar o app ou a tela apagar que nada se perde.
//
//  Por rodada (3 roteiros do metodo escolhido):
//    1. Direcao do conteudo (objetivo, publico, mensagem e chamada), feita
//       pela IA sem a dona precisar preencher nada; aparece depois como
//       "Por que estes roteiros".
//    2. Os 3 roteiros ao mesmo tempo, cada um com uma estrutura diferente
//       (o pacote de dados vai no cache: os 2 ultimos pagam 10% dele).
//       Formato garantido pela IA: roteiro pronto para gravar (cenas, texto
//       na tela, capa, legenda, hashtags) e 2 aberturas extras para testar.
//    3. Conferencia automatica (travessao, "nao e X, e Y", palavras de IA,
//       numero que nao esta nos dados, gancho longo) e revisor em todas as
//       rodadas, com a lista do que a conferencia achou.
//  Os dados da loja (dossie, voz, ganchos, duvidas do publico, memoria do
//  time e produtos do momento) sao montados aqui, direto do banco.
// =====================================================================

const crypto = require("crypto");
const { banco, acessoLiberado, SEM_ACESSO } = require("./_seguranca.js");
const { diaSP } = require("./_coleta.js");
const { SISTEMA: AGENTE } = require("./_agente-mcp.js");
const { conversa: T } = require("./_time-agentes.js");
const { registrarFalha } = require("./_uso-ia.js");

const ROTEIRISTA = "claude-opus-5-5", AJUDANTE = "claude-sonnet-5";
const POR_RODADA = 3, MAX_RODADAS = 5, MAX_DIA = 40;
const METODOS = {
    fftopo: { nome: "Full Funnel Topo (Consciência)", pilar: "Topo - Consciencia", funil: "topo" },
    ffmeio: { nome: "Full Funnel Meio (Conceito Criativo)", pilar: "Meio - Conceito Criativo", funil: "meio" },
    fffundo: { nome: "Full Funnel Fundo (Decisão e Prova)", pilar: "Fundo - Decisao e Prova", funil: "fundo" },
    dsb: { nome: "DSB (Dor, Solução, Benefício)", pilar: "DSB", funil: "meio" },
    angulo: { nome: "Ângulo (Diferencial concreto)", pilar: "Angulo", funil: "meio" }
};
const ESTRUTURAS = [
    "opinião forte: a dona defende uma ideia, explica por quê e fecha com a conclusão",
    "demonstração: mostra na prática, no corpo, no espelho ou na peça",
    "situação do dia a dia: a cena que a cliente vive, contada de um jeito que ela se reconhece, com a peça resolvendo",
    "lista curta: 2 ou 3 sinais, erros ou jeitos de usar, cada um com um exemplo real",
    "história: algo que aconteceu na loja ou com uma cliente, contado como conversa (só com fatos dos dados)",
    "experiência de quem faz: o que a dona aprendeu vendendo, com a lição concreta"
];
const FECHAMENTOS = [
    "a conclusão da dona e um convite direto para o destino",
    "um convite leve, amarrado a um benefício concreto da peça",
    "um pedido para comentar ou mandar uma palavra no direct (só este roteiro da rodada usa palavra-chave)"
];
const DESTINOS = {
    mensagens: "a pessoa chamar no WhatsApp ou no direct (a loja vende por conversa)",
    seguidores: "a pessoa seguir o perfil no Instagram",
    site: "a pessoa ir para o site ou o link da bio para comprar"
};

// ---------- formato da resposta (a API garante) ----------
const txt = T.textoPT, lst = T.listaPT;
const ESQ_ROTEIRO = T.objeto({
    titulo: txt("Título curto do roteiro, de 3 a 7 palavras."),
    gancho: txt("A primeira fala (ou, no vídeo sem fala, o texto do primeiro segundo): curta, até 15 palavras."),
    aberturas_extras: lst("Outras 2 aberturas diferentes para testar no lugar do gancho, cada uma com até 15 palavras e outro tipo de começo."),
    corpo: txt("O desenvolvimento, do jeito que a dona fala."),
    cta: txt("O fechamento: a conclusão e um convite curto coerente com o destino."),
    cenas: {
        type: "array", description: "O roteiro pronto para gravar, na ordem, cobrindo gancho, corpo e fechamento.",
        items: T.objeto({
            fala: txt("O que a dona fala nesta cena (vazio no vídeo sem fala)."),
            na_tela: txt("O que aparece na imagem: enquadramento, peça, ação."),
            texto_tela: txt("Texto escrito por cima do vídeo nesta cena, curto (até 6 palavras), ou vazio.")
        })
    },
    texto_capa: txt("Texto da capa do Reels, até 6 palavras."),
    legenda: txt("Legenda do post, de 1 a 3 frases, no jeito da dona, terminando com o convite."),
    hashtags: lst("De 3 a 5 hashtags específicas do nicho e da cidade, sem o símbolo repetido e sem hashtag genérica como #instagood."),
    duracao_s: { type: "integer", description: "Duração estimada em segundos." }
});
const ESQ_DIRECAO = T.objeto({
    objetivo: txt("O que estes roteiros precisam fazer a pessoa pensar ou sentir, 1 frase."),
    publico: txt("Quem é a pessoa nesta etapa, com o momento de vida e a dor ou o desejo dela, 1 frase."),
    mensagem: txt("A ideia central que os roteiros vão passar, 1 frase específica deste negócio."),
    chamada: txt("A chamada final, curta, na linguagem do público e coerente com o destino."),
    nome: txt("Nome curto do produto ou da coleção para dar nome ao projeto, de 2 a 4 palavras."),
    nicho: { type: "string", enum: ["moda feminina", "moda masculina", "moda infantil", "moda fitness", "lingerie e moda intima", "calcados", "bolsas e acessorios", "joias e bijuterias", "beleza e cosmeticos", "saude e suplementos", "casa e decoracao", "alimentos e doces", "pet", "servicos", "cursos e infoprodutos", "outros"] }
});

// ---------- dados da loja (direto do banco) ----------
function corta(t, n) { return T.corta(t, n); }
function aspas(t) { return "'" + String(t || "").replace(/"/g, "'") + "'"; }
function dadosDaLoja(dossie, memoria, loja, metodo) {
    const d = dossie || {}, p = [], pub = d.publico || {}, g = d.ganchos || {}, v = d.voz || {};
    if (d.texto) p.push("DOSSIÊ DA CONTA (o time de agentes, com os números reais dos últimos 90 dias do Instagram e dos anúncios desta loja; é a fonte mais importante para decidir assunto, gancho e argumento): " + d.texto);
    if (d.por_metodo && d.por_metodo[metodo]) p.push("ORIENTAÇÃO DO TIME PARA ESTE MÉTODO NESTA CONTA: " + d.por_metodo[metodo]);
    if ((v.falas || []).length) p.push("VOZ DA LOJA (falas reais da dona nos vídeos que mais deram certo; estude como ela abre, desenvolve e fecha, e escreva nesse jeito, sem copiar as frases): " + v.falas.map(function (t, i) { return "[" + (i + 1) + "] " + t; }).join(" "));
    if ((v.comentarios || []).length) p.push("COMENTÁRIOS REAIS DAS CLIENTES (use as palavras delas): " + v.comentarios.slice(0, 12).map(aspas).join(" | "));
    const duvidas = [].concat(pub.objecoes || [], pub.motivos_nao_compra || []).slice(0, 10);
    if (duvidas.length) p.push("DÚVIDAS E OBJEÇÕES REAIS DO PÚBLICO (os roteiros de venda respondem a elas com prova): " + duvidas.join(" | "));
    if ((pub.perguntas_clientes || []).length) p.push("O QUE AS CLIENTES MAIS PERGUNTAM NOS COMENTÁRIOS: " + pub.perguntas_clientes.slice(0, 8).map(function (q) { return (q.duvida || q) + (q.quantas ? " (" + q.quantas + " vezes)" : ""); }).join(" | "));
    if ((pub.expressoes_reais || []).length) p.push("COMO AS CLIENTES FALAM: " + pub.expressoes_reais.slice(0, 10).map(aspas).join(" | "));
    if ((pub.situacoes || []).length) p.push("SITUAÇÕES DO DIA A DIA DA CLIENTE: " + pub.situacoes.slice(0, 8).join(" | "));
    function lin(x) { return aspas(x.texto) + (x.ficaram != null ? " (" + String(x.ficaram).replace(".", ",") + "% ficaram)" : x.indice ? " (" + String(x.indice).replace(".", ",") + "x a média)" : ""); }
    if ((g.melhores || []).length) p.push("ABERTURAS QUE MAIS PRENDERAM NESTA CONTA (medida: " + (g.medida || "engajamento") + "; use o tipo de abertura, com palavras novas): " + g.melhores.map(lin).join(" | "));
    if ((g.piores || []).length) p.push("ABERTURAS QUE MAIS PERDERAM GENTE (fuja deste tipo): " + g.piores.map(lin).join(" | "));
    if ((g.anuncios || []).length) p.push("ABERTURAS DOS ANÚNCIOS COM MAIS GENTE PARANDO PARA VER: " + g.anuncios.map(function (x) { return aspas(x.texto) + " (" + String(x.gancho_anuncio).replace(".", ",") + "% pararam)"; }).join(" | "));
    const mem = T.textoMemoria(memoria);
    if (mem) p.push(mem.trim());
    const lj = T.textoDaLoja(loja || {});
    if (lj) p.push(lj);
    return p.join("\n\n");
}
// tamanho calibrado pelo tempo que o publico desta conta assiste
function tamanho(dossie, formato) {
    const t = Number(dossie && dossie.tempo_medio_conta) || 0;
    if (formato === "curto") return "DURAÇÃO: de 7 a 15 segundos, com cortes de 1 a 2 segundos.";
    if (!t) return "DURAÇÃO: de 25 a 45 segundos de fala.";
    const palavras = Math.max(20, Math.round(t * 2.6)), min = Math.max(15, Math.round(t * 1.6)), max = Math.min(45, Math.max(25, Math.round(t * 3)));
    return "DURAÇÃO CALIBRADA PARA ESTA CONTA: o público assiste em média " + String(t).replace(".", ",") + " segundos. O gancho e o argumento principal cabem nas primeiras " + palavras + " palavras da fala, e o vídeo inteiro fica entre " + min + " e " + max + " segundos.";
}

// ---------- conferencia automatica (antes do revisor) ----------
const PALAVRAS_IA = ["transformar", "transforma", "elevar", "eleve", "jornada", "incrível", "descomplicar", "descomplica", "potencializar", "revolucion", "desbloque", "mergulhe", "mergulhar", "próximo nível", "sem igual", "surpreendente", "essencial para"];
function conferir(r, fonte) {
    const achados = [], tudo = [r.gancho, r.corpo, r.cta].concat((r.cenas || []).map(function (c) { return c.fala + " " + c.texto_tela; })).join(" ");
    if (/[—–]/.test(tudo)) achados.push("tem travessão: troque por vírgula ou ponto");
    if (/n[ãa]o (é|são|era|foi) [^.,;!?]{1,40}[,;] ?(é|são|era|foi) /i.test(tudo)) achados.push("usa o molde 'não é X, é Y', típico de texto de IA");
    const ia = PALAVRAS_IA.filter(function (p) { return tudo.toLowerCase().indexOf(p) > -1; });
    if (ia.length) achados.push("usa palavras de efeito de IA: " + ia.join(", "));
    const palavrasGancho = String(r.gancho || "").split(/\s+/).filter(Boolean).length;
    if (palavrasGancho > 16) achados.push("gancho longo (" + palavrasGancho + " palavras): corte para até 15");
    // numero, preco ou porcentagem que nao esta nos dados vira promessa que a loja nao cumpre
    const fonteNum = String(fonte || "").replace(/[\s.,]/g, "");
    const nums = (tudo.match(/R\$\s?\d[\d.,]*|\d+[.,]?\d*\s?%|\b\d[\d.,]*\s?(?:mil\s)?(?:peças|clientes|vendas|pedidos|avaliações|unidades|seguidoras|seguidores|anos|meses)\b/gi) || []).map(function (n) { return n.trim(); });
    const inventados = nums.filter(function (n, i, v) { const so = (n.match(/\d[\d.,]*/) || [""])[0].replace(/[.,]/g, ""); return v.indexOf(n) === i && so && fonteNum.indexOf(so) < 0; });
    if (inventados.length) achados.push("números que não estão nos dados da loja: " + inventados.slice(0, 5).join(", ") + " (tire ou troque por algo que está nos dados)");
    return achados;
}
function semTravessao(v) {
    if (typeof v === "string") return v.replace(/,?[ \t]*[—–][ \t]*/g, ", ");
    if (Array.isArray(v)) return v.map(semTravessao);
    if (v && typeof v === "object") { const o = {}; Object.keys(v).forEach(function (k) { o[k] = semTravessao(v[k]); }); return o; }
    return v;
}

// ---------- pedidos para a IA ----------
function regrasDoFormato(formato) {
    if (formato !== "curto") return "FORMATO: vídeo narrado, a dona falando para a câmera. Em cenas, cada fala vem com o que aparece na imagem e o texto na tela, para ela gravar direto do celular e quem assiste sem som entender.";
    return "FORMATO: VÍDEO CURTO SEM FALA, de topo de funil. " + ((T.ESPECIALISTAS.curto || {}).texto || "") +
        "\nNeste formato: gancho = o que aparece e o texto no primeiro segundo; corpo = a sequência de tomadas em poucas palavras; cta = o texto final na tela; cenas = de 4 a 8 tomadas com fala vazia, o que aparece e o texto na tela; aberturas_extras = 2 outros primeiros segundos.";
}
function pedidoRoteiro(base, k, total, estrutura, pergunta, jaUsados, fechamento) {
    return [
        { type: "text", text: base, cache_control: { type: "ephemeral" } },
        { type: "text", text: "SUA TAREFA AGORA: escreva o roteiro " + k + " de " + total + " desta rodada, na estrutura " + estrutura + "." +
            (pergunta ? " O gancho pode ser uma pergunta." : " O gancho NÃO é pergunta (outro roteiro da rodada usa pergunta).") +
            " Feche com " + fechamento + "." +
            " Os outros roteiros da rodada usam outras estruturas e outros fechamentos, então faça este bem diferente deles." +
            " Use pelo menos um dado concreto dos DADOS DESTA LOJA (a peça, a cor, o tamanho, o preço, uma dúvida real das clientes ou o tipo de vídeo que mais rende nela) e, em loja de roupa, mostre a peça vestida no corpo em pelo menos uma cena." +
            (jaUsados.length ? " Ganchos que já existem neste projeto (comece de outro jeito): " + jaUsados.slice(-12).map(aspas).join(" | ") : "") }
    ];
}
function pedidoRevisor(r, achados, vozLoja, destino, formato) {
    return "Você é o REVISOR do MCP Studio. Releia o roteiro abaixo antes de a dona receber. O objetivo é que ele soe como a própria dona falando, e não como texto de IA ou de anúncio.\n" +
        "Passe por estes testes: 1) lido em voz alta, soa como uma pessoa conversando, com frases de tamanhos variados e contrações (pra, tá, né)? 2) se outra loja pudesse falar a mesma frase, troque por um detalhe concreto dos dados; 3) a dona falaria com essas palavras? 4) sem marcas de IA (molde 'não é X, é Y', três palavras em sequência, palavras de efeito vazias, travessão); 5) a venda aparece só no final, de leve; 6) nada de palavra em inglês além de Reels, stories, direct, close e POV.\n" +
        (achados.length ? "A CONFERÊNCIA AUTOMÁTICA ACHOU E VOCÊ PRECISA CORRIGIR: " + achados.join("; ") + ".\n" : "") +
        "Mantenha o que está bom, o mesmo assunto, a mesma estrutura, um tamanho parecido e o mesmo destino (" + destino + "). Use só fatos que já estão no roteiro ou nos dados. Ajuste as cenas, as aberturas extras, a capa e a legenda junto com o texto." +
        (formato === "curto" ? " É um vídeo curto sem fala: as falas das cenas ficam vazias." : "") +
        (vozLoja ? "\n" + vozLoja : "") + "\n\nROTEIRO: " + JSON.stringify(r);
}
async function fazerDirecao(uid, contexto, dados, metodo, imagens) {
    const texto = "Antes de escrever os roteiros de Reels, monte a DIREÇÃO do conteúdo para o método " + METODOS[metodo].nome + ". Frases curtas e simples, específicas deste negócio.\n\n" + contexto + (dados ? "\n\n" + corta(dados, 6000) : "");
    const pedido = (imagens || []).length ? imagens.concat([{ type: "text", text: "As imagens acima são do produto. " + texto }]) : texto;
    return T.perguntar(uid, { nome: "Direcao do roteiro", esquema: ESQ_DIRECAO, pedido: pedido, max: 3000, modelo: AJUDANTE, effort: "low", sistema: AGENTE });
}
async function umRoteiro(uid, sistema, conteudo, aoComecar) {
    return T.perguntar(uid, { nome: "Roteiro", esquema: ESQ_ROTEIRO, pedido: conteudo, max: 12000, modelo: ROTEIRISTA, effort: "high", sistema: sistema }, aoComecar);
}
async function revisar(uid, r, achados, vozLoja, destino, formato) {
    try {
        const n = await T.perguntar(uid, { nome: "Revisor", esquema: ESQ_ROTEIRO, pedido: pedidoRevisor(r, achados, vozLoja, destino, formato), max: 8000, modelo: ROTEIRISTA, effort: "medium", sistema: AGENTE });
        return Object.assign({}, r, n, { revisado: true });
    } catch (e) { console.error("[roteiros] revisor: " + (e && e.message)); return r; }
}
function limpar(r, formato) {
    r = semTravessao(r);
    r.aberturas_extras = (r.aberturas_extras || []).filter(Boolean).slice(0, 2);
    // hashtag sem acento e sem espaco, do jeito que o Instagram agrupa
    r.hashtags = (r.hashtags || []).map(function (h) { return "#" + String(h).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/^#+/, "").replace(/\s+/g, "").toLowerCase(); }).filter(function (h) { return h.length > 1; }).slice(0, 5);
    r.cenas = (r.cenas || []).slice(0, 12).map(function (c) { return { fala: formato === "curto" ? "" : c.fala || "", na_tela: c.na_tela || "", texto_tela: c.texto_tela || "" }; });
    return r;
}

// ---------- gravar no projeto sem atropelar (uma gravacao por vez, relendo antes) ----------
function gravador(pid, uid) {
    let fila = Promise.resolve();
    const rota = "projetos?id=eq." + encodeURIComponent(pid) + "&user_id=eq." + encodeURIComponent(uid);
    return function (mudar) {
        fila = fila.then(async function () {
            const r = await banco(rota + "&select=rodadas");
            const rods = mudar(((r && r[0] && r[0].rodadas) || []).slice());
            if (rods) await banco(rota, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { rodadas: rods } });
        }).catch(function (e) { console.error("[roteiros] gravar: " + (e && e.message)); });
        return fila;
    };
}
function mexeNaRodada(rid, fn) { return function (rods) { const i = rods.findIndex(function (x) { return x && x.rid === rid; }); if (i < 0) return null; rods[i] = fn(Object.assign({}, rods[i])); return rods; }; }
function todosDoProjeto(rods) { const v = []; (rods || []).forEach(function (r) { ((r.resultado && r.resultado.roteiros) || []).forEach(function (s) { v.push(s); }); }); return v; }

// ---------- uma rodada inteira ----------
async function gerarRodada(uid, proj, pedido, carregado) {
    const metodo = METODOS[pedido.metodo] ? pedido.metodo : "fftopo", formato = pedido.formato === "curto" ? "curto" : "narrado";
    const grava = gravador(proj.id, uid);
    const rods0 = proj.rodadas || [];
    const dossie = carregado.dossie || {}, dados = dadosDaLoja(dossie, carregado.memoria, carregado.loja, metodo);
    const destino = DESTINOS[(proj.form && proj.form.objetivo) || proj.objetivo] || DESTINOS.site;
    const contexto = "NEGÓCIO E PEDIDO DA DONA:\n" + corta(pedido.contexto, 12000) + "\nDESTINO DOS ROTEIROS: " + destino + ".";
    // a rodada aparece na hora como "escrevendo"
    const rid = crypto.randomUUID(), numero = rods0.length + 1, quantos = Math.max(1, Math.min(POR_RODADA, Number(pedido.quantos) || POR_RODADA));
    const hoje = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(new Date());
    await grava(function (rods) { rods.push({ rid: rid, numero: numero, metodo: metodo, formato: formato, quantos: quantos, direcao: pedido.direcao || null, data: hoje, gerando: true, iniciado_em: new Date().toISOString(), resultado: { roteiros: [] } }); return rods; });
    try {
    // 1. direcao (sem a dona preencher nada)
    let direcao = pedido.direcao || null;
    if (!direcao) {
        try { direcao = await fazerDirecao(uid, contexto, dados, metodo, pedido.imagens); } catch (e) { console.error("[roteiros] direcao: " + (e && e.message)); }
        if (direcao) {
            await grava(mexeNaRodada(rid, function (r) { r.direcao = direcao; return r; }));
            if (pedido.renomear && direcao.nome) await banco("projetos?id=eq." + encodeURIComponent(proj.id) + "&user_id=eq." + encodeURIComponent(uid), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { nome: corta(direcao.nome, 40), form: Object.assign({}, proj.form || {}, { nicho: direcao.nicho }) } }).catch(function () {});
        }
    }
    // 2. os roteiros, ao mesmo tempo
    const sistema = AGENTE + "\n\n" + regrasDoFormato(formato);
    const dirTxt = direcao ? "DIREÇÃO DO CONTEÚDO (siga em todos os roteiros; a chamada é a base do fechamento): objetivo: " + direcao.objetivo + " | público: " + direcao.publico + " | mensagem principal: " + direcao.mensagem + " | chamada: " + direcao.chamada : "";
    const base = "MÉTODO DESTA RODADA: " + METODOS[metodo].nome + " (código " + metodo + "). Siga esse método da sua base de métodos.\n" + tamanho(dossie, formato) + "\n\n" + contexto + "\n\n" + dirTxt + (dados ? "\n\nDADOS DESTA LOJA:\n" + dados : "");
    const fonteNumeros = base;
    const jaUsados = todosDoProjeto(rods0).map(function (s) { return s.gancho; }).filter(Boolean);
    const ini = (numero - 1) * 2;
    const estruturas = Array.from({ length: quantos }, function (_, i) { return ESTRUTURAS[(ini + i) % ESTRUTURAS.length]; });
    const vozLoja = ((dossie.voz || {}).falas || []).length ? "VOZ DA LOJA: " + dossie.voz.falas.map(function (t, i) { return "[" + (i + 1) + "] " + corta(t, 900); }).join(" ") : "";
    const maxAntes = Math.max(0, ...todosDoProjeto(rods0).map(function (s) { return Number(s.id) || 0; }));
    let feitos = 0, falhas = 0;
    async function fazer(i, aoComecar) {
        let r;
        for (let tentativa = 0; tentativa < 2 && !r; tentativa++) {
            try { r = await umRoteiro(uid, sistema, pedidoRoteiro(base, i + 1, quantos, estruturas[i], i === 0, jaUsados, FECHAMENTOS[i % FECHAMENTOS.length]), tentativa === 0 ? aoComecar : null); }
            catch (e) { console.error("[roteiros] roteiro " + (i + 1) + ": " + (e && e.message)); if (tentativa === 0 && aoComecar) aoComecar(); }
        }
        if (!r) { falhas++; registrarFalha(uid, "roteiro", "um roteiro da rodada não saiu"); return; }
        r = limpar(r, formato);
        r = limpar(await revisar(uid, r, conferir(r, fonteNumeros), vozLoja, destino, formato), formato);
        const sobrou = conferir(r, fonteNumeros);
        const roteiro = Object.assign({ id: maxAntes + i + 1, metodo: metodo, formato: formato, pilar: METODOS[metodo].pilar, funil: METODOS[metodo].funil, estrutura: estruturas[i].split(":")[0], ordem: i }, r, sobrou.length ? { avisos: sobrou } : {});
        feitos++;
        await grava(mexeNaRodada(rid, function (rd) {
            const lista = ((rd.resultado && rd.resultado.roteiros) || []).concat([roteiro]).sort(function (a, b) { return (a.ordem || 0) - (b.ordem || 0); });
            rd.resultado = Object.assign({}, rd.resultado, { roteiros: lista });
            return rd;
        }));
    }
    // o primeiro vai sozinho e grava o cache; os outros saem quando ele comeca a responder
    let libera; const comecou = new Promise(function (ok) { libera = ok; });
    const tarefas = [fazer(0, libera).finally(libera)];
    tarefas.push(Promise.race([comecou, T.espera(20000)]).then(function () { return Promise.all(Array.from({ length: quantos - 1 }, function (_, j) { return fazer(j + 1); })); }));
    await Promise.all(tarefas);
    await grava(mexeNaRodada(rid, function (rd) { rd.gerando = false; rd.concluido_em = new Date().toISOString(); if (falhas) rd.faltaram = falhas; return rd; }));
    return { ok: feitos > 0, roteiros: feitos, faltaram: falhas };
    } catch (e) {
        await grava(mexeNaRodada(rid, function (rd) { rd.gerando = false; rd.erro = true; return rd; }));
        registrarFalha(uid, "rodada de roteiros", e && e.message);
        throw e;
    }
}

// ---------- refazer um roteiro (mesmo metodo, outra estrutura) ----------
async function refazerRoteiro(uid, proj, pedido, carregado) {
    const rods = proj.rodadas || [];
    let alvo = null, rodada = null;
    rods.forEach(function (rd) { ((rd.resultado && rd.resultado.roteiros) || []).forEach(function (s) { if (String(s.id) === String(pedido.roteiro_id)) { alvo = s; rodada = rd; } }); });
    if (!alvo) { const e = new Error("Não achei esse roteiro."); e.status = 404; throw e; }
    const metodo = METODOS[alvo.metodo] ? alvo.metodo : (METODOS[rodada.metodo] ? rodada.metodo : "fftopo"), formato = alvo.formato || rodada.formato || "narrado";
    const dossie = carregado.dossie || {}, dados = dadosDaLoja(dossie, carregado.memoria, carregado.loja, metodo);
    const destino = DESTINOS[(proj.form && proj.form.objetivo) || proj.objetivo] || DESTINOS.site;
    const dir = rodada.direcao;
    const base = "MÉTODO: " + METODOS[metodo].nome + " (código " + metodo + ").\n" + tamanho(dossie, formato) + "\n\nNEGÓCIO E PEDIDO DA DONA:\n" + corta(pedido.contexto, 12000) + "\nDESTINO: " + destino + "." +
        (dir ? "\n\nDIREÇÃO DO CONTEÚDO: objetivo: " + dir.objetivo + " | público: " + dir.publico + " | mensagem: " + dir.mensagem + " | chamada: " + dir.chamada : "") + (dados ? "\n\nDADOS DESTA LOJA:\n" + dados : "");
    const outra = ESTRUTURAS.find(function (e) { return e.split(":")[0] !== alvo.estrutura; }) || ESTRUTURAS[0];
    const conteudo = [{ type: "text", text: base }, { type: "text", text: "SUA TAREFA: escreva UM roteiro novo para substituir este, que a dona não quis: " + aspas(alvo.gancho) + ". Use a estrutura " + outra + " e um começo bem diferente." }];
    let r = limpar(await umRoteiro(uid, AGENTE + "\n\n" + regrasDoFormato(formato), conteudo), formato);
    const vozLoja = ((dossie.voz || {}).falas || []).length ? "VOZ DA LOJA: " + dossie.voz.falas.map(function (t, i) { return "[" + (i + 1) + "] " + corta(t, 900); }).join(" ") : "";
    r = limpar(await revisar(uid, r, conferir(r, base), vozLoja, destino, formato), formato);
    const novo = Object.assign({}, alvo, r, { estrutura: outra.split(":")[0], editado: true, liked: false, vendeu: false, copiado: 0, gravado: false, gravado_em: null, avisos: undefined });
    await gravador(proj.id, uid)(function (rs) {
        return rs.map(function (rd) { return Object.assign({}, rd, { resultado: Object.assign({}, rd.resultado, { roteiros: ((rd.resultado && rd.resultado.roteiros) || []).map(function (s) { return String(s.id) === String(alvo.id) ? novo : s; }) }) }); });
    });
    return { ok: true, roteiro: novo };
}

async function ajustarRoteiro(uid, proj, pedido, carregado) {
    let alvo = null;
    (proj.rodadas || []).forEach(function (rd) { ((rd.resultado && rd.resultado.roteiros) || []).forEach(function (s) { if (String(s.id) === String(pedido.roteiro_id)) alvo = s; }); });
    if (!alvo) { const e = new Error("Não achei esse roteiro."); e.status = 404; throw e; }
    const instrucao = String(pedido.instrucao || "").trim().slice(0, 600);
    if (instrucao.length < 3) { const e = new Error("Escreva o que você quer ajustar."); e.status = 400; throw e; }
    const formato = alvo.formato || "narrado", dossie = carregado.dossie || {};
    const destino = DESTINOS[(proj.form && proj.form.objetivo) || proj.objetivo] || DESTINOS.site;
    const vozLoja = ((dossie.voz || {}).falas || []).length ? "VOZ DA LOJA: " + dossie.voz.falas.map(function (t, i) { return "[" + (i + 1) + "] " + corta(t, 900); }).join(" ") : "";
    const atual = { titulo: alvo.titulo, gancho: alvo.gancho, aberturas_extras: alvo.aberturas_extras || [], corpo: alvo.corpo, cta: alvo.cta, cenas: alvo.cenas || [], texto_capa: alvo.texto_capa || "", legenda: alvo.legenda || "", hashtags: alvo.hashtags || [], duracao_s: alvo.duracao_s || 30 };
    const texto = "A dona pediu este ajuste no roteiro: " + JSON.stringify(instrucao) + ".\nReescreva o roteiro aplicando o pedido. O pedido dela vale mais que as regras gerais, desde que não invente preço, produto, depoimento ou número. Mantenha o resto do que está bom, o mesmo destino (" + destino + ") e ajuste as cenas, as aberturas extras, a capa e a legenda junto com o texto. Frases simples, sem inglês além de Reels, stories, direct, close e POV." +
        (formato === "curto" ? " É um vídeo curto sem fala: as falas das cenas ficam vazias." : "") + (vozLoja ? "\n" + vozLoja : "") + "\n\nROTEIRO ATUAL: " + JSON.stringify(atual);
    let r = limpar(await T.perguntar(uid, { nome: "Ajuste de roteiro", esquema: ESQ_ROTEIRO, pedido: texto, max: 8000, modelo: ROTEIRISTA, effort: "medium", sistema: AGENTE + "\n\n" + regrasDoFormato(formato) }), formato);
    const novo = Object.assign({}, alvo, r, { editado: true, avisos: undefined });
    await gravador(proj.id, uid)(function (rs) {
        return rs.map(function (rd) { return Object.assign({}, rd, { resultado: Object.assign({}, rd.resultado, { roteiros: ((rd.resultado && rd.resultado.roteiros) || []).map(function (s) { return String(s.id) === String(alvo.id) ? novo : s; }) }) }); });
    });
    return { ok: true, roteiro: novo };
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let uid;
    try { uid = await acessoLiberado(jwt); } catch (e) { return res.status(500).json({ error: "Não consegui confirmar o seu acesso. Tente de novo." }); }
    if (!uid) return res.status(jwt ? 403 : 401).json({ error: jwt ? SEM_ACESSO : "Entre na sua conta de novo." });
    const b = req.body || {};
    if (!/^[0-9a-f-]{36}$/i.test(String(b.projeto_id || ""))) return res.status(400).json({ error: "Projeto não informado." });
    const imagens = (Array.isArray(b.imagens) ? b.imagens : []).slice(0, 4).filter(function (im) { return im && /^image\/(jpeg|png|webp|gif)$/.test(im.media_type) && typeof im.data === "string" && im.data.length < 2800000; })
        .map(function (im) { return { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }; });
    try {
        const id = encodeURIComponent(uid);
        const [projs, contas, lojas] = await Promise.all([
            banco("projetos?id=eq." + encodeURIComponent(b.projeto_id) + "&user_id=eq." + id + "&select=id,nome,objetivo,form,rodadas"),
            banco("contas_meta?user_id=eq." + id + "&select=dossie,memoria").catch(function () { return []; }),
            banco("lojas?user_id=eq." + id + "&select=produtos_dona,produtos_dona_em,produtos_admin").catch(function () { return []; })
        ]);
        const proj = projs && projs[0];
        if (!proj) return res.status(404).json({ error: "Não achei esse projeto." });
        const carregado = { dossie: (contas && contas[0] && contas[0].dossie) || {}, memoria: (contas && contas[0] && contas[0].memoria) || {}, loja: (lojas && lojas[0]) || {} };
        const pedido = { metodo: b.metodo, formato: b.formato, contexto: String(b.contexto || "").slice(0, 12000), direcao: b.direcao && b.direcao.objetivo ? b.direcao : null, imagens: imagens, renomear: !!b.renomear, roteiro_id: b.roteiro_id, quantos: b.quantos };
        if (b.acao === "refazer") return res.status(200).json(await refazerRoteiro(uid, proj, pedido, carregado));
        if (b.acao === "ajustar") return res.status(200).json(await ajustarRoteiro(uid, proj, Object.assign(pedido, { instrucao: b.instrucao }), carregado));
        if ((proj.rodadas || []).length >= MAX_RODADAS) return res.status(409).json({ error: "Este projeto já tem " + MAX_RODADAS + " rodadas. Crie um projeto novo para gerar mais." });
        if ((proj.rodadas || []).some(function (r) { return r.gerando && Date.now() - new Date(r.iniciado_em).getTime() < 5 * 60000; })) return res.status(409).json({ error: "O time ainda está escrevendo os roteiros deste projeto. Espere terminar." });
        const hoje = new Date(diaSP(new Date()) + "T00:00:00-03:00").toISOString();
        const usos = await banco("uso_ia?user_id=eq." + id + "&funcao=eq.Roteiro&criado_em=gte." + encodeURIComponent(hoje) + "&select=id").catch(function () { return []; });
        if ((usos || []).length >= MAX_DIA * POR_RODADA) return res.status(429).json({ error: "Você já gerou muitos roteiros hoje. Amanhã o time volta a escrever!" });
        return res.status(200).json(await gerarRodada(uid, proj, pedido, carregado));
    } catch (e) {
        if (e && e.status) return res.status(e.status).json({ error: e.message });
        console.error("[roteiros] " + uid + ": " + (e && e.message));
        if (b.acao) registrarFalha(uid, b.acao === "ajustar" ? "ajustar roteiro" : "refazer roteiro", e && e.message);
        return res.status(500).json({ error: /credit balance/i.test((e && e.message) || "") ? "O MCP Studio está sem créditos de IA agora. Avise a equipe." : "Não consegui gerar os roteiros agora. Tente de novo em alguns minutos." });
    }
};
