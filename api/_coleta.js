// =====================================================================
//  COLETA DOS NUMEROS DE UMA LOJA (via Reportei Connect)
//  - organico: cada post dos ultimos 90 dias (capa, legenda, alcance,
//    visualizacoes, curtidas, comentarios, salvos, compartilhamentos)
//  - anuncios: cada anuncio em 7, 30 e 90 dias (investido, compras,
//    conversas, custo por resultado, alcance, cliques, gancho, retencao)
//  Grava em contas_meta.metricas e uma foto do dia em metricas_diarias.
//  Usado pelo botao "Atualizar dados agora" e pela atualizacao diaria.
// =====================================================================

const crypto = require("crypto");
const { banco } = require("./_seguranca.js");
const { connect, clienteDoUsuario, integracoesDoCliente } = require("./_reportei.js");

// ---------- leitura tolerante das celulas (numero, texto, capa, link) ----------
function numero(v) {
    if (v == null) return 0;
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (Array.isArray(v)) return numero(v[0]);
    if (typeof v === "object") return numero(v.value != null ? v.value : v.values != null ? v.values : v.total != null ? v.total : v.count != null ? v.count : v.raw);
    // numero cru da API ("1.031746", "63"): le direto, sem regra de milhar
    if (/^\s*-?\d+(\.\d+)?\s*$/.test(String(v))) return parseFloat(v);
    const m = String(v).match(/-?[\d.,]+/);
    if (!m) return 0;
    let t = m[0];
    const ultPonto = t.lastIndexOf("."), ultVirg = t.lastIndexOf(",");
    if (ultPonto > -1 && ultVirg > -1) {
        // o separador que vem por ultimo e o decimal
        t = ultVirg > ultPonto ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
    } else if ((t.match(/[.,]/g) || []).length > 1) {
        t = t.replace(/[.,]/g, "");
    } else if (/^-?[1-9]\d{0,2}[.,]\d{3}$/.test(t)) {
        // texto formatado com um separador seguido de 3 digitos ("26.180", "1,066") e milhar
        t = t.replace(/[.,]/, "");
    } else {
        t = t.replace(",", ".");
    }
    const n = parseFloat(t);
    return isFinite(n) ? n : 0;
}
function arred(n, casas) { const f = Math.pow(10, casas || 0); return Math.round(n * f) / f; }

