// =====================================================================
//  CEREBRO DA LOJA: mapa dos campeoes e caderno (so funcoes, sem IA aqui)
//
//  Mapa dos campeoes: os 5 melhores videos de cada criterio, contando so o
//  que ja "amadureceu" (post com 3 dias ou mais; anuncio com R$ 30 investidos
//  ou 1.000 exibicoes), porque antes disso qualquer numero e sorte.
//    - organico: mais vistos, mais engajamento (curtidas + comentarios +
//      salvamentos + compartilhamentos), mais tempo assistido, melhor gancho
//      e mais compartilhados
//    - anuncios: mais compras e melhor gancho; na loja medida por conversas
//      e visitas ao perfil: mais conversas, mais visitas ao perfil e melhor gancho
//  Cada campeao em video ganha uma ficha (fala lida e video assistido, uma vez
//  so, em api/_meta-leitura.js). O Agente do Caderno (api/_time-agentes.js)
//  compara os campeoes com o publico e guarda o que a loja ja sabe em
//  contas_meta.caderno: comprovado, a testar, nao funciona e publico.
//  Cada loja tem o proprio caderno: nada passa de uma loja para outra.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const crypto = require("crypto");

const DIA_MS = 24 * 3600 * 1000;
const TOP = 5;
const POST_MADURO_MS = 3 * DIA_MS;
const ANUNCIO_MIN_GASTO = 30, ANUNCIO_MIN_IMPRESSOES = 1000;
const NOVA_TENTATIVA_MS = 3 * DIA_MS;   // video que deu erro na ficha: tenta de novo depois

function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function temValor(x) { return x !== null && x !== undefined && x !== "" && isFinite(Number(x)); }
// o mesmo numero que a dona ve nos icones do post
function interacoes(p) { return num(p.curtidas) + num(p.comentarios) + num(p.salvamentos) + num(p.compartilhamentos); }
function ehVideoPost(p) { return p && (p.tipo === "Reels" || p.tipo === "Vídeo"); }

const CRITERIOS_ORG = [
    { id: "vistos", nome: "mais vistos", rot: "mais visto", un: "visualizações", valor: function (p) { return num(p.visualizacoes); } },
    { id: "engajamento", nome: "mais engajamento", rot: "mais engajamento", un: "interações", valor: interacoes },
    { id: "tempo", nome: "mais tempo assistido", rot: "mais tempo assistido", un: "s assistidos", valor: function (p) { return temValor(p.tempo_medio_s) ? num(p.tempo_medio_s) : null; } },
    { id: "gancho", nome: "melhor gancho", rot: "melhor gancho", un: "% passaram dos 3 primeiros segundos", valor: function (p) { return temValor(p.retencao_3s) ? num(p.retencao_3s) : null; } },
    { id: "compartilhados", nome: "mais compartilhados", rot: "mais compartilhado", un: "compartilhamentos", valor: function (p) { return num(p.compartilhamentos); } }
];
// objetivo da loja nos anuncios (lojas.objetivo_anuncios): "conversas_visitas" ou o automatico (compras, ou conversas sem pixel)
function criteriosAds(objetivo, tipo) {
    const gancho = { id: "gancho", nome: "anúncio com melhor gancho", rot: "melhor gancho nos anúncios", un: "% pararam para ver", valor: function (a) { return temValor(a.taxa_gancho) ? num(a.taxa_gancho) : null; } };
    if (objetivo === "conversas_visitas") return [
        { id: "conversas", nome: "anúncio com mais conversas", rot: "mais conversas", un: "conversas", valor: function (a) { return num(a.conversas); } },
        { id: "visitas", nome: "anúncio com mais visitas ao perfil", rot: "mais visitas ao perfil", un: "visitas ao perfil", valor: function (a) { return num(a.visitas); } },
        gancho
    ];
    const nome = tipo === "vendas" ? "compras" : tipo === "conversas" ? "conversas" : "resultados";
    return [{ id: "resultado", nome: "anúncio com mais " + nome, rot: "mais " + nome, un: nome, valor: function (a) { return num(a.resultados); } }, gancho];
}

