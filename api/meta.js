// =====================================================================
//  CONEXAO COM A META (Instagram + Gerenciador de Anuncios)
//  So o admin usa. O admin conecta uma vez (login do Facebook, que vale
//  60 dias, ou o codigo de um usuario do sistema, que pode nunca expirar) e,
//  com o acesso que ele tem as contas das clientes, este arquivo coleta:
//    - organico: posts dos ultimos 90 dias com engajamento e compartilhamentos
//    - anuncios: anuncios dos ultimos 90 dias com vendas (ou conversas)
//    - publico: idade, genero, cidades e comentarios reais
//    - transcricao dos videos vencedores
//  Os agentes (no painel admin) leem esses dados e montam o dossie da conta.
// =====================================================================

const { validarAdmin, banco, criptografar, descriptografar, auditar } = require("./_seguranca.js");
const GRAPH = "https://graph.facebook.com/v23.0";
const DIAS = 90;
const ESCOPOS = "instagram_basic,instagram_manage_insights,instagram_manage_comments,pages_show_list,pages_read_engagement,read_insights,ads_read,business_management";

// ---------- apoio ----------
// token da Meta: so o servidor le (chave de servico) e ele fica criptografado no banco
async function tokenMeta() {
    const rows = await banco("meta_conexao?id=eq.1&select=access_token,expires_at");
    if (!rows || !rows.length) throw new Error("A Meta ainda nao foi conectada no painel admin.");
    return descriptografar(rows[0].access_token);
}

async function g(caminho, params, token) {
    // link completo (proxima pagina) ja vem com tudo, inclusive o token
    let url = caminho;
    if (caminho.indexOf("http") !== 0) {
        const p = Object.assign({}, params || {});
        if (token) p.access_token = token;
        url = GRAPH + caminho + "?" + new URLSearchParams(p).toString();
    }
    const r = await fetch(url);
    const d = await r.json();
    if (d && d.error) { const e = new Error(d.error.message || "Erro da Meta"); e.meta = d.error; throw e; }
    return d;
}

// Busca varias paginas ate "parar" dizer chega
async function paginar(caminho, params, token, maxPaginas, parar) {
    let out = [], d = await g(caminho, params, token), n = 1;
    while (true) {
        const itens = (d && d.data) || [];
        out = out.concat(itens);
        if ((parar && itens.length && parar(itens[itens.length - 1])) || !d.paging || !d.paging.next || n >= maxPaginas) break;
        d = await g(d.paging.next, {}, token); n++;
    }
    return out;
}

// Roda tarefas com poucas ao mesmo tempo (a Meta limita chamadas)
async function emLotes(itens, qtd, fn) {
    const out = new Array(itens.length); let i = 0;
    async function worker() { while (i < itens.length) { const k = i++; try { out[k] = await fn(itens[k], k); } catch (e) { out[k] = null; } } }
    await Promise.all(Array.from({ length: Math.min(qtd, itens.length) }, worker));
    return out;
}

