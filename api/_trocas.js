// =====================================================================
//  HISTORICO DE TROCA DE CRIATIVO (so leitura na Meta, sem IA)
//  Quando a loja troca o criativo de um anuncio, a Meta registra a troca nas "atividades" da conta de anuncios
//  (event_type update_ad_creative, com a capa anterior). A cada 2 horas, na atualizacao dos numeros:
//    - le as atividades novas (na primeira vez, os ultimos 60 dias)
//    - guarda a capa anterior no nosso armazenamento (o link da Meta vence)
//    - guarda o que ja sabiamos do criativo anterior (video, post, texto, fala) e rele o criativo atual
//  Fica em contas_meta.meta.trocas = { desde, ate, em, ads: { <anuncio>: [ { em, capa, video_id, ig_media_id, post_link, texto, transcricao } ] } }
//  Cada item descreve o criativo que saiu do ar na hora "em". Os videos NAO sao baixados: na hora de assistir,
//  o app pede um link novo a Meta (api/_painel.js).
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================
const crypto = require("crypto");
const { enviarArquivo } = require("./_seguranca.js");
const meta = require("./_meta-leitura.js");

const DIA = 864e5;
const CHECAR_MS = 2 * 3600e3;         // le as atividades no maximo 1 vez a cada 2 horas por loja
const JANELA_INICIAL_MS = 60 * DIA;   // primeira vez: as trocas dos ultimos 60 dias
const SOBRA_MS = 3600e3;              // le 1 hora a mais para tras (nao perde troca na virada)
const MAX_PAGINAS = 8, MAX_CAPAS_RODADA = 40, MAX_RELER_RODADA = 15;
const CAMPOS_DO_CRIATIVO = ["video_id", "ig_media_id", "post_link", "texto", "transcricao"];
// o que foi lido do criativo anterior nao vale para o novo (fala, video assistido, link do post)
const SAI_NA_TROCA = ["transcricao", "sem_fala", "fala_erro_em", "visual", "olhos_erro_em", "post_link", "miniatura", "texto", "titulo", "video_id", "ig_media_id"];
const HOST_META = /^https:\/\/[a-z0-9.-]+\.(fbcdn\.net|cdninstagram\.com)\//i;

function iso(ms) { return new Date(ms).toISOString(); }
// capas que a Meta mandou como "valor antigo" (texto em JSON com uma lista de links)
function capasDoEvento(extra) {
    let x = extra;
    try { if (typeof x === "string") x = JSON.parse(x); } catch (e) { return []; }
    const v = x && x.old_value;
    return (Array.isArray(v) ? v : [v]).filter(function (u) { return typeof u === "string" && HOST_META.test(u); });
}

async function copiarCapa(userId, adId, quando, links) {
    for (const u of links) {
        if (!HOST_META.test(String(u || ""))) continue;
        try {
            const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
            const tipo = String(r.headers.get("content-type") || "").split(";")[0];
            if (!r.ok || !/^image\//.test(tipo)) continue;
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < 500 || buf.length > 4 * 1024 * 1024) continue;
            const nome = userId + "/criativos/" + adId + "-" + new Date(quando).getTime() + "-" + crypto.randomBytes(5).toString("hex") + ".jpg";
            return await enviarArquivo("stories", nome, buf, tipo);
        } catch (e) { /* link vencido: tenta o proximo */ }
    }
    return "";
}

