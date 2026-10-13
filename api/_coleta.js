// =====================================================================
//  COLETA DOS NUMEROS DE UMA LOJA (direto da Meta, so leitura)
//  - organico: cada post dos ultimos 90 dias (capa, legenda, alcance,
//    visualizacoes, curtidas, comentarios, salvos, compartilhamentos)
//  - anuncios: cada anuncio em 7, 30 e 90 dias (investido, compras,
//    conversas, custo por resultado, alcance, cliques, gancho, retencao)
//  Grava em contas_meta.metricas e uma foto do dia em metricas_diarias.
//  Usado pelo botao "Atualizar dados agora" e pela atualizacao diaria.
// =====================================================================

const crypto = require("crypto");
const { banco } = require("./_seguranca.js");
const { aplicarMeta } = require("./_meta-leitura.js");

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
function mediana(v) { const a = v.filter(function (x) { return isFinite(x); }).sort(function (x, y) { return x - y; }); if (!a.length) return 0; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function diaSP(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d); }

// taxa de engajamento e indice de cada post; devolve a taxa mediana
function finalizarPosts(posts) {
    posts.forEach(function (p) {
        if (!p.visualizacoes) p.visualizacoes = p.impressoes || p.alcance;
        if (!p.interacoes) p.interacoes = p.curtidas + p.comentarios + p.salvamentos + p.compartilhamentos;
        // resultado no organico: engajamento com compartilhamento valendo dobrado, relativo ao alcance
        p.taxa = p.alcance > 0 ? (p.curtidas + p.comentarios + p.salvamentos + p.compartilhamentos * 2) / p.alcance : 0;
    });
    // post que chegou a muito pouca gente (menos de 20% do alcance normal da conta): 5 curtidas em 130 pessoas
    // viram uma porcentagem enorme que nao quer dizer nada; ele fica marcado e nao passa da media
    const medAlc = mediana(posts.filter(function (x) { return x.alcance > 0; }).map(function (x) { return x.alcance; }));
    const pouco = function (x) { return x.alcance > 0 && medAlc > 0 && x.alcance < Math.max(100, medAlc * 0.2); };
    const med = mediana(posts.filter(function (x) { return x.alcance > 0 && !pouco(x); }).map(function (x) { return x.taxa; }));
    posts.forEach(function (p) {
        p.indice = med > 0 ? arred(p.taxa / med, 2) : 0;
        if (pouco(p)) { p.pouco_alcance = true; p.indice = Math.min(p.indice, 1); }
        p.taxa = arred(p.taxa * 100, 2);
    });
    posts.sort(function (a, b) { return String(b.data || "").localeCompare(String(a.data || "")); });
    return med;
}

// ---------- ANUNCIOS ----------
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

// objetivo: o que conta como resultado nesta loja (lojas.objetivo_anuncios, escolhido no painel):
// "vendas" = compras; "conversas_visitas" = conversas iniciadas (e visitas ao perfil, que vem da Meta);
// vazio = automatico (compras quando houver pixel com compra; senao conversas)
function montarAnuncios(linhas, objetivo) {
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
    const tipo = objetivo === "vendas" ? "vendas" : objetivo === "conversas_visitas" ? "conversas" : tot.compras > 0 ? "vendas" : tot.conversas > 0 ? "conversas" : "resultados";
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
        // campanha de visitas ao perfil: o resultado dela sao as visitas
        if (a.res_nome && /visitas? ao perfil/.test(a.res_nome[1])) a.visitas = a.resultados_brutos;
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
        tipo_resultado: tipo, objetivo: objetivo || "auto",
        totais: { visitas: lista.reduce(function (s, a) { return s + (a.visitas || 0); }, 0), gasto: arred(tot.gasto, 2), resultados: totalRes, res_nome: resNome, misto: misto, custo_medio: totalRes > 0 ? arred(tot.gasto / totalRes, 2) : null, compras: tot.compras, conversas: tot.conversas, receita: arred(tot.receita, 2), roas: tot.gasto && tot.receita ? arred(tot.receita / tot.gasto, 2) : null, alcance: tot.alcance, cliques: tot.cliques },
        medias: { taxa_gancho: arred(med.gancho * 100, 1), retencao: arred(med.retencao * 100, 1), ctr: arred(med.ctr * 100, 2) },
        anuncios: lista.slice(0, 40)
    };
}