function mediana(v) { const a = v.filter(x => isFinite(x)).sort((x, y) => x - y); if (!a.length) return 0; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function corta(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; }

// ---------- ORGANICO ----------
function lerInsights(d) {
    const out = {};
    ((d && d.data) || []).forEach(function (m) {
        const v = m.total_value ? m.total_value.value : (m.values && m.values[0] ? m.values[0].value : 0);
        out[m.name] = num(v);
    });
    return out;
}

async function insightsDoPost(p, token) {
    const reels = p.media_product_type === "REELS";
    const tentativas = reels
        ? ["reach,saved,shares,views,total_interactions,ig_reels_avg_watch_time", "reach,saved,shares,views", "reach,saved,shares", "reach"]
        : ["reach,saved,shares,views,total_interactions", "reach,saved,shares", "reach"];
    for (const metric of tentativas) {
        try { return lerInsights(await g("/" + p.id + "/insights", { metric: metric }, token)); } catch (e) { /* tenta com menos metricas */ }
    }
    return {};
}

async function demografia(igId, token) {
    const out = {};
    for (const b of ["age", "gender", "city"]) {
        try {
            const d = await g("/" + igId + "/insights", { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown: b }, token);
            const res = (((d.data || [])[0] || {}).total_value || {}).breakdowns;
            const lista = ((res && res[0] && res[0].results) || []).map(function (x) { return { chave: (x.dimension_values || []).join(" "), valor: num(x.value) }; });
            lista.sort(function (a, c) { return c.valor - a.valor; });
            out[b] = lista.slice(0, b === "city" ? 6 : 8);
        } catch (e) { out[b] = []; }
    }
    return out;
}

async function coletarOrganico(igId, token) {
    const desde = Date.now() - DIAS * 864e5, recente = Date.now() - 30 * 864e5;
    const conta = await g("/" + igId, { fields: "username,name,followers_count,media_count,profile_picture_url,biography" }, token);
    let posts = await paginar("/" + igId + "/media", { fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count", limit: 50 }, token, 4,
        function (ultimo) { return new Date(ultimo.timestamp).getTime() < desde; });
    posts = posts.filter(function (p) { return new Date(p.timestamp).getTime() >= desde; }).slice(0, 150);
    const ins = await emLotes(posts, 6, function (p) { return insightsDoPost(p, token); });
    const lista = posts.map(function (p, k) {
        const i = ins[k] || {};
        const alcance = num(i.reach), curt = num(p.like_count), com = num(p.comments_count), salv = num(i.saved), comp = num(i.shares);
        // resultado no organico: engajamento + compartilhamento (vale dobrado), relativo ao alcance
        const interacoes = curt + com + salv + comp * 2;
        return {
            id: p.id, tipo: p.media_product_type === "REELS" ? "Reels" : (p.media_type === "CAROUSEL_ALBUM" ? "Carrossel" : (p.media_type === "VIDEO" ? "Video" : "Foto")),
            video: p.media_type === "VIDEO", data: p.timestamp, recente: new Date(p.timestamp).getTime() >= recente,
            link: p.permalink, miniatura: p.thumbnail_url || (p.media_type === "IMAGE" ? p.media_url : "") || "",
            media_url: p.media_type === "VIDEO" ? (p.media_url || "") : "", legenda: corta(p.caption, 400),
            alcance: alcance, visualizacoes: num(i.views), curtidas: curt, comentarios: com, salvamentos: salv, compartilhamentos: comp,
            tempo_medio_s: i.ig_reels_avg_watch_time ? Math.round(num(i.ig_reels_avg_watch_time) / 100) / 10 : null,
            taxa: alcance > 0 ? interacoes / alcance : 0
        };
    });
    const med = mediana(lista.filter(function (x) { return x.alcance > 0; }).map(function (x) { return x.taxa; })) || 0;
    lista.forEach(function (x) {
        x.indice = med > 0 ? Math.round((x.taxa / med) * 100) / 100 : 0;          // 1.0 = media da propria conta
        x.pontos = x.indice * (x.recente ? 1.3 : 1);                               // ultimos 30 dias pesam mais
        x.taxa = Math.round(x.taxa * 10000) / 100;                                   // em %
    });
    const ordenada = lista.filter(function (x) { return x.alcance > 0; }).sort(function (a, b) { return b.pontos - a.pontos; });
    const top = ordenada.slice(0, 12);
    // comentarios reais dos melhores posts (linguagem do publico)
    const coms = await emLotes(top.slice(0, 5), 3, async function (p) {
        const d = await g("/" + p.id + "/comments", { fields: "text,like_count", limit: 25 }, token);
        return (d.data || []).map(function (c) { return corta(c.text, 180); });
    });
    return {
        conta: { username: conta.username, nome: conta.name, seguidores: num(conta.followers_count), foto: conta.profile_picture_url || "", bio: corta(conta.biography, 300) },
        periodo_dias: DIAS, total_posts: lista.length, taxa_media: Math.round(med * 10000) / 100,
        videos: top, piores: ordenada.slice(-3).reverse().filter(function (x) { return top.indexOf(x) < 0; }),
        publico: await demografia(igId, token),
        comentarios: [].concat.apply([], coms.filter(Boolean)).filter(Boolean).slice(0, 60)
    };
}

// ---------- ANUNCIOS ----------
const TIPOS_COMPRA = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
const TIPO_CONVERSA = ["onsite_conversion.messaging_conversation_started_7d"];
function acao(lista, tipos) {
    const l = lista || [];
    for (const t of tipos) { const a = l.find(function (x) { return x.action_type === t; }); if (a) return num(a.value); }
    return 0;
}

async function coletarAnuncios(adAccountId, token) {
    const act = "/" + (String(adAccountId).indexOf("act_") === 0 ? adAccountId : "act_" + adAccountId);
    const conta = await g(act, { fields: "name,currency,account_status" }, token);
    const campos = "ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values,video_thruplay_watched_actions";
    const [l90, l30] = await Promise.all([
        paginar(act + "/insights", { level: "ad", date_preset: "last_90d", fields: campos, limit: 200 }, token, 5),
        paginar(act + "/insights", { level: "ad", date_preset: "last_30d", fields: "ad_id,spend,actions", limit: 200 }, token, 5)
    ]);
    const tot = { gasto: 0, compras: 0, receita: 0, conversas: 0, cliques: 0 };
    l90.forEach(function (a) { tot.gasto += num(a.spend); tot.compras += acao(a.actions, TIPOS_COMPRA); tot.receita += acao(a.action_values, TIPOS_COMPRA); tot.conversas += acao(a.actions, TIPO_CONVERSA); tot.cliques += num(a.inline_link_clicks); });
    // resultado = venda; se a loja vende pelo WhatsApp (sem pixel), usa conversas iniciadas
    const tipo = tot.compras > 0 ? "vendas" : (tot.conversas > 0 ? "conversas" : "cliques");
    function resultado(a) { return tipo === "vendas" ? acao(a.actions, TIPOS_COMPRA) : (tipo === "conversas" ? acao(a.actions, TIPO_CONVERSA) : num(a.inline_link_clicks)); }
    const r30 = {}; l30.forEach(function (a) { r30[a.ad_id] = resultado(a); });
    const totalRes = tipo === "vendas" ? tot.compras : (tipo === "conversas" ? tot.conversas : tot.cliques);
    const cprMedio = totalRes > 0 ? tot.gasto / totalRes : 0;
    let somaImp = 0, soma3s = 0, somaThru = 0, somaLink = 0;
    l90.forEach(function (a) { somaImp += num(a.impressions); soma3s += acao(a.actions, ["video_view"]); somaThru += acao(a.video_thruplay_watched_actions, ["video_view"]); somaLink += num(a.inline_link_clicks); });
    const med = { gancho: somaImp ? soma3s / somaImp : 0, retencao: soma3s ? somaThru / soma3s : 0, ctr: somaImp ? somaLink / somaImp : 0 };

    const lista = l90.filter(function (a) { return num(a.spend) >= 20; }).map(function (a) {
        const gasto = num(a.spend), res = resultado(a), imp = num(a.impressions), v3 = acao(a.actions, ["video_view"]), thru = acao(a.video_thruplay_watched_actions, ["video_view"]);
        const cpr = res > 0 ? gasto / res : null, receita = acao(a.action_values, TIPOS_COMPRA);
        const x = {
            id: a.ad_id, nome: a.ad_name, campanha: a.campaign_name, gasto: Math.round(gasto * 100) / 100, impressoes: imp, alcance: num(a.reach),
            resultados: res, resultados_30d: r30[a.ad_id] || 0, custo_por_resultado: cpr ? Math.round(cpr * 100) / 100 : null,
            receita: Math.round(receita * 100) / 100, roas: gasto > 0 && receita > 0 ? Math.round((receita / gasto) * 100) / 100 : null,
            taxa_gancho: imp && v3 ? Math.round((v3 / imp) * 1000) / 10 : null, retencao: v3 && thru ? Math.round((thru / v3) * 1000) / 10 : null,
            ctr: imp ? Math.round((num(a.inline_link_clicks) / imp) * 10000) / 100 : null
        };
        // status igual ao que se ve no gerenciador: escalar, manter ou otimizar
        x.status = (res >= 2 && cpr && cprMedio && cpr <= cprMedio * 0.8) ? "Escalar" : ((res === 0 || (cpr && cprMedio && cpr >= cprMedio * 1.3)) ? "Otimizar" : "Manter");
        // diagnostico por parte do roteiro
        const dg = [];
        if (x.taxa_gancho != null && med.gancho) dg.push(v3 / imp >= med.gancho ? "gancho forte" : "gancho fraco");
        if (x.retencao != null && med.retencao) dg.push(thru / v3 >= med.retencao ? "corpo segura" : "corpo perde gente");
        if (imp && med.ctr) dg.push(num(a.inline_link_clicks) / imp >= med.ctr ? "CTA puxa clique" : "CTA fraco");
        x.diagnostico = dg.join(", ");
        x.pontos = cpr ? (res + 0.5 * x.resultados_30d) * (cprMedio / cpr) : 0;
        return x;
    }).sort(function (a, b) { return b.pontos - a.pontos; });

    const top = lista.slice(0, 12);
    // criativo (miniatura, texto e video) dos melhores
    if (top.length) {
        try {
            const d = await g("/", { ids: top.map(function (x) { return x.id; }).join(","), fields: "creative{thumbnail_url,image_url,video_id,body,title,object_story_spec}" }, token);
            top.forEach(function (x) {
                const c = (d[x.id] && d[x.id].creative) || {}, oss = c.object_story_spec || {}, vd = oss.video_data || {}, ld = oss.link_data || {};
                x.miniatura = c.thumbnail_url || c.image_url || vd.image_url || "";
                x.video_id = c.video_id || vd.video_id || "";
                x.texto = corta(c.body || vd.message || ld.message || "", 400);
                x.titulo = corta(c.title || vd.title || ld.name || "", 120);
            });
        } catch (e) { /* segue sem criativo */ }
    }
    // quem mais gera resultado (idade e genero)
    let segmentos = [];
    try {
        const seg = await g(act + "/insights", { date_preset: "last_90d", breakdowns: "age,gender", fields: "spend,actions,inline_link_clicks", limit: 100 }, token);
        segmentos = (seg.data || []).map(function (s) { const r = resultado(s); return { segmento: s.age + " " + (s.gender === "female" ? "mulheres" : s.gender === "male" ? "homens" : s.gender), gasto: Math.round(num(s.spend)), resultados: r, custo: r ? Math.round((num(s.spend) / r) * 100) / 100 : null }; })
            .filter(function (s) { return s.resultados > 0; }).sort(function (a, b) { return b.resultados - a.resultados; }).slice(0, 6);
    } catch (e) { /* sem segmentos */ }
    return {
        conta: { nome: conta.name, moeda: conta.currency }, periodo_dias: DIAS, tipo_resultado: tipo,
        totais: { gasto: Math.round(tot.gasto), resultados: totalRes, custo_medio: cprMedio ? Math.round(cprMedio * 100) / 100 : null, receita: Math.round(tot.receita), roas: tot.gasto && tot.receita ? Math.round((tot.receita / tot.gasto) * 100) / 100 : null },
        medias: { taxa_gancho: Math.round(med.gancho * 1000) / 10, retencao: Math.round(med.retencao * 1000) / 10, ctr: Math.round(med.ctr * 10000) / 100 },
        anuncios: top, piores: lista.slice(-3).reverse().filter(function (x) { return top.indexOf(x) < 0; }), segmentos: segmentos
    };
}

// ---------- TRANSCRICAO de um video vencedor ----------
async function transcrever(url) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Sem chave da OpenAI");
    const r = await fetch(url);
    if (!r.ok) throw new Error("Nao consegui baixar o video");
    const tam = num(r.headers.get("content-length"));
    if (tam > 24 * 1024 * 1024) throw new Error("Video grande demais para transcrever");
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 24 * 1024 * 1024) throw new Error("Video grande demais para transcrever");
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "video/mp4" }), "video.mp4");
    form.append("model", "whisper-1");
    form.append("language", "pt");
    const t = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + apiKey }, body: form });
    const d = await t.json();
    if (!t.ok) throw new Error((d.error && d.error.message) || "Erro ao transcrever");
    return d.text || "";
}