// le as trocas novas de 1 loja e devolve o que gravar em contas_meta.meta (ou null se nao for a hora)
// anterior = contas_meta.meta; met = contas_meta.metricas da coleta (para a capa dos posts da loja)
async function trocasDaLoja(userId, act, anterior, met) {
    if (!act) return null;
    const t = (anterior && anterior.trocas) || {};
    if (t.em && Date.now() - new Date(t.em).getTime() < CHECAR_MS) return null;
    const con = await meta.conexao();
    if (!con || con.pausada) return null;
    const agora = Date.now();
    const desde = t.ate ? new Date(t.ate).getTime() - SOBRA_MS : agora - JANELA_INICIAL_MS;

    const eventos = [];
    let d = await meta.g("/" + act + "/activities", { fields: "event_time,event_type,object_id,object_type,extra_data", since: Math.floor(desde / 1000), until: Math.floor(agora / 1000), limit: 500 }, con.token);
    let paginas = 0;
    while (d) {
        paginas++;
        (d.data || []).forEach(function (e) {
            if (e.event_type === "update_ad_creative" && /^\d{6,}$/.test(String(e.object_id || "")) && e.event_time) eventos.push(e);
        });
        if (!(d.paging && d.paging.next)) break;
        if (paginas >= MAX_PAGINAS) { console.log("[trocas] " + userId.slice(0, 8) + ": parou em " + paginas + " paginas"); break; }
        d = await meta.g(d.paging.next, null, null);
    }
    if (eventos.length && !t.ate) console.log("[trocas] " + userId.slice(0, 8) + ": " + eventos.length + " trocas nos ultimos 60 dias (tipo " + (eventos[0].object_type || "?") + ")");

    const cacheAds = (anterior && anterior.anuncios) || {}, ja = t.ads || {};
    const novas = {}, usouCache = {};
    let capas = 0;
    eventos.sort(function (a, b) { return new Date(a.event_time) - new Date(b.event_time); });
    for (const e of eventos) {
        const id = String(e.object_id), em = new Date(e.event_time).toISOString();
        if ((ja[id] || []).some(function (x) { return x.em === em; }) || (novas[id] || []).some(function (x) { return x.em === em; })) continue;
        const item = { em: em };
        // o que guardamos do anuncio antes da troca e o criativo que saiu (so serve para a primeira troca depois da leitura)
        const c = cacheAds[id];
        if (c && c.em && c.em < em && !usouCache[id]) {
            usouCache[id] = 1;
            CAMPOS_DO_CRIATIVO.forEach(function (k) { if (c[k]) item[k] = c[k]; });
        }
        const links = capasDoEvento(e.extra_data);
        // nome do arquivo da capa: serve para achar depois qual era o video (recuperarVideos)
        const chaves = links.map(chaveDaCapa).filter(Boolean).slice(0, 3);
        if (chaves.length) item.chaves = chaves;
        if (usouCache[id] === 1 && c && c.miniatura) links.push(c.miniatura);
        if (usouCache[id] === 1) usouCache[id] = 2;
        item.capa = capas < MAX_CAPAS_RODADA ? await copiarCapa(userId, id, em, links) : "";
        if (item.capa) capas++;
        (novas[id] = novas[id] || []).push(item);
    }

    // anuncio trocado que ja tinha leitura de antes da troca: le o criativo atual (sem a fala e o video do anterior)
    const relidos = {};
    const postsDaLoja = {};
    ((met && met.organico && met.organico.posts) || []).forEach(function (p) { postsDaLoja[p.id] = p; });
    const estado = { tamanhoOk: true }, agoraIso = iso(agora);
    const paraReler = Object.keys(novas).filter(function (id) {
        const c = cacheAds[id], ult = novas[id][novas[id].length - 1];
        return c && c.em && c.em < ult.em;
    }).slice(0, MAX_RELER_RODADA);
    for (const id of paraReler) {
        const base = Object.assign({}, cacheAds[id]);
        SAI_NA_TROCA.forEach(function (k) { delete base[k]; });
        base.trocado_em = agoraIso;   // marca: leitura anterior a esta hora nao volta a valer (juntarMeta)
        try { relidos[id] = await meta.lerCriativo(id, con.token, postsDaLoja, base, estado, agoraIso); }
        catch (e) {
            if (e instanceof meta.MetaPausada) throw e;
            // sem conseguir reler: pelo menos a fala do criativo anterior nao fica valendo para o novo
            relidos[id] = Object.assign(base, { em: agoraIso });
            console.error("[trocas] criativo atual " + id + ": " + (e && e.message));
        }
    }

    const out = { trocas: { desde: t.desde || iso(desde), ate: agoraIso, em: agoraIso, ads: novas } };
    if (Object.keys(relidos).length) out.anuncios = relidos;
    if (eventos.length) console.log("[trocas] " + userId.slice(0, 8) + ": " + Object.keys(novas).reduce(function (s, k) { return s + novas[k].length; }, 0) + " trocas novas, " + capas + " capas guardadas, " + Object.keys(relidos).length + " criativos relidos");
    return out;
}