// uma celula de dimensao pode vir como texto, objeto ou lista de partes
function partes(cell) { return Array.isArray(cell) ? cell : [cell]; }
function textoDe(cell) {
    for (const p of partes(cell)) {
        if (typeof p === "string" && !/^https?:\/\//.test(p)) return p;
        if (p && typeof p === "object") {
            const t = p.caption || p.text || p.message || p.name || p.title || p.label || p.ad_name || p.description;
            if (t) return String(t);
        }
    }
    return "";
}
function urlEm(obj, padrao, evitar) {
    if (!obj || typeof obj !== "object") return "";
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string" && /^https?:\/\//.test(v) && padrao.test(k) && !(evitar && evitar.test(k))) return v;
    }
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === "object" && !Array.isArray(v)) { const u = urlEm(v, padrao, evitar); if (u) return u; }
    }
    return "";
}
function imagemDe(cell) {
    for (const p of partes(cell)) {
        if (typeof p === "string" && /^https?:\/\/.*\.(jpe?g|png|webp|gif)(\?|$)/i.test(p)) return p;
        const u = urlEm(p, /thumb|image|picture|preview|cover|src|media_url|photo/i);
        if (u) return u;
    }
    return "";
}
function linkDe(cell) {
    for (const p of partes(cell)) {
        if (typeof p === "string" && /^https?:\/\/(www\.)?instagram\.com/.test(p)) return p;
        const u = urlEm(p, /permalink|link|url|href/i, /thumb|image|picture|preview|cover|media_url|photo/i);
        if (u) return u;
    }
    return "";
}
function idDe(cell) {
    for (const p of partes(cell)) {
        if (p && typeof p === "object") { const id = p.id || p.media_id || p.ad_id || p.uuid; if (id) return String(id); }
    }
    return "";
}
function dataDe(v) {
    if (!v) return null;
    if (typeof v === "object") return dataDe(v.value || v.date || v.raw);
    const s = String(v).trim();
    const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    const d = br ? new Date(br[3] + "-" + br[2] + "-" + br[1] + "T12:00:00-03:00") : new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function tipoDe(v) {
    const t = String(textoDe(v) || v || "").toLowerCase();
    if (t.indexOf("reel") > -1) return "Reels";
    if (t.indexOf("carousel") > -1 || t.indexOf("album") > -1 || t.indexOf("carrossel") > -1) return "Carrossel";
    if (t.indexOf("video") > -1 || t.indexOf("vídeo") > -1) return "Vídeo";
    if (t.indexOf("image") > -1 || t.indexOf("photo") > -1 || t.indexOf("foto") > -1 || t.indexOf("imagem") > -1) return "Foto";
    return "Post";
}
function mediana(v) { const a = v.filter(function (x) { return isFinite(x); }).sort(function (x, y) { return x - y; }); if (!a.length) return 0; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function diaSP(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d); }

// Linhas de uma tabela (datatable_v1): cada linha vira { dim, m: { metrica: valor } }.
// Aceita linha em lista ([dimensao, m1, m2...]) ou em objeto ({ metrica: valor }).
function linhasDaTabela(resp, metricas, campoDim) {
    const vals = (resp && (resp.values || resp.data || resp.rows)) || [];
    if (!Array.isArray(vals)) return [];
    const out = [];
    vals.forEach(function (row) {
        let dim, m = {};
        if (Array.isArray(row)) {
            const offset = Math.max(0, row.length - metricas.length);
            dim = offset === 1 ? row[0] : offset > 1 ? row.slice(0, offset) : null;
            metricas.forEach(function (k, i) { m[k] = row[offset + i]; });
        } else if (row && typeof row === "object") {
            dim = row[campoDim] || row.dimension || row.name || row;
            m = row;
        } else return;
        if (/^total$/i.test(textoDe(dim).trim())) return;
        out.push({ dim: dim, m: m });
    });
    return out;
}

// Acha o bloco do pedido na resposta. A documentacao mostra { <id>: {...} },
// mas aceita tambem a resposta embrulhada (data/metrics/result) ou em lista.
function blocoDaResposta(d, id) {
    if (!d || typeof d !== "object") return null;
    if (d[id]) return d[id];
    for (const k of ["data", "metrics", "result", "results"]) {
        const x = d[k];
        if (x && typeof x === "object" && !Array.isArray(x) && x[id]) return x[id];
        if (Array.isArray(x)) { const e = x.find(function (i) { return i && i.id === id; }); if (e) return e.data || e.result || e; }
    }
    if (Array.isArray(d)) { const e = d.find(function (i) { return i && i.id === id; }); if (e) return e.data || e.result || e; if (d.length === 1) return d[0]; }
    const ks = Object.keys(d);
    if (ks.length === 1 && d[ks[0]] && typeof d[ks[0]] === "object") return d[ks[0]];
    return null;
}
// pedaco da resposta crua, para ver o formato quando nada foi lido
function cru(d) { try { return JSON.stringify(d).slice(0, 800); } catch (e) { return String(d).slice(0, 200); } }

// Pede uma tabela tentando listas de metricas da mais completa para a mais simples
// (o Reportei recusa o pedido inteiro se uma metrica nao existir para a conta).
async function pedirTabela(cli, integ, inicio, fim, base, listas, avisos) {
    let ultimoErro = null;
    for (const metricas of listas) {
        // o Reportei exige um UUID como id de cada pedido; a resposta vem nesse mesmo id
        const w = Object.assign({}, base, { id: crypto.randomUUID(), metrics: metricas });
        try {
            const d = await connect("/metrics/get-data", { method: "POST", customerToken: cli.api_token, timeout: 100000, body: { customer_integration: integ.uuid, start: inicio, end: fim, client_timezone: "America/Sao_Paulo", metrics: [w] } });
            const campo = (base.dimensions && base.dimensions[0] && (base.dimensions[0].field || base.dimensions[0])) || "";
            const b = blocoDaResposta(d, w.id);
            // o Reportei responde 200 com "warning" e sem linhas quando alguma metrica saiu da rede: tenta a proxima lista
            if (b && b.warning && !b.values) { ultimoErro = new Error(b.warning); continue; }
            return { linhas: linhasDaTabela(b, metricas, campo), bruto: b, cru: cru(d), metricas: metricas };
        } catch (e) { ultimoErro = e; }
    }
    avisos.push(base.reference_key + ": " + ((ultimoErro && ultimoErro.message) || "sem dados"));
    return { linhas: [], bruto: null };
}
async function pedirNumero(cli, integ, inicio, fim, base) {
    const w = Object.assign({}, base, { id: crypto.randomUUID() });
    try {
        const d = await connect("/metrics/get-data", { method: "POST", customerToken: cli.api_token, timeout: 60000, body: { customer_integration: integ.uuid, start: inicio, end: fim, client_timezone: "America/Sao_Paulo", metrics: [w] } });
        const b = blocoDaResposta(d, w.id);
        return numero(b && (b.values !== undefined ? b.values : b.value));
    } catch (e) { return null; }
}
function amostra(r) { try { const v = r.bruto && (r.bruto.values || r.bruto.data || r.bruto.rows); if (Array.isArray(v) && v.length) return JSON.stringify({ metricas: r.metricas, linhas: v.slice(0, 2) }).slice(0, 1200); return "sem linhas; resposta: " + (r.cru || "vazia"); } catch (e) { return "erro na amostra"; } }

// ---------- ORGANICO ----------
// o Instagram parou de entregar impressions, plays e video_views em 2025 (virou "views"):
// tenta primeiro as metricas novas e vai simplificando se o Reportei recusar
const IG_MEDIA = [
    ["type", "reach", "views", "likes", "comments", "saved", "shares", "total_interactions", "follows", "profile_visits", "created_at"],
    ["type", "reach", "views", "likes", "comments", "saved", "shares", "created_at"],
    ["type", "reach", "likes", "comments", "saved", "shares", "total_interactions", "created_at"],
    ["type", "reach", "likes", "comments", "saved", "shares", "created_at"],
    ["reach", "likes", "comments", "created_at"]
];
const IG_REELS = [
    ["reach", "views", "likes", "comments", "saved", "shares", "total_interactions", "created_at"],
    ["reach", "views", "likes", "comments", "saved", "shares", "created_at"],
    ["reach", "likes", "comments", "saved", "shares", "total_interactions", "created_at"],
    ["reach", "likes", "comments", "saved", "shares", "created_at"],
    ["reach", "likes", "comments", "created_at"]
];

async function coletarOrganico(cli, ig, inicio, fim, avisos) {
    const [media, reels, seguidores] = await Promise.all([
        pedirTabela(cli, ig, inicio, fim, { id: "media", reference_key: "ig:media_datatable", component: "datatable_v1", dimensions: ["media"], sort: ["-reach"] }, IG_MEDIA, avisos),
        pedirTabela(cli, ig, inicio, fim, { id: "reels", reference_key: "ig:reels_datatable", component: "datatable_v1", dimensions: ["reels"], sort: ["-reach"] }, IG_REELS, avisos),
        pedirNumero(cli, ig, inicio, fim, { id: "seg", reference_key: "ig:followers_count", component: "number_v1", metrics: ["followers"] })
    ]);
    const porChave = {}, posts = [];
    function chave(dim, data) { return idDe(dim) || linkDe(dim) || (textoDe(dim).slice(0, 80) + "|" + String(data || "").slice(0, 10)); }
    media.linhas.forEach(function (l) {
        const m = l.m, data = dataDe(m.created_at);
        const p = {
            id: "", tipo: tipoDe(m.type), data: data, legenda: textoDe(l.dim).slice(0, 400), miniatura: imagemDe(l.dim), link: linkDe(l.dim),
            alcance: numero(m.reach), impressoes: numero(m.impressions), visualizacoes: numero(m.views) || numero(m.video_views), curtidas: numero(m.likes), comentarios: numero(m.comments),
            salvamentos: numero(m.saved), compartilhamentos: numero(m.shares), interacoes: numero(m.total_interactions), seguiram: numero(m.follows), visitas_perfil: numero(m.profile_visits)
        };
        p.id = chave(l.dim, data);
        porChave[p.id] = p; posts.push(p);
    });
    reels.linhas.forEach(function (l) {
        const m = l.m, data = dataDe(m.created_at), k = chave(l.dim, data);
        let p = porChave[k];
        if (!p) {
            p = { id: k, tipo: "Reels", data: data, legenda: textoDe(l.dim).slice(0, 400), miniatura: imagemDe(l.dim), link: linkDe(l.dim), alcance: numero(m.reach), impressoes: 0, visualizacoes: 0, curtidas: numero(m.likes), comentarios: numero(m.comments), salvamentos: numero(m.saved), compartilhamentos: numero(m.shares), interacoes: numero(m.total_interactions), seguiram: 0, visitas_perfil: 0 };
            porChave[k] = p; posts.push(p);
        }
        p.tipo = "Reels";
        p.visualizacoes = numero(m.views) || numero(m.plays) || p.visualizacoes;
        if (!p.miniatura) p.miniatura = imagemDe(l.dim);
        if (!p.link) p.link = linkDe(l.dim);
    });
    posts.forEach(function (p) {
        if (!p.visualizacoes) p.visualizacoes = p.impressoes || p.alcance;
        if (!p.interacoes) p.interacoes = p.curtidas + p.comentarios + p.salvamentos + p.compartilhamentos;
        // resultado no organico: engajamento com compartilhamento valendo dobrado, relativo ao alcance
        p.taxa = p.alcance > 0 ? (p.curtidas + p.comentarios + p.salvamentos + p.compartilhamentos * 2) / p.alcance : 0;
    });
    const med = mediana(posts.filter(function (x) { return x.alcance > 0; }).map(function (x) { return x.taxa; }));
    posts.forEach(function (p) { p.indice = med > 0 ? arred(p.taxa / med, 2) : 0; p.taxa = arred(p.taxa * 100, 2); });
    posts.sort(function (a, b) { return String(b.data || "").localeCompare(String(a.data || "")); });
    return {
        conta: { username: ig.nome, seguidores: seguidores },
        taxa_media: arred(med * 100, 2), total_posts: posts.length, posts: posts.slice(0, 120),
        amostra: { media: amostra(media), reels: amostra(reels) }
    };
}

// ---------- ANUNCIOS ----------
const ADS_COMPLETA = ["results", "cost_per_results", "spend", "reach", "impressions", "clicks", "cpc", "inline_link_clicks", "ctr", "frequency", "actions:omni_purchase", "actions:purchase", "actions:onsite_conversion.messaging_conversation_started_7d", "action_values:omni_purchase", "actions:video_view", "video_thruplay_watched_actions"];
const ADS_MEDIA = ["results", "cost_per_results", "spend", "reach", "impressions", "clicks", "cpc", "inline_link_clicks", "actions:omni_purchase", "actions:onsite_conversion.messaging_conversation_started_7d"];
const ADS_SIMPLES = ["results", "cost_per_results", "spend", "reach", "impressions", "clicks", "cpc"];

// nome do resultado de cada campanha (a Meta manda em ingles no titulo da celula): [singular, plural]
const NOMES_RESULTADO = [
    [/purchase|compra/i, ["compra", "compras"]],
    [/messag|conversation|conversa/i, ["conversa", "conversas"]],
    [/profile.?visit|visita/i, ["visita ao perfil", "visitas ao perfil"]],
    [/landing.?page/i, ["visita ao site", "visitas ao site"]],
    [/link.?click|clique/i, ["clique no link", "cliques no link"]],
    [/lead|cadastro/i, ["cadastro", "cadastros"]],
    [/thruplay|video|v[ií]deo/i, ["visualização do vídeo", "visualizações do vídeo"]],
    [/follow|like|seguidor/i, ["novo seguidor", "novos seguidores"]],
    [/engagement|engajamento/i, ["engajamento", "engajamentos"]],
    [/impression/i, ["impressão", "impressões"]],
    [/reach|alcance/i, ["pessoa alcançada", "pessoas alcançadas"]]
];
function nomeDoResultado(cell) {
    const t = String((cell && typeof cell === "object" && !Array.isArray(cell) && (cell.title || cell.label)) || "");
    if (!t) return null;
    const achado = NOMES_RESULTADO.find(function (n) { return n[0].test(t); });
    return achado ? achado[1] : null;
}

function montarAnuncios(linhas) {
    const lista = linhas.map(function (l) {
        const m = l.m, nome = textoDe(l.dim) || "Anuncio";
        return {
            id: idDe(l.dim) || nome, nome: nome.slice(0, 160), miniatura: imagemDe(l.dim), link: linkDe(l.dim),
            gasto: numero(m.spend), resultados_brutos: numero(m.results), res_nome: nomeDoResultado(m.results), alcance: numero(m.reach), impressoes: numero(m.impressions),
            cliques: numero(m.inline_link_clicks) || numero(m.clicks), cpc: numero(m.cpc) || null, ctr_bruto: numero(m.ctr), frequencia: numero(m.frequency) || null,
            compras: numero(m["actions:omni_purchase"]) || numero(m["actions:purchase"]), conversas: numero(m["actions:onsite_conversion.messaging_conversation_started_7d"]),
            receita: numero(m["action_values:omni_purchase"]), v3: numero(m["actions:video_view"]), thru: numero(m.video_thruplay_watched_actions)
        };
    }).filter(function (a) { return a.gasto > 0; });
    const tot = { gasto: 0, compras: 0, conversas: 0, brutos: 0, receita: 0, alcance: 0, impressoes: 0, cliques: 0, v3: 0, thru: 0 };
    lista.forEach(function (a) { tot.gasto += a.gasto; tot.compras += a.compras; tot.conversas += a.conversas; tot.brutos += a.resultados_brutos; tot.receita += a.receita; tot.alcance += a.alcance; tot.impressoes += a.impressoes; tot.cliques += a.cliques; tot.v3 += a.v3; tot.thru += a.thru; });
    // resultado = venda; se a loja vende pelo WhatsApp (sem pixel), usa conversas iniciadas
    const tipo = tot.compras > 0 ? "vendas" : tot.conversas > 0 ? "conversas" : "resultados";
    function resultado(a) { return tipo === "vendas" ? a.compras : tipo === "conversas" ? a.conversas : a.resultados_brutos; }
    const totalRes = tipo === "vendas" ? tot.compras : tipo === "conversas" ? tot.conversas : tot.brutos;
    const med = { gancho: tot.impressoes && tot.v3 ? tot.v3 / tot.impressoes : 0, retencao: tot.v3 && tot.thru ? tot.thru / tot.v3 : 0, ctr: tot.impressoes && tot.cliques ? tot.cliques / tot.impressoes : 0 };
    lista.forEach(function (a) {
        a.resultados = resultado(a);
        a.custo_por_resultado = a.resultados > 0 ? arred(a.gasto / a.resultados, 2) : null;
        a.roas = a.gasto > 0 && a.receita > 0 ? arred(a.receita / a.gasto, 2) : null;
        a.taxa_gancho = a.impressoes && a.v3 ? arred((a.v3 / a.impressoes) * 100, 1) : null;
        a.retencao = a.v3 && a.thru ? arred((a.thru / a.v3) * 100, 1) : null;
        a.ctr = a.impressoes && a.cliques ? arred((a.cliques / a.impressoes) * 100, 2) : (a.ctr_bruto || null);
        const dg = [];
        if (a.taxa_gancho != null && med.gancho) dg.push(a.v3 / a.impressoes >= med.gancho ? "gancho forte" : "gancho fraco");
        if (a.retencao != null && med.retencao) dg.push(a.thru / a.v3 >= med.retencao ? "corpo segura" : "corpo perde gente");
        if (a.impressoes && a.cliques && med.ctr) dg.push(a.cliques / a.impressoes >= med.ctr ? "CTA puxa clique" : "CTA fraco");
        a.diagnostico = dg.join(", ");
        a.gasto = arred(a.gasto, 2);
        delete a.ctr_bruto; delete a.v3; delete a.thru; delete a.resultados_brutos;
    });
    lista.forEach(function (a) { if (tipo !== "resultados" || !a.res_nome) delete a.res_nome; });
    lista.sort(function (a, b) { return (b.resultados - a.resultados) || (b.gasto - a.gasto); });
    // campanhas com objetivos diferentes (alcance, visitas, cliques) nao se somam num numero so
    let resNome = null, misto = false;
    if (tipo === "resultados") {
        const nomes = {};
        lista.forEach(function (a) { if (a.resultados > 0) nomes[a.res_nome ? a.res_nome[1] : "resultados"] = a.res_nome || null; });
        const ks = Object.keys(nomes);
        if (ks.length === 1) resNome = nomes[ks[0]]; else if (ks.length > 1) misto = true;
    }
    return {
        tipo_resultado: tipo,
        totais: { gasto: arred(tot.gasto, 2), resultados: totalRes, res_nome: resNome, misto: misto, custo_medio: totalRes > 0 ? arred(tot.gasto / totalRes, 2) : null, compras: tot.compras, conversas: tot.conversas, receita: arred(tot.receita, 2), roas: tot.gasto && tot.receita ? arred(tot.receita / tot.gasto, 2) : null, alcance: tot.alcance, cliques: tot.cliques },
        medias: { taxa_gancho: arred(med.gancho * 100, 1), retencao: arred(med.retencao * 100, 1), ctr: arred(med.ctr * 100, 2) },
        anuncios: lista.slice(0, 40)
    };
}

async function coletarAnuncios(cli, fb, avisos) {
    const hoje = new Date(), fim = diaSP(hoje);
    const periodos = { p7: 7, p30: 30, p90: 90 };
    const out = { conta: fb.nome, moeda: fb.moeda };
    const res = await Promise.all(Object.keys(periodos).map(function (k) {
        const inicio = diaSP(new Date(hoje.getTime() - (periodos[k] - 1) * 864e5));
        return pedirTabela(cli, fb, inicio, fim, { id: "ads", reference_key: "fb_ads:ads", component: "datatable_v1", dimensions: [{ field: "ad" }], sort: ["-spend"] }, [ADS_COMPLETA, ADS_MEDIA, ADS_SIMPLES], avisos);
    }));
    Object.keys(periodos).forEach(function (k, i) { out[k] = montarAnuncios(res[i].linhas); });
    out.amostra = amostra(res[2]);
    return out;
}

// O Reportei nao manda a imagem dos anuncios. Anuncio feito a partir de um Reels leva no nome
// a primeira frase da legenda ("[Reels] - Antes de comprar, muita gente..."), entao a capa
// e o link vem do post organico correspondente. Anuncio subido direto no Gerenciador fica sem capa.
function chaveTexto(t) {
    return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/^\s*\[[^\]]*\]\s*[-\u2013\u2014:|]*\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function vincularCapas(org, ads) {
    if (!org || !ads) return;
    const posts = (org.posts || []).map(function (p) { return { p: p, k: chaveTexto(p.legenda) }; }).filter(function (x) { return x.k; });
    ["p7", "p30", "p90"].forEach(function (per) {
        ((ads[per] && ads[per].anuncios) || []).forEach(function (a) {
            if (a.miniatura) return;
            const k = chaveTexto(a.nome).slice(0, 50);
            if (k.length < 15) return;
            const x = posts.find(function (x) { return x.k.indexOf(k) === 0; });
            if (!x) return;
            a.miniatura = x.p.miniatura || "";
            a.post_link = x.p.link || "";
            a.post_id = x.p.id;
        });
    });
}

// "impressao digital" dos posts e anuncios: muda quando entra um post ou anuncio novo
// (o time de agentes usa para saber se vale analisar de novo)
function assinaturaDe(met) {
    const ids = [];
    ((met && met.organico && met.organico.posts) || []).forEach(function (p) { ids.push("p:" + p.id); });
    ((met && met.anuncios && met.anuncios.p90 && met.anuncios.p90.anuncios) || []).forEach(function (a) { ids.push("a:" + a.id); });
    return ids.length ? crypto.createHash("sha1").update(ids.sort().join("|")).digest("hex").slice(0, 16) : "";
}

// ---------- coleta completa de uma loja ----------
async function coletarLoja(userId) {
    const cli = await clienteDoUsuario(userId);
    const ints = await integracoesDoCliente(cli);
    const ativa = function (slug) { return ints.find(function (i) { return i.plataforma === slug && i.status === "active"; }) || ints.find(function (i) { return i.plataforma === slug; }); };
    const ig = ativa("instagram_business"), fb = ativa("facebook_ads");
    const avisos = [];
    const hoje = new Date(), fim = diaSP(hoje), inicio90 = diaSP(new Date(hoje.getTime() - 89 * 864e5));
    const [org, ads] = await Promise.all([
        ig ? coletarOrganico(cli, ig, inicio90, fim, avisos).catch(function (e) { avisos.push("Instagram: " + e.message); return null; }) : null,
        fb ? coletarAnuncios(cli, fb, avisos).catch(function (e) { avisos.push("Anuncios: " + e.message); return null; }) : null
    ]);
    vincularCapas(org, ads);
    if (!ig) avisos.push("Nenhum Instagram conectado no Reportei.");
    if (!fb) avisos.push("Nenhuma conta de anuncios conectada no Reportei.");
    const met = {
        versao: 1, fonte: "reportei", atualizado_em: new Date().toISOString(),
        conta: { username: ig ? ig.nome : null, seguidores: org ? org.conta.seguidores : null, anuncios: fb ? fb.nome : null },
        organico: org, anuncios: ads, avisos: avisos
    };
    met.assinatura = assinaturaDe(met);
    return met;
}

// resumo do dia para o historico (mostrar se subiu ou caiu)
function resumoDoDia(met) {
    const desde30 = Date.now() - 30 * 864e5;
    const posts30 = ((met.organico && met.organico.posts) || []).filter(function (p) { return p.data && new Date(p.data).getTime() >= desde30; });
    const a30 = met.anuncios && met.anuncios.p30;
    return {
        seguidores: met.conta.seguidores,
        posts_30d: posts30.length,
        visualizacoes_30d: posts30.reduce(function (s, p) { return s + (p.visualizacoes || 0); }, 0),
        alcance_30d: posts30.reduce(function (s, p) { return s + (p.alcance || 0); }, 0),
        gasto_30d: a30 ? a30.totais.gasto : null,
        resultados_30d: a30 ? a30.totais.resultados : null,
        tipo_resultado_30d: a30 ? a30.tipo_resultado : null
    };
}

async function salvarMetricas(userId, met) {
    const agora = new Date().toISOString();
    await banco("contas_meta", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: { user_id: userId, metricas: met, metricas_em: agora } });
    try {
        await banco("metricas_diarias", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: { user_id: userId, dia: diaSP(new Date()), resumo: resumoDoDia(met) } });
    } catch (e) { console.error("[coleta] historico: " + e.message); }
}

// resumo curto para mostrar no painel depois de atualizar
function resumoDaColeta(met) {
    const org = met.organico, ads = met.anuncios;
    return {
        posts: org ? org.total_posts : 0,
        anuncios: ads && ads.p90 ? ads.p90.anuncios.length : 0,
        avisos: met.avisos || []
    };
}

async function atualizarLoja(userId) {
    const met = await coletarLoja(userId);
    await salvarMetricas(userId, met);
    return resumoDaColeta(met);
}

module.exports = { coletarLoja, salvarMetricas, atualizarLoja, resumoDaColeta, numero, assinaturaDe, blocoDaResposta, diaSP, _interno: { numero, chaveTexto, vincularCapas, linhasDaTabela, montarAnuncios, textoDe, imagemDe, linkDe, dataDe, tipoDe } };