// ---------- rotas ----------
module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let admin;
    try { admin = await validarAdmin(jwt); } catch (e) { admin = null; }
    if (!admin) return res.status(403).json({ error: "Somente o admin pode usar a conexao com a Meta." });
    const b = req.body || {};
    const APP_ID = process.env.META_APP_ID, APP_SECRET = process.env.META_APP_SECRET;
    try {
        if (b.acao === "config") {
            let conexao = null;
            try { const rows = await banco("meta_conexao?id=eq.1&select=nome,expires_at,atualizado_em"); conexao = (rows && rows[0]) || null; } catch (e) { conexao = null; }
            return res.status(200).json({ appId: APP_ID || null, configId: process.env.META_CONFIG_ID || null, escopos: ESCOPOS, conexao: conexao });
        }
        if (b.acao === "conectar") {
            if (!APP_ID || !APP_SECRET) throw new Error("Configure META_APP_ID e META_APP_SECRET no Vercel.");
            const curto = await g("/oauth/access_token", { client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: b.redirect_uri, code: b.code }, "");
            const longo = await g("/oauth/access_token", { grant_type: "fb_exchange_token", client_id: APP_ID, client_secret: APP_SECRET, fb_exchange_token: curto.access_token }, "");
            const eu = await g("/me", { fields: "id,name" }, longo.access_token);
            const expira = new Date(Date.now() + num(longo.expires_in || 5184000) * 1000).toISOString();
            await banco("meta_conexao", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: { id: 1, access_token: criptografar(longo.access_token), nome: eu.name, meta_user_id: eu.id, expires_at: expira, atualizado_em: new Date().toISOString() } });
            await auditar(admin.id, "conectou a Meta", eu.name);
            return res.status(200).json({ ok: true, nome: eu.name, expires_at: expira });
        }
        // codigo colado pelo admin (usuario do sistema do Gerenciador de Negocios, que pode nunca expirar)
        if (b.acao === "salvar_token") {
            const novo = String(b.token || "").trim();
            if (novo.length < 50) throw new Error("Codigo invalido. Copie o codigo inteiro gerado no Gerenciador de Negocios.");
            const eu = await g("/me", { fields: "id,name" }, novo);
            // debug_token diz o tipo, a validade (0 = nunca expira) e as permissoes; precisa do app cadastrado no Vercel
            let expira = null, tipo = "", faltam = [];
            if (APP_ID && APP_SECRET) {
                const dbg = ((await g("/debug_token", { input_token: novo }, APP_ID + "|" + APP_SECRET)) || {}).data || {};
                if (dbg.is_valid === false) throw new Error("A Meta diz que este codigo nao e valido.");
                if (dbg.app_id && String(dbg.app_id) !== String(APP_ID)) throw new Error("Este codigo foi gerado para outro app. Gere de novo escolhendo o app do MCP Studio.");
                expira = dbg.expires_at ? new Date(dbg.expires_at * 1000).toISOString() : null;
                tipo = dbg.type || "";
                const tem = dbg.scopes || [];
                faltam = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement", "ads_read"].filter(function (s) { return tem.indexOf(s) < 0; });
            }
            await banco("meta_conexao", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: { id: 1, access_token: criptografar(novo), nome: eu.name, meta_user_id: eu.id, expires_at: expira, atualizado_em: new Date().toISOString() } });
            await auditar(admin.id, "conectou a Meta com codigo colado", eu.name + (tipo ? " (" + tipo + ")" : ""));
            return res.status(200).json({ ok: true, nome: eu.name, tipo: tipo, expires_at: expira, faltam: faltam });
        }
        const token = await tokenMeta();
        if (b.acao === "contas") {
            const [paginas, anuncios] = await Promise.all([
                paginar("/me/accounts", { fields: "name,instagram_business_account{id,username,profile_picture_url,followers_count}", limit: 100 }, token, 5).catch(function () { return []; }),
                paginar("/me/adaccounts", { fields: "name,account_id,currency,account_status", limit: 200 }, token, 5).catch(function () { return []; })
            ]);
            const ig = paginas.filter(function (p) { return p.instagram_business_account; }).map(function (p) { const i = p.instagram_business_account; return { id: i.id, username: i.username, seguidores: i.followers_count || 0, pagina: p.name }; });
            const ads = anuncios.map(function (a) { return { id: "act_" + a.account_id, nome: a.name, moeda: a.currency, ativa: a.account_status === 1 }; });
            return res.status(200).json({ instagram: ig, anuncios: ads });
        }
        if (b.acao === "organico") return res.status(200).json(await coletarOrganico(b.ig_id, token));
        if (b.acao === "anuncios") return res.status(200).json(await coletarAnuncios(b.ad_account_id, token));
        if (b.acao === "transcrever") {
            let url = b.url;
            if (!url && b.video_id) { const v = await g("/" + b.video_id, { fields: "source" }, token); url = v.source; }
            if (!url) throw new Error("Video sem link para baixar");
            return res.status(200).json({ texto: await transcrever(url) });
        }
        return res.status(400).json({ error: "Acao desconhecida" });
    } catch (e) {
        return res.status(500).json({ error: e.message || "Erro na conexao com a Meta" });
    }
};