// ---------- qual era o video do criativo anterior ----------
// A Meta so manda a capa do criativo que saiu. O criativo antigo continua na biblioteca da conta de anuncios
// (adcreatives) com o video dele; a capa e o mesmo arquivo. Compara pelo nome do arquivo da capa.
const BUSCA_MS = 2 * 3600e3, MAX_PAGINAS_CRIATIVOS = 15, MAX_POSTS_RODADA = 25;
function chaveDaCapa(u) {
    // capa servida por outro endereco da Meta (safe_image): o arquivo de verdade vem no parametro url
    try { const dentro = new URL(String(u || "")).searchParams.get("url"); if (dentro) { const k = chaveDaCapa(dentro); if (k) return k; } } catch (e) { /* nao e um endereco */ }
    const m = /\/([^\/?#]+\.(?:jpe?g|png|webp|heic))(?:[?#]|$)/i.exec(String(u || "")); return m ? m[1].toLowerCase() : ""; }
function semVideo(x) { return x && !x.video_id && !x.ig_media_id; }
async function recuperarVideos(userId, act, anterior) {
    if (!act) return null;
    const t = (anterior && anterior.trocas) || {}, ads = t.ads || {};
    if (!t.ate || (t.busca_em && Date.now() - new Date(t.busca_em).getTime() < BUSCA_MS)) return null;
    const faltam = [];
    Object.keys(ads).forEach(function (id) { (ads[id] || []).forEach(function (x) { if (semVideo(x) && !x.busca) faltam.push({ id: id, x: x }); }); });
    if (!faltam.length) return null;
    const con = await meta.conexao();
    if (!con || con.pausada) return null;
    const agoraIso = new Date().toISOString();

    // trocas guardadas antes de existir a "chave" da capa: rele as atividades do periodo para pegar a capa de novo
    if (faltam.some(function (f) { return !f.x.chaves; })) {
        const porTroca = {};
        let d = await meta.g("/" + act + "/activities", { fields: "event_time,event_type,object_id,extra_data", since: Math.floor(new Date(t.desde || Date.now() - 60 * DIA).getTime() / 1000), until: Math.floor(new Date(t.ate).getTime() / 1000), limit: 500 }, con.token);
        let paginas = 0;
        while (d) {
            paginas++;
            (d.data || []).forEach(function (e) {
                if (e.event_type !== "update_ad_creative" || !e.event_time) return;
                porTroca[String(e.object_id) + "|" + new Date(e.event_time).toISOString()] = capasDoEvento(e.extra_data).map(chaveDaCapa).filter(Boolean).slice(0, 3);
            });
            if (!(d.paging && d.paging.next) || paginas >= MAX_PAGINAS) break;
            d = await meta.g(d.paging.next, null, null);
        }
        faltam.forEach(function (f) { if (!f.x.chaves) f.x.chaves = porTroca[f.id + "|" + f.x.em] || []; });
    }

    // os criativos da conta (mais novos primeiro), so os que tem video ou vem de um post
    const procura = {};
    faltam.forEach(function (f) { (f.x.chaves || []).forEach(function (k) { procura[k] = 1; }); });
    const achados = {};
    let falta = Object.keys(procura).length, paginas = 0;
    if (falta) {
        let d = await meta.g("/" + act + "/adcreatives", { fields: "video_id,effective_instagram_media_id,thumbnail_url,image_url,object_story_spec{video_data{video_id,image_url}}", limit: 200 }, con.token);
        while (d && falta > 0) {
            paginas++;
            (d.data || []).forEach(function (c) {
                const vd = (c.object_story_spec && c.object_story_spec.video_data) || {};
                const v = { video_id: c.video_id || vd.video_id || "", ig_media_id: c.effective_instagram_media_id || "" };
                if (!v.video_id && !v.ig_media_id) return;
                [c.thumbnail_url, c.image_url, vd.image_url].map(chaveDaCapa).forEach(function (k) { if (k && procura[k] && !achados[k]) { achados[k] = v; falta--; } });
            });
            if (!(d.paging && d.paging.next) || paginas >= MAX_PAGINAS_CRIATIVOS) break;
            d = await meta.g(d.paging.next, null, null);
        }
    }

    // criativo que veio de um post: so vale se o post for video (foto continua sem play); o link do post vai junto
    const posts = {};
    let consultas = 0;
    const out = {};
    let comVideo = 0;
    for (const f of faltam) {
        const v = (f.x.chaves || []).map(function (k) { return achados[k]; }).find(Boolean);
        const item = { em: f.x.em, busca: v ? "achou" : "nao", chaves: f.x.chaves || [] };
        if (v && v.video_id) item.video_id = v.video_id;
        if (v && v.ig_media_id) {
            if (!(v.ig_media_id in posts) && consultas < MAX_POSTS_RODADA) {
                consultas++;
                try { posts[v.ig_media_id] = await meta.g("/" + v.ig_media_id, { fields: "media_type,permalink" }, con.token); }
                catch (e) { if (e instanceof meta.MetaPausada) throw e; posts[v.ig_media_id] = null; }
            }
            const p = posts[v.ig_media_id];
            if (p && p.permalink) item.post_link = p.permalink;
            if (p && p.media_type === "VIDEO") item.ig_media_id = v.ig_media_id;
            if (!(v.ig_media_id in posts)) item.busca = "";   // ficou para a proxima rodada
        }
        if (item.video_id || item.ig_media_id) comVideo++;
        (out[f.id] = out[f.id] || []).push(item);
    }
    console.log("[trocas] " + userId.slice(0, 8) + ": video anterior achado em " + comVideo + " de " + faltam.length + " trocas (" + paginas + " paginas de criativos)");
    return { trocas: { em: t.em, busca_em: agoraIso, ads: out } };
}

// ---------- periodos de cada versao do anuncio (para a tela) ----------
function diaSP(ms) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(ms)); }
function somaDia(dia, n) { return new Date(new Date(dia + "T12:00:00Z").getTime() + n * DIA).toISOString().slice(0, 10); }
// trocas = lista do anuncio (mais antiga primeiro); criado = created_time do anuncio; desde = inicio do historico
// devolve [{ inicio, fim, troca (indice do item que guarda esse criativo, ou null no atual) }], a mais antiga primeiro
function versoesDe(trocas, criado, desde, hoje) {
    const lista = (trocas || []).slice().sort(function (a, b) { return a.em < b.em ? -1 : 1; });
    if (!lista.length) return [];
    const ini0 = [criado && diaSP(new Date(criado).getTime()), desde && diaSP(new Date(desde).getTime())].filter(Boolean).sort().pop() || diaSP(new Date(lista[0].em).getTime() - 30 * DIA);
    const out = [];
    for (let k = 0; k <= lista.length; k++) {
        const inicio = k === 0 ? ini0 : diaSP(new Date(lista[k - 1].em).getTime());
        const fim = k < lista.length ? somaDia(diaSP(new Date(lista[k].em).getTime()), -1) : hoje;
        out.push({ inicio: inicio, fim: fim, troca: k < lista.length ? k : null });
    }
    return out;
}
// 7 dias antes da troca contra 7 dias depois (o dia da troca conta para o criativo novo)
function janelasDoLembrete(em) {
    const d = diaSP(new Date(em).getTime());
    return { antes: { inicio: somaDia(d, -7), fim: somaDia(d, -1) }, depois: { inicio: d, fim: somaDia(d, 6) } };
}

module.exports = { trocasDaLoja, recuperarVideos, versoesDe, janelasDoLembrete, _interno: { capasDoEvento, chaveDaCapa, diaSP, somaDia } };