// meses do calendario: este mes (do dia 1 ate hoje) e o mes anterior inteiro
function mesesDoCalendario(hoje) {
    const fim = diaSP(hoje), mes = fim.slice(0, 7), dia1 = new Date(mes + "-01T12:00:00Z");
    const ultimoAnt = diaSP(new Date(dia1.getTime() - 864e5));
    return { mes: { ref: mes, inicio: mes + "-01", fim: fim }, mes_ant: { ref: ultimoAnt.slice(0, 7), inicio: ultimoAnt.slice(0, 7) + "-01", fim: ultimoAnt } };
}

// periodos pedidos: 7, 30 e 90 dias, este mes e o mes anterior
// anterior = mes anterior ja coletado; como ele quase nao muda, so e pedido de novo uma vez por dia (da mesma fonte)
function faixasDosAnuncios(hoje, anterior, objetivo, fonte) {
    const fim = diaSP(hoje), faixas = {};
    [["p7", 7], ["p30", 30], ["p90", 90]].forEach(function (p) { faixas[p[0]] = { inicio: diaSP(new Date(hoje.getTime() - (p[1] - 1) * 864e5)), fim: fim }; });
    const meses = mesesDoCalendario(hoje);
    faixas.mes = meses.mes;
    const reusa = !!(anterior && anterior.ref === meses.mes_ant.ref && anterior.em && hoje.getTime() - new Date(anterior.em).getTime() < 864e5 && (anterior.objetivo || "auto") === (objetivo || "auto") && (anterior.fonte || "reportei") === fonte);
    if (!reusa) faixas.mes_ant = meses.mes_ant;
    return { faixas: faixas, meses: meses, reusa: reusa };
}
function fecharMeses(out, f, anterior, fonte, hoje) {
    out.mes.ref = f.meses.mes.ref;
    if (f.reusa) out.mes_ant = anterior;
    else { out.mes_ant.ref = f.meses.mes_ant.ref; out.mes_ant.em = hoje.toISOString(); out.mes_ant.fonte = fonte; }
}

