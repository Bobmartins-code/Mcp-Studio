// =====================================================================
//  CEREBRO CENTRAL (modo observacao: so o admin ve; nao entra nas ideias)
//  Le o cerebro de cada loja (o que esta comprovado, o que nao funciona e
//  como sao os videos campeoes) e guarda so LICOES de formato: o jeito de
//  fazer, sem nada que identifique a loja.
//  Travas:
//    - a IA recebe as lojas como L1, L2... (sem nome, @ ou preco)
//    - uma licao so vale com 3 lojas ou mais (a IA diz quais; o sistema confere)
//    - filtro final: licao com @, preco, nome de loja ou de perfil e descartada
//    - o que fica guardado e so a licao e quantas lojas a sustentam (nunca quais)
//  Roda 1 vez por semana (api/atualizar.js) ou pelo Painel Admin.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const { banco, ADMIN_ID } = require("./_seguranca.js");

const DIA_MS = 24 * 3600 * 1000, SEMANA_MS = 7 * DIA_MS;
const MIN_LOJAS = 3;

function objeto(props) { return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false }; }
const ESQ_CENTRAL = objeto({
    licoes: {
        type: "array",
        items: objeto({
            tipo: { type: "string", enum: ["funciona", "evitar"] },
            onde: { type: "string", enum: ["reels e posts", "anúncios", "stories", "geral"] },
            nicho: { type: "string", description: "Segmento amplo em que a lição vale (ex.: moda e acessórios, fitness) ou 'geral' quando vale para qualquer loja." },
            titulo: { type: "string", description: "A lição em uma frase curta." },
            como_fazer: { type: "string", description: "O jeito de fazer com detalhe suficiente para gravar: estrutura, ordem das cenas, tempo de cada parte, tipo de gancho, quem aparece, cenário, como a fala é feita, chamada para ação." },
            quando_funciona: { type: "string", description: "Em que situação a lição costuma funcionar melhor e quando não usar." },
            lojas: { type: "array", items: { type: "string" }, description: "Códigos (L1, L2...) das lojas cujo cérebro sustenta a lição. No mínimo 3." },
            forca: { type: "string", enum: ["forte", "média"] }
        })
    },
    observacao: { type: "string", description: "Uma frase sobre o que ainda falta para tirar lições melhores (ex.: poucas lojas de um nicho)." }
});

const SISTEMA_CENTRAL = "Você é o CÉREBRO CENTRAL do MCP Studio, um sistema que ajuda lojas a criar conteúdo para o Instagram. " +
    "Você recebe o cérebro de várias lojas, cada uma identificada só por um código (L1, L2...). Sua tarefa é encontrar LIÇÕES DE FORMATO que se repetem em várias lojas: o jeito de fazer um vídeo, um anúncio ou um story que funciona (ou que não funciona).\n" +
    "REGRAS QUE NÃO PODEM SER QUEBRADAS:\n" +
    "1. Uma lição só existe se aparecer no cérebro de pelo menos 3 lojas diferentes. Liste os códigos em 'lojas'. Se só 1 ou 2 lojas sustentam, descarte.\n" +
    "2. A lição descreve só o JEITO DE FAZER. Nunca escreva: nome de loja, de pessoa, de marca, de artista ou de evento com nome; @; nome de produto específico; preço; número de vendas, de visualizações ou de qualquer resultado; frase copiada de legenda ou de fala; os códigos das lojas no texto. Categorias amplas podem (ex.: 'peça para uma ocasião', 'calça', 'acessório').\n" +
    "3. Números só para a estrutura (ex.: 'nos 2 primeiros segundos', 'em 3 cenas').\n" +
    "4. Nada de conselho óbvio ou vago ('use um bom gancho', 'poste com frequência', 'mostre o produto'): a lição precisa ensinar algo que dá para gravar amanhã, com detalhe.\n" +
    "5. Prefira poucas lições muito boas a muitas fracas. Se não houver lição que cumpra as regras, devolva a lista vazia.\n" +
    "6. Algumas lojas trazem VENDAS (o padrão das vendas reais delas, sem números). Use para lições que ligam formato e momento à venda (ex.: lojas que vivem de cliente que volta e vendem mais na primeira quinzena), sempre com 3 lojas ou mais.\n" +
    "Escreva em português do Brasil, com acentuação completa, frases simples.";

function corta(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; }
function semAcento(t) { return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }

// tira da entrada o que identifica a loja (a IA nem chega a ver)
function limpar(t, proibidos) {
    // primeiro o @ e o preco (senao o nome trocado deixaria um "@" sobrando)
    let s = String(t || "").replace(/@[\w.]+/g, "[perfil]").replace(/R\$\s?[\d.,]+/gi, "[preço]");
    proibidos.forEach(function (p) { if (p && p.length >= 3) s = s.split(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join("[loja]"); });
    return s;
}
function blocoLoja(cod, l, proibidos) {
    const c = l.caderno || {}, linhas = [];
    linhas.push(cod + " · nicho informado: " + (l.nicho || "não informado (deduza pelo conteúdo)"));
    if (c.resumo) linhas.push("RESUMO: " + corta(limpar(c.resumo, proibidos), 500));
    const lista = function (nome, itens) {
        if (!(itens || []).length) return;
        linhas.push(nome + ":");
        itens.slice(0, 10).forEach(function (i) { linhas.push("- " + corta(limpar(i.texto, proibidos), 300) + (i.provas ? " (provas: " + corta(limpar(i.provas, proibidos), 250) + ")" : "")); });
    };
    lista("COMPROVADO", c.comprovado);
    lista("NÃO FUNCIONA", c.nao_funciona);
    // como sao os videos que ja tem ficha (mecanica e estrutura; sem texto na tela, que pode ter preco ou nome)
    const fichas = [];
    const meta = l.meta || {};
    [meta.posts || {}, meta.anuncios || {}].forEach(function (grupo, gi) {
        Object.keys(grupo).forEach(function (id) {
            const v = grupo[id] && grupo[id].visual;
            if (v && v.mecanica) fichas.push((gi ? "anúncio" : "post") + ": " + [v.mecanica, "primeiro segundo: " + v.primeiro_segundo, "cenário: " + v.cenario, "quem aparece: " + v.quem_aparece, "celular: " + v.celular, "sequência: " + (v.sequencia || []).join(" > "), "ritmo " + v.ritmo].join("; "));
        });
    });
    if (fichas.length) {
        linhas.push("COMO SÃO OS VÍDEOS CAMPEÕES:");
        fichas.slice(0, 14).forEach(function (f) { linhas.push("- " + corta(limpar(f, proibidos), 420)); });
    }
    // vendas reais (CRM da loja): so categorias, sem nenhum numero
    const v = l.vendas;
    if (v && v.perfil) {
        const PERFIL = { depende_de_cliente_nova: "depende de cliente nova", vive_de_cliente_que_volta: "vive de cliente que volta", equilibrado: "equilibrado entre cliente nova e cliente que volta" };
        const formatos = (v.formatos_antes_das_vendas || []).filter(function (x) { return x.confianca !== "baixa"; }).map(function (x) { return corta(limpar(x.formato, proibidos).replace(/\d+([.,]\d+)?/g, ""), 120); });
        linhas.push("VENDAS (CRM da loja, só o padrão): " + (PERFIL[v.perfil] || v.perfil) + " | vende mais na " + (v.quinzena_forte === "primeira" ? "primeira quinzena do mês" : v.quinzena_forte === "segunda" ? "segunda quinzena do mês" : "mesma medida nas duas quinzenas") +
            ((v.dias_fortes || []).length ? " | dias fortes: " + v.dias_fortes.join(", ") : "") + " | clientes: " + (v.alcance_geografico === "local" ? "da própria cidade" : v.alcance_geografico === "regional" ? "do próprio estado" : "de vários estados") +
            (formatos.length ? " | formatos que aparecem antes de dias de venda acima do normal: " + formatos.join("; ") : ""));
    }
    return linhas.join("\n");
}

// a licao passa no filtro final?
function licaoLimpa(li, proibidos) {
    const texto = [li.titulo, li.como_fazer, li.quando_funciona, li.nicho].join(" ");
    if (/@\w/.test(texto) || /R\$/i.test(texto) || /\bL\d+\b/.test(texto)) return false;
    const t = semAcento(texto);
    return !proibidos.some(function (p) { return p && p.length >= 4 && t.indexOf(semAcento(p)) > -1; });
}

async function lojasParaOCentral() {
    const [lojas, contas] = await Promise.all([
        banco("lojas?select=user_id,nome,nicho"),
        banco("contas_meta?caderno=not.is.null&select=user_id,ig_username,caderno,meta,vendas_leitura:vendas->leitura")
    ]);
    const porId = {};
    (lojas || []).forEach(function (l) { porId[l.user_id] = l; });
    return (contas || []).filter(function (c) { return porId[c.user_id] && c.caderno && ((c.caderno.comprovado || []).length || (c.caderno.nao_funciona || []).length); })
        .map(function (c) { return { nome: porId[c.user_id].nome, nicho: porId[c.user_id].nicho, ig: c.ig_username, caderno: c.caderno, meta: c.meta, vendas: c.vendas_leitura || null }; });
}

// monta, filtra e grava; devolve o resumo
async function gerarCentral(prazo) {
    const { perguntar } = require("./_time-agentes.js");
    const lojas = await lojasParaOCentral();
    if (lojas.length < MIN_LOJAS) return { ok: false, motivo: "Precisa de pelo menos " + MIN_LOJAS + " lojas com cérebro." };
    // tudo o que identifica alguma loja: nomes (inteiros e palavras marcantes) e perfis
    const proibidos = [];
    lojas.forEach(function (l) {
        [l.nome, l.ig].forEach(function (x) { if (x) proibidos.push(String(x).trim()); });
        String(l.nome || "").split(/\s+/).forEach(function (w) { if (w.length >= 4 && !/^(loja|store|modas?|boutique|acessorios|acessórios|fitness|studio)$/i.test(w)) proibidos.push(w); });
    });
    // a ordem das lojas muda a cada vez: o codigo nao fica preso a uma loja
    const ordem = lojas.map(function (l) { return { l: l, r: Math.random() }; }).sort(function (a, b) { return a.r - b.r; }).map(function (x) { return x.l; });
    const pedido = "CÉREBROS DAS LOJAS (" + ordem.length + " lojas):\n\n" + ordem.map(function (l, i) { return blocoLoja("L" + (i + 1), l, proibidos); }).join("\n\n") +
        "\n\nTire as lições que cumprem as regras. Para cada uma, diga o tipo (funciona ou evitar), onde vale, o nicho amplo, o título, como fazer com detalhe, quando funciona, os códigos das lojas que a sustentam e a força.";
    let r;
    try { r = await perguntar(ADMIN_ID, { nome: "Cérebro central", sistema: SISTEMA_CENTRAL, pedido: pedido, esquema: ESQ_CENTRAL, max: 8000, effort: "medium", prazo: prazo }); }
    catch (e) {
        // registra a falha: a proxima tentativa automatica so acontece em 1 dia (nao gasta IA a cada rodada)
        await banco("cerebro_central", { method: "POST", headers: { Prefer: "return=minimal" }, body: { licoes: [], resumo: { erro: String(e.message || e).slice(0, 300), lojas_lidas: ordem.length } } }).catch(function () {});
        throw e;
    }
    const validos = {};
    ordem.forEach(function (l, i) { validos["L" + (i + 1)] = 1; });
    let semLojas = 0, sujas = 0;
    const licoes = [];
    (r.licoes || []).forEach(function (li) {
        const n = Object.keys((li.lojas || []).reduce(function (o, c) { const k = String(c).trim().toUpperCase(); if (validos[k]) o[k] = 1; return o; }, {})).length;
        if (n < MIN_LOJAS) { semLojas++; return; }
        if (!licaoLimpa(li, proibidos)) { sujas++; return; }
        // guarda so a licao e quantas lojas a sustentam (nunca quais)
        licoes.push({ tipo: li.tipo, onde: li.onde, nicho: li.nicho, titulo: li.titulo, como_fazer: li.como_fazer, quando_funciona: li.quando_funciona, forca: li.forca, n_lojas: n });
    });
    const resumo = { lojas_lidas: ordem.length, sugeridas: (r.licoes || []).length, descartadas_poucas_lojas: semLojas, descartadas_filtro: sujas, observacao: r.observacao || "" };
    await banco("cerebro_central", { method: "POST", headers: { Prefer: "return=minimal" }, body: { licoes: licoes, resumo: resumo } });
    return Object.assign({ ok: true, licoes: licoes.length }, resumo);
}

// roda 1 vez por semana; se a ultima tentativa falhou, tenta de novo em 1 dia
async function centralVencido(agora) {
    const r = await banco("cerebro_central?select=gerado_em,resumo&order=gerado_em.desc&limit=1");
    const x = r && r[0], ult = x && x.gerado_em ? new Date(x.gerado_em).getTime() : 0;
    return (agora || Date.now()) - ult >= (x && x.resumo && x.resumo.erro ? DIA_MS : SEMANA_MS);
}

module.exports = { gerarCentral, centralVencido, _interno: { limpar, licaoLimpa, blocoLoja, ESQ_CENTRAL } };