function postMaduro(p, agora) { return p && p.alcance > 0 && !p.pouco_alcance && p.data && agora - new Date(p.data).getTime() >= POST_MADURO_MS; }
function anuncioMaduro(a) { return a && (num(a.gasto) >= ANUNCIO_MIN_GASTO || num(a.impressoes) >= ANUNCIO_MIN_IMPRESSOES); }
function ranking(itens, c) {
    return itens.map(function (x) { return { x: x, v: c.valor(x) }; }).filter(function (r) { return r.v !== null && r.v > 0; })
        .sort(function (a, b) { return b.v - a.v; }).slice(0, TOP);
}

// met: contas_meta.metricas com a Meta ja aplicada (tempo assistido, gancho, visitas)
function mapaCampeoes(met, objetivo, agora) {
    agora = agora || Date.now();
    const posts = ((met && met.organico && met.organico.posts) || []).filter(function (p) { return postMaduro(p, agora); });
    const a90 = met && met.anuncios && met.anuncios.p90;
    const ads = ((a90 && a90.anuncios) || []).filter(anuncioMaduro);
    const mapa = { org: [], ads: [], porPost: {}, porAnuncio: {}, objetivo: objetivo || "auto", tipo: a90 ? a90.tipo_resultado : null };
    CRITERIOS_ORG.forEach(function (c) {
        const top = ranking(posts, c);
        if (!top.length) return;
        mapa.org.push({ id: c.id, nome: c.nome, un: c.un, top: top.map(function (r) { return { id: r.x.id, valor: r.v }; }) });
        top.forEach(function (r, i) { (mapa.porPost[r.x.id] = mapa.porPost[r.x.id] || []).push({ c: c.id, nome: c.rot, pos: i + 1, valor: r.v, un: c.un }); });
    });
    criteriosAds(objetivo, mapa.tipo).forEach(function (c) {
        const top = ranking(ads, c);
        if (!top.length) return;
        mapa.ads.push({ id: c.id, nome: c.nome, un: c.un, top: top.map(function (r) { return { id: r.x.id, valor: r.v }; }) });
        top.forEach(function (r, i) { (mapa.porAnuncio[r.x.id] = mapa.porAnuncio[r.x.id] || []).push({ c: c.id, nome: c.rot, pos: i + 1, valor: r.v, un: c.un }); });
    });
    return mapa;
}
// "1º mais visto, 3º melhor gancho"
function rotuloCampeao(lista) {
    return (lista || []).slice().sort(function (a, b) { return a.pos - b.pos; }).map(function (x) { return x.pos + "º " + x.nome; }).join(", ");
}
// os campeoes primeiro (quem ganha em mais criterios e em posicao melhor)
function forcaCampeao(lista) { return (lista || []).reduce(function (s, x) { return s + (TOP + 1 - x.pos); }, 0); }

// videos campeoes que ainda nao tem ficha (fala lida e/ou video assistido)
// cache = contas_meta.meta; devolve [{ tipo: "post"|"anuncio", id, fala, olhos, forca }]
function velho(iso, ms) { return !iso || Date.now() - new Date(iso).getTime() >= ms; }
function alvosDeFicha(mapa, met, cache) {
    cache = cache || {};
    const cp = cache.posts || {}, ca = cache.anuncios || {}, out = [];
    const posts = {};
    ((met && met.organico && met.organico.posts) || []).forEach(function (p) { posts[p.id] = p; });
    Object.keys(mapa.porPost).forEach(function (id) {
        const p = posts[id];
        if (!ehVideoPost(p) || !/^\d{8,}$/.test(id)) return;
        const c = cp[id] || {};
        const fala = !c.transcricao && velho(c.fala_erro_em, NOVA_TENTATIVA_MS);
        const olhos = !c.visual && velho(c.olhos_erro_em, NOVA_TENTATIVA_MS);
        if (fala || olhos) out.push({ tipo: "post", id: id, fala: fala, olhos: olhos, forca: forcaCampeao(mapa.porPost[id]) });
    });
    Object.keys(mapa.porAnuncio).forEach(function (id) {
        const c = ca[id] || {};
        if (!/^\d{8,}$/.test(id) || !(c.ig_media_id || c.video_id)) return;
        // anuncio feito de um post: a ficha e a do post
        const doPost = c.ig_media_id && cp[c.ig_media_id];
        const temFala = c.transcricao || (doPost && doPost.transcricao), temOlhos = c.visual || (doPost && doPost.visual);
        const fala = !temFala && velho(c.fala_erro_em, NOVA_TENTATIVA_MS);
        const olhos = !temOlhos && velho(c.olhos_erro_em, NOVA_TENTATIVA_MS);
        if (fala || olhos) out.push({ tipo: "anuncio", id: id, fala: fala, olhos: olhos, forca: forcaCampeao(mapa.porAnuncio[id]) });
    });
    return out.sort(function (a, b) { return b.forca - a.forca; });
}