// Anuncio que ainda nao tem capa guardada (api/_meta-leitura.js): o anuncio feito a partir de um Reels
// leva no nome a primeira frase da legenda ("[Reels] - Antes de comprar, muita gente..."), entao a capa
// e o link vem do post organico correspondente.
function chaveTexto(t) {
    return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/^\s*\[[^\]]*\]\s*[-\u2013\u2014:|]*\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function vincularCapas(org, ads) {
    if (!org || !ads) return;
    const posts = (org.posts || []).map(function (p) { return { p: p, k: chaveTexto(p.legenda) }; }).filter(function (x) { return x.k; });
    ["p7", "p30", "p90", "mes", "mes_ant"].forEach(function (per) {
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

// =====================================================================
//  LEITURA DIRETA DA META (desde out/2026; antes os numeros vinham do Reportei Connect)
//  So leitura (GET), com a pausa automatica de api/_meta-leitura.js. Usa o Instagram
//  (ig_id) e a conta de anuncios (conta_ads) de cada loja guardados em contas_meta.meta.
// =====================================================================
const POST_CAMPOS = "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,children{media_type,media_url,thumbnail_url}";
// da lista mais completa para a mais simples (se a Meta recusar uma metrica, a pagina inteira volta com erro)
const POST_METRICAS = [
    "reach,views,likes,comments,saved,shares,total_interactions,follows,profile_visits",
    "reach,views,likes,comments,saved,shares,total_interactions",
    "reach,likes,comments,saved,shares,total_interactions"
];
const MAX_POSTS = 120;
const ADS_CAMPOS = "ad_id,ad_name,spend,reach,impressions,clicks,inline_link_clicks,cpc,ctr,frequency,actions,action_values,video_thruplay_watched_actions";

function ehCodigo(id) { return /^\d{8,}$/.test(String(id || "")); }
// erro de metrica ou campo que a Meta nao aceita (diferente de "sem permissao")
function erroDeCampo(e) { const m = (e && e.meta) || {}; return Number(m.code) === 100 && Number(m.error_subcode) !== 33; }
function valorInsight(lista, nome) {
    const m = (lista || []).find(function (x) { return x.name === nome; });
    if (!m) return 0;
    return numero(m.total_value ? m.total_value.value : (m.values && m.values[0] ? m.values[0].value : 0));
}
function tipoMeta(x) {
    if (x.media_product_type === "REELS") return "Reels";
    if (x.media_type === "CAROUSEL_ALBUM") return "Carrossel";
    if (x.media_type === "VIDEO") return "Vídeo";
    if (x.media_type === "IMAGE") return "Foto";
    return "Post";
}
function capaMeta(x) {
    const f = (x.children && x.children.data && x.children.data[0]) || {};
    return x.thumbnail_url || (x.media_type === "IMAGE" ? x.media_url : "") || f.thumbnail_url || (f.media_type === "IMAGE" ? f.media_url : "") || "";
}
function postDaMeta(x, ins) {
    ins = ins || (x.insights && x.insights.data) || [];
    return {
        id: String(x.id), tipo: tipoMeta(x), data: x.timestamp ? new Date(x.timestamp).toISOString() : null, legenda: String(x.caption || "").slice(0, 400), miniatura: capaMeta(x), link: x.permalink || "",
        alcance: valorInsight(ins, "reach"), impressoes: 0, visualizacoes: valorInsight(ins, "views"), curtidas: valorInsight(ins, "likes"), comentarios: valorInsight(ins, "comments"),
        salvamentos: valorInsight(ins, "saved"), compartilhamentos: valorInsight(ins, "shares"), interacoes: valorInsight(ins, "total_interactions"), seguiram: valorInsight(ins, "follows"), visitas_perfil: valorInsight(ins, "profile_visits")
    };
}

// posts dos ultimos 90 dias, 25 por pagina, com os numeros de cada um na mesma consulta
async function postsDaMeta(igId, desde, token, info) {
    const meta = require("./_meta-leitura.js");
    const posts = [];
    let depois = null, nivel = 0;
    for (let pag = 0; pag < 10 && posts.length < MAX_POSTS; pag++) {
        const base = { limit: 25, since: Math.floor(desde / 1000) };
        if (depois) base.after = depois;
        let d = null;
        for (let n = nivel; n < POST_METRICAS.length && !d; n++) {
            try { d = await meta.g("/" + igId + "/media", Object.assign({ fields: POST_CAMPOS + ",insights.metric(" + POST_METRICAS[n] + ")" }, base), token); nivel = n; }
            catch (e) { if (!erroDeCampo(e)) throw e; }
        }
        // nenhuma lista serviu para a pagina inteira (um post antigo pode recusar): pede os numeros post a post
        if (!d) {
            d = await meta.g("/" + igId + "/media", Object.assign({ fields: POST_CAMPOS }, base), token);
            info.post_a_post = (info.post_a_post || 0) + (d.data || []).length;
            for (const x of d.data || []) {
                x.insights = { data: [] };
                for (let n = 1; n < POST_METRICAS.length; n++) {
                    try { x.insights = await meta.g("/" + x.id + "/insights", { metric: POST_METRICAS[n] }, token); break; }
                    catch (e) { if (!erroDeCampo(e)) throw e; }
                }
            }
        }
        let antigo = false;
        (d.data || []).forEach(function (x) {
            const t = x.timestamp ? new Date(x.timestamp).getTime() : 0;
            if (t && t < desde) { antigo = true; return; }
            posts.push(postDaMeta(x));
        });
        depois = d.paging && d.paging.next && d.paging.cursors ? d.paging.cursors.after : null;
        if (!depois || antigo) break;
    }
    info.metricas = POST_METRICAS[nivel];
    return posts;
}

// Collab em que a loja foi CONVIDADA (o post e de outra conta): nao vem em /media.
// A Meta entrega visualizacoes, curtidas, comentarios, salvamentos e compartilhamentos, mas nao o
// alcance nem o tempo assistido (so para quem criou o post). Se a Meta recusar, a loja segue sem eles.
const COLLAB_CAMPOS = [
    "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,username,total_views_count,like_count,comments_count,saved_count,shares_count",
    "id,caption,media_type,timestamp,permalink,thumbnail_url,media_url,username,like_count,comments_count",
    "id,caption,media_type,timestamp,permalink,username"
];
const MAX_COLLAB = 30;
async function collabDaMeta(igId, desde, token, info) {
    const meta = require("./_meta-leitura.js");
    const posts = [];
    let depois = null, nivel = 0;
    for (let pag = 0; pag < 3 && posts.length < MAX_COLLAB; pag++) {
        const base = { limit: 25 };
        if (depois) base.after = depois;
        let d = null;
        for (let n = nivel; n < COLLAB_CAMPOS.length && !d; n++) {
            try { d = await meta.g("/" + igId + "/collaborative_media", Object.assign({ fields: COLLAB_CAMPOS[n] }, base), token); nivel = n; }
            catch (e) { if (!erroDeCampo(e) || n === COLLAB_CAMPOS.length - 1) throw e; }
        }
        let antigo = false;
        (d.data || []).forEach(function (x) {
            const t = x.timestamp ? new Date(x.timestamp).getTime() : 0;
            if (t && t < desde) { antigo = true; return; }
            const p = postDaMeta(x, []);
            p.collab = true;
            p.collab_de = x.username || "";
            p.visualizacoes = numero(x.total_views_count);
            p.curtidas = numero(x.like_count); p.comentarios = numero(x.comments_count);
            p.salvamentos = numero(x.saved_count); p.compartilhamentos = numero(x.shares_count);
            p.interacoes = p.curtidas + p.comentarios + p.salvamentos + p.compartilhamentos;
            posts.push(p);
        });
        depois = d.paging && d.paging.next && d.paging.cursors ? d.paging.cursors.after : null;
        if (!depois || antigo) break;
    }
    info.collab_campos = nivel;
    return posts;
}

async function organicoDaMeta(igId, token) {
    const meta = require("./_meta-leitura.js");
    const desde = Date.now() - 90 * 864e5, info = {};
    const [conta, proprios, collabs] = await Promise.all([
        meta.g("/" + igId, { fields: "username,followers_count" }, token),
        postsDaMeta(igId, desde, token, info),
        collabDaMeta(igId, desde, token, info).catch(function (e) { if (e instanceof meta.MetaPausada) throw e; info.collab_erro = String(e.message || e).slice(0, 160); return []; })
    ]);
    const jaTem = {};
    proprios.forEach(function (p) { jaTem[p.id] = 1; });
    const posts = proprios.concat(collabs.filter(function (p) { return !jaTem[p.id]; }));
    // sem alcance, o collab fica fora da media de engajamento da loja (finalizarPosts so usa quem tem alcance)
    const med = finalizarPosts(posts);
    return {
        conta: { username: conta.username || null, seguidores: numero(conta.followers_count) },
        taxa_media: arred(med * 100, 2), total_posts: posts.length, posts: posts.slice(0, MAX_POSTS + MAX_COLLAB),
        amostra: { fonte: "meta", metricas: info.metricas, post_a_post: info.post_a_post || 0, collab: posts.length - proprios.length, collab_campos: info.collab_campos, collab_erro: info.collab_erro || null }
    };
}

// uma linha dos insights da Meta no formato que montarAnuncios le ({ dim, m: { metrica: valor } })
function somaAcoes(lista, tipo) { return (lista || []).reduce(function (s, a) { return s + (!tipo || a.action_type === tipo ? numero(a.value) : 0); }, 0); }
function resultadoDaMeta(r) {
    let total = 0, nome = "";
    (Array.isArray(r.results) ? r.results : []).forEach(function (x) {
        (x.values || []).forEach(function (v) { total += numero(v.value); });
        if (!nome && x.indicator) nome = String(x.indicator);
    });
    return { value: total, title: nome };
}
function linhaDaMeta(r) {
    const ac = r.actions, av = r.action_values;
    return {
        dim: { id: String(r.ad_id || ""), text: r.ad_name || "Anuncio" },
        m: {
            results: resultadoDaMeta(r), spend: r.spend, reach: r.reach, impressions: r.impressions, clicks: r.clicks, inline_link_clicks: r.inline_link_clicks, cpc: r.cpc, ctr: r.ctr, frequency: r.frequency,
            "actions:omni_purchase": somaAcoes(ac, "omni_purchase"), "actions:purchase": somaAcoes(ac, "purchase"),
            "actions:onsite_conversion.messaging_conversation_started_7d": somaAcoes(ac, "onsite_conversion.messaging_conversation_started_7d"),
            "action_values:omni_purchase": somaAcoes(av, "omni_purchase"), "actions:video_view": somaAcoes(ac, "video_view"),
            video_thruplay_watched_actions: somaAcoes(r.video_thruplay_watched_actions)
        }
    };
}

async function anunciosDaMeta(conta, token, anterior, objetivo) {
    const meta = require("./_meta-leitura.js");
    const hoje = new Date(), f = faixasDosAnuncios(hoje, anterior, objetivo, "meta");
    const info = await meta.g("/act_" + conta, { fields: "name,currency" }, token);
    const out = { conta: info.name || null, moeda: info.currency || null };
    let comResultado = true, cru = null;
    // um periodo de cada vez, para nao pesar no limite da conta de anuncios
    for (const k of Object.keys(f.faixas)) {
        const faixa = f.faixas[k], linhas = [];
        let d = null;
        const params = { level: "ad", time_range: JSON.stringify({ since: faixa.inicio, until: faixa.fim }), limit: 500 };
        if (comResultado) {
            try { d = await meta.g("/act_" + conta + "/insights", Object.assign({ fields: ADS_CAMPOS + ",results" }, params), token); }
            catch (e) { if (!erroDeCampo(e)) throw e; comResultado = false; }
        }
        if (!d) d = await meta.g("/act_" + conta + "/insights", Object.assign({ fields: ADS_CAMPOS }, params), token);
        for (let pag = 0; pag < 6 && d; pag++) {
            (d.data || []).forEach(function (r) { linhas.push(linhaDaMeta(r)); });
            if (k === "p90" && !cru && d.data && d.data.length) cru = d.data.slice(0, 2);
            d = d.paging && d.paging.next ? await meta.g(d.paging.next, null, null) : null;
        }
        out[k] = montarAnuncios(linhas, objetivo);
    }
    fecharMeses(out, f, anterior, "meta", hoje);
    out.amostra = (function () { try { return JSON.stringify({ fonte: "meta", resultados: comResultado, linhas: cru }).slice(0, 1500); } catch (e) { return "meta"; } })();
    return out;
}

// Instagram e conta de anuncios da loja na Meta: escolhidos no Painel Admin (contas_meta.ig_id e
// ad_account_id). Loja antiga sem a escolha: descobre pelos codigos de um post e de um anuncio que ja
// vieram numa coleta anterior e grava a descoberta.
async function idsDaMeta(userId, antes, token) {
    const meta = require("./_meta-leitura.js");
    const cache = (antes && antes.meta) || {}, velho = (antes && antes.metricas) || {};
    let ig = (antes && antes.ig_id) || cache.ig_id || "", conta = String((antes && antes.ad_account_id) || cache.conta_ads || "").replace(/^act_/, "");
    const campos = {};
    if (!ig) {
        const p = ((velho.organico && velho.organico.posts) || []).find(function (x) { return ehCodigo(x.id); });
        if (p) ig = String(((await meta.g("/" + p.id, { fields: "owner" }, token)).owner || {}).id || "");
    }
    if (!conta) {
        let a = null;
        ["p90", "mes_ant", "p30"].some(function (k) { a = ((velho.anuncios && velho.anuncios[k] && velho.anuncios[k].anuncios) || []).find(function (x) { return ehCodigo(x.id); }); return !!a; });
        if (a) conta = String((await meta.g("/" + a.id, { fields: "account_id" }, token)).account_id || "");
    }
    if (ig && !(antes && antes.ig_id)) campos.ig_id = ig;
    if (conta && !(antes && antes.ad_account_id)) campos.ad_account_id = conta;
    if (Object.keys(campos).length) {
        try { await banco("contas_meta?user_id=eq." + encodeURIComponent(userId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: campos }); }
        catch (e) { console.error("[coleta] ids da meta: " + e.message); }
    }
    return { ig: ig, conta: conta };
}

// ---------- coleta completa de uma loja (direto da Meta) ----------
// se uma parte falhar, ficam os numeros da coleta anterior dessa parte; se nada vier, nao grava nada
async function coletarLoja(userId, antes, objetivo) {
    const meta = require("./_meta-leitura.js");
    const avisos = [], fontes = { organico: null, anuncios: null };
    let org = null, ads = null;
    const con = await meta.conexao();
    if (!con) throw new Error("A conexão com a Meta venceu ou foi retirada. Entre com o Facebook de novo no Painel Admin.");
    if (con.pausada) throw new Error("A Meta pediu uma pausa nas consultas; a loja atualiza sozinha depois.");
    const ids = await idsDaMeta(userId, antes, con.token);
    if (!ids.ig && !ids.conta) throw new Error("Escolha o Instagram e a conta de anúncios da loja no Painel Admin (⋯ > Instagram e anúncios).");
    if (!ids.ig) avisos.push("Falta escolher o Instagram da loja no Painel Admin.");
    if (!ids.conta) avisos.push("Falta escolher a conta de anúncios da loja no Painel Admin.");
    [org, ads] = await Promise.all([
        ids.ig ? organicoDaMeta(ids.ig, con.token).catch(function (e) { avisos.push("Instagram: " + e.message); return null; }) : null,
        ids.conta ? anunciosDaMeta(ids.conta, con.token, antes && antes.mes_ant, objetivo).catch(function (e) { avisos.push("Anúncios: " + e.message); return null; }) : null
    ]);
    if (org) fontes.organico = "meta";
    if (ads) fontes.anuncios = "meta";

    // nada novo: nao grava (os numeros da coleta anterior continuam e a loja tenta de novo na proxima rodada)
    if (!org && !ads) throw new Error(avisos.join(" | ") || "A Meta não mandou dados");
    const velho = (antes && antes.metricas) || {};
    if (!org && ids.ig && velho.organico) { org = velho.organico; fontes.organico = "anterior"; avisos.push("Instagram: mantidos os números da coleta anterior."); }
    if (!ads && ids.conta && velho.anuncios) { ads = velho.anuncios; fontes.anuncios = "anterior"; avisos.push("Anúncios: mantidos os números da coleta anterior."); }

    vincularCapas(org, ads);
    const met = {
        versao: 1, fonte: "meta", fontes: fontes, atualizado_em: new Date().toISOString(),
        conta: { username: org && org.conta ? org.conta.username : null, seguidores: org && org.conta ? org.conta.seguidores : null, anuncios: ads ? ads.conta : null },
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
    // o que ja veio da Meta (capa e texto dos anuncios, falas, tempo assistido) entra junto, sem consultar a Meta de novo
    let antes = null, objetivo = null;
    try {
        const [r, lj] = await Promise.all([
            banco("contas_meta?user_id=eq." + encodeURIComponent(userId) + "&select=meta,metricas,ig_id,ad_account_id"),
            banco("lojas?user_id=eq." + encodeURIComponent(userId) + "&select=objetivo_anuncios").catch(function () { return []; })
        ]);
        antes = r && r[0];
        if (antes) antes.mes_ant = antes.metricas && antes.metricas.anuncios && antes.metricas.anuncios.mes_ant;
        objetivo = (lj && lj[0] && lj[0].objetivo_anuncios) || null;
    } catch (e) { console.error("[coleta] leitura anterior: " + e.message); }
    const met = await coletarLoja(userId, antes, objetivo);
    try { aplicarMeta(met, antes && antes.meta); } catch (e) { console.error("[coleta] meta: " + e.message); }
    await salvarMetricas(userId, met);
    return resumoDaColeta(met);
}

module.exports = { coletarLoja, salvarMetricas, atualizarLoja, resumoDaColeta, numero, assinaturaDe, diaSP, _interno: { numero, chaveTexto, vincularCapas, montarAnuncios, textoDe, imagemDe, linkDe, linhaDaMeta, postDaMeta, finalizarPosts, organicoDaMeta, anunciosDaMeta } };