// os campeoes que ja tem ficha (ou nao sao video): o que o caderno ja pode estudar
function campeoesProntos(mapa, met, cache) {
    const falta = {};
    alvosDeFicha(mapa, met, cache).forEach(function (x) { falta[x.tipo + ":" + x.id] = 1; });
    return Object.keys(mapa.porPost).map(function (id) { return "post:" + id; }).concat(Object.keys(mapa.porAnuncio).map(function (id) { return "anuncio:" + id; }))
        .filter(function (k) { return !falta[k]; }).sort();
}
function assinatura(lista) { return crypto.createHash("sha1").update(lista.join("|")).digest("hex").slice(0, 16); }

// ---------- caderno ----------
function objeto(props) { return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false }; }
const PT = " Em português do Brasil com acentuação completa.";
const ITEM = objeto({
    texto: { type: "string", description: "Regra prática desta loja numa frase, com o número que prova (exemplo: provador respondendo se veste 46 foi o mais salvo e o anúncio com mais compras)." + PT },
    provas: { type: "string", description: "Os vídeos que provam, pela data e uma descrição curta, nunca por código (exemplo: Reels de 18/09 do vestido tricô e o anúncio “Vestido Tricô Gola”)." + PT },
    fontes: { type: "array", items: { type: "string", enum: ["orgânico", "anúncios", "público"] }, description: "De onde vem a prova." }
});
const ESQ_CADERNO = objeto({
    resumo: { type: "string", description: "2 frases para a dona: o que o time já sabe da loja dela e o que isso muda nos próximos vídeos." + PT },
    comprovado: { type: "array", items: ITEM, description: "O que se repete em 2 ou mais campeões (ou num campeão e num pedido real das clientes). No máximo 8, do mais forte para o mais fraco." },
    a_testar: { type: "array", items: ITEM, description: "O que apareceu em 1 campeão só: pista que vale testar. No máximo 6." },
    nao_funciona: { type: "array", items: ITEM, description: "O que aparece nos vídeos fracos e não aparece nos campeões. No máximo 5. Lista vazia se os dados não mostram." },
    publico: { type: "array", items: { type: "string" }, description: "De 2 a 5 frases sobre o público que os campeões confirmam (a dúvida que o campeão respondeu, a situação que prendeu, a faixa de idade que mais comprou)." + PT },
    mudou: { type: "boolean", description: "true só se entrou, saiu ou mudou de força algum item em relação ao CADERNO ATUAL; false se ficou praticamente igual." }
});
function textoCaderno(c) {
    if (!c || !((c.comprovado || []).length || (c.a_testar || []).length || (c.nao_funciona || []).length)) return "";
    function lin(x) { return "- " + x.texto + (x.provas ? " [" + x.provas + "]" : ""); }
    return "\n\nCADERNO DA LOJA (o que o time já sabe, tirado dos vídeos campeões desta loja cruzados com o público; é a base mais segura para ideias e roteiros)" +
        ((c.comprovado || []).length ? "\nCOMPROVADO (repita com peça, situação ou ângulo novos):\n" + c.comprovado.map(lin).join("\n") : "") +
        ((c.a_testar || []).length ? "\nA TESTAR (apareceu em 1 campeão; vale testar de novo):\n" + c.a_testar.map(lin).join("\n") : "") +
        ((c.nao_funciona || []).length ? "\nNÃO FUNCIONA NESTA LOJA (evite):\n" + c.nao_funciona.map(lin).join("\n") : "") +
        ((c.publico || []).length ? "\nO QUE OS CAMPEÕES MOSTRAM DO PÚBLICO:\n" + c.publico.map(function (t) { return "- " + t; }).join("\n") : "");
}

module.exports = { TOP, CRITERIOS_ORG, criteriosAds, interacoes, ehVideoPost, postMaduro, anuncioMaduro, mapaCampeoes, rotuloCampeao, forcaCampeao, alvosDeFicha, campeoesProntos, assinatura, ESQ_CADERNO, textoCaderno };
