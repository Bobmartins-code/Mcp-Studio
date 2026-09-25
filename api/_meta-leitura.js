// =====================================================================
//  META NO TIME DE AGENTES (so leitura)
//  Completa o que o Reportei nao traz, usando os mesmos codigos de posts
//  e anuncios que o Reportei manda (sao os codigos da propria Meta):
//    - Reels: fala do video (transcrita), tempo medio assistido
//    - melhores posts: comentarios reais das seguidoras
//    - anuncios: capa, texto e titulo do criativo e a fala do video
//  Regras para a Meta nao estranhar:
//    - so leitura: so consulta (GET), nunca publica, responde ou altera nada
//    - poucas consultas: pede so o que e novo e guarda em contas_meta.meta
//    - recuo automatico: se a Meta avisar que o uso esta alto ou mandar
//      parar, pausa todas as consultas (meta_conexao.pausa_ate)
//  O Reportei continua com os numeros; a Meta nunca sobrescreve numero.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const { banco, descriptografar } = require("./_seguranca.js");

const GRAPH = "https://graph.facebook.com/v23.0";
const DIA_MS = 24 * 3600 * 1000;
const LIMITE_USO = 75;                 // % do limite da Meta: acima disso, pausa
const PAUSA_PADRAO_MIN = 60;
const CAPAS_MS = DIA_MS;               // as capas da Meta vencem: renova 1 vez por dia
const COMENTARIOS_MS = 3 * DIA_MS;
const REELS_RECENTE_MS = 14 * DIA_MS;  // tempo assistido ainda muda: atualiza 1 vez por dia ate 14 dias
const NOVA_TENTATIVA_MS = 3 * DIA_MS;  // video que nao deu para transcrever: tenta de novo depois
const MAX_FALAS_POSTS = 3, MAX_FALAS_ANUNCIOS = 2, ESPERA_FALAS_MS = 60000;
const LIMITE_BYTES = 24 * 1024 * 1024;

// ---------- pausa automatica ----------
let pausadoAte = 0; // nesta execucao do servidor

class MetaPausada extends Error {}

function usoDe(h) {
    let pct = 0, minutos = 0;
    function ver(o) {
        if (!o || typeof o !== "object") return;
        ["call_count", "total_cputime", "total_time", "acc_id_util_pct"].forEach(function (k) { const v = Number(o[k]); if (isFinite(v)) pct = Math.max(pct, v); });
        const m = Number(o.estimated_time_to_regain_access); if (isFinite(m)) minutos = Math.max(minutos, m);
    }
    function json(nome) { try { return JSON.parse(h.get(nome) || "null"); } catch (e) { return null; } }
    ver(json("x-app-usage"));
    ver(json("x-ad-account-usage"));
    const b = json("x-business-use-case-usage");
    if (b) Object.keys(b).forEach(function (k) { (b[k] || []).forEach(ver); });
    return { pct: pct, minutos: minutos };
}
// codigos que a Meta usa para "passou do limite"
function ehLimite(err) {
    const c = Number(err && err.code);
    return [4, 17, 32, 613].indexOf(c) > -1 || (c >= 80000 && c <= 80014) || Number(err && err.error_subcode) === 2446079;
}

async function pausar(minutos, motivo) {
    const ate = Date.now() + Math.max(15, minutos || PAUSA_PADRAO_MIN) * 60000;
    if (ate <= pausadoAte) return;
    pausadoAte = ate;
    console.error("[meta] consultas pausadas por " + Math.round((ate - Date.now()) / 60000) + " min: " + motivo);
    try { await banco("meta_conexao?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { pausa_ate: new Date(ate).toISOString(), pausa_motivo: String(motivo || "").slice(0, 200) } }); } catch (e) { /* a pausa em memoria ja vale */ }
}
async function marcarErro(msg) {
    try { await banco("meta_conexao?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { erro: msg } }); } catch (e) { /* segue */ }
}
// login novo ou codigo novo: zera pausa e erro
async function limparEstado() {
    pausadoAte = 0;
    await banco("meta_conexao?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { pausa_ate: null, pausa_motivo: null, erro: null } });
}

// Consulta de leitura na Meta (so GET), com o recuo automatico
async function g(caminho, params, token) {
    if (Date.now() < pausadoAte) throw new MetaPausada("Consultas a Meta pausadas ate " + new Date(pausadoAte).toISOString());
    let url = caminho;
    if (caminho.indexOf("http") !== 0) {
        const p = Object.assign({}, params || {});
        if (token) p.access_token = token;
        url = GRAPH + caminho + "?" + new URLSearchParams(p).toString();
    }
    const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30000) });
    const uso = usoDe(r.headers);
    const d = await r.json().catch(function () { return {}; });
    if (d && d.error) {
        const e = new Error(d.error.message || "Erro da Meta"); e.meta = d.error;
        if (ehLimite(d.error)) await pausar(uso.minutos || PAUSA_PADRAO_MIN, "a Meta pediu para esperar (" + d.error.code + ")");
        if (Number(d.error.code) === 190) await marcarErro("O acesso à Meta venceu ou foi retirado. Entre com o Facebook de novo no painel.");
        throw e;
    }
    if (uso.pct >= LIMITE_USO) await pausar(uso.minutos || 30, "uso em " + uso.pct + "% do limite da Meta");
    return d;
}

// token da Meta (so o servidor le; fica criptografado) e a pausa gravada no banco
async function conexao() {
    const rows = await banco("meta_conexao?id=eq.1&select=access_token,expires_at,pausa_ate,erro");
    const c = rows && rows[0];
    if (!c) return null;
    if (c.pausa_ate) pausadoAte = Math.max(pausadoAte, new Date(c.pausa_ate).getTime());
    if (c.erro || (c.expires_at && new Date(c.expires_at).getTime() < Date.now())) return null;
    return { token: descriptografar(c.access_token), pausada: Date.now() < pausadoAte };
}

// ---------- apoio ----------
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function corta(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; }
function ehCodigo(id) { return /^\d{8,}$/.test(String(id || "")); }
function velho(iso, ms) { return !iso || Date.now() - new Date(iso).getTime() >= ms; }
function lotes(v, n) { const out = []; for (let i = 0; i < v.length; i += n) out.push(v.slice(i, i + n)); return out; }
function espera(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Baixa o video e manda para o Whisper
async function transcrever(url) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Sem chave da OpenAI");
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("Nao consegui baixar o video");
    if (num(r.headers.get("content-length")) > LIMITE_BYTES) throw new Error("Video grande demais para transcrever");
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > LIMITE_BYTES) throw new Error("Video grande demais para transcrever");
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "video/mp4" }), "video.mp4");
    form.append("model", "whisper-1");
    form.append("language", "pt");
    const t = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + apiKey }, body: form, signal: AbortSignal.timeout(50000) });
    const d = await t.json().catch(function () { return {}; });
    if (!t.ok) throw new Error((d.error && d.error.message) || "Erro ao transcrever");
    return String(d.text || "").trim();
}

// ---------- o que falta de uma loja ----------
// met = contas_meta.metricas (numeros do Reportei); anterior = contas_meta.meta (o que ja veio da Meta)
// Devolve o cache atualizado. Se a Meta nao estiver conectada ou estiver pausada, devolve o anterior.
async function enriquecerLoja(met, anterior) {
    const cache = { em: (anterior && anterior.em) || null, erro: (anterior && anterior.erro) || null, posts: Object.assign({}, anterior && anterior.posts), anuncios: Object.assign({}, anterior && anterior.anuncios) };
    const con = await conexao();
    if (!con || con.pausada) return { cache: cache, pendentes: [] };
    const token = con.token;
    const agora = new Date().toISOString();
    const posts = ((met && met.organico && met.organico.posts) || []).filter(function (p) { return ehCodigo(p.id); });
    const ads = ((met && met.anuncios && met.anuncios.p90 && met.anuncios.p90.anuncios) || []).filter(function (a) { return ehCodigo(a.id); });
    function post(id) { return cache.posts[id] || (cache.posts[id] = {}); }
    const sem = { ig: false, ads: false };
    // sem permissao para esse Instagram ou conta de anuncios (10, 190, 2xx ou 100/33 "objeto nao existe ou sem permissao")
    function semPermissao(e) {
        const m = (e && e.meta) || {}, c = Number(m.code);
        return c === 10 || c === 190 || (c >= 200 && c < 300) || (c === 100 && Number(m.error_subcode) === 33);
    }
    function falhou(onde, e, qual) {
        if (e instanceof MetaPausada) throw e;
        if (semPermissao(e)) sem[qual] = true;
        console.error("[meta] " + onde + ": " + (e && e.message));
    }

    try {
        // 1) anuncios: capa, texto e titulo (1 consulta para ate 50 anuncios; renova 1 vez por dia porque as capas vencem)
        const adsPedir = ads.filter(function (a) { return velho(cache.anuncios[a.id] && cache.anuncios[a.id].em, CAPAS_MS); }).map(function (a) { return a.id; }).slice(0, 50);
        const igDosAds = {};
        const campos = "thumbnail_url,image_url,video_id,body,title,object_story_spec,effective_instagram_media_id";
        for (const lote of lotes(adsPedir, 50)) {
            try {
                // capa em tamanho maior; se a Meta nao aceitar o tamanho, pede a capa padrao
                const d = await g("/", { ids: lote.join(","), fields: "creative.thumbnail_width(600).thumbnail_height(600){" + campos + "}" }, token)
                    .catch(function (e) { if (e instanceof MetaPausada || semPermissao(e)) throw e; return g("/", { ids: lote.join(","), fields: "creative{" + campos + "}" }, token); });
                lote.forEach(function (id) {
                    const c = (d[id] && d[id].creative) || {}, oss = c.object_story_spec || {}, vd = oss.video_data || {}, ld = oss.link_data || {};
                    const antes = cache.anuncios[id] || {};
                    cache.anuncios[id] = Object.assign({}, antes, {
                        em: agora,
                        miniatura: c.image_url || vd.image_url || c.thumbnail_url || antes.miniatura || "",
                        texto: corta(c.body || vd.message || ld.message || "", 600),
                        titulo: corta(c.title || vd.title || ld.name || "", 140),
                        video_id: c.video_id || vd.video_id || "",
                        ig_media_id: c.effective_instagram_media_id || ""
                    });
                    if (c.effective_instagram_media_id) igDosAds[c.effective_instagram_media_id] = id;
                });
            } catch (e) { falhou("anuncios", e, "ads"); }
        }
        // anuncio feito a partir de um post do Instagram: capa grande e link do post (1 consulta para todos)
        const igIds = Object.keys(igDosAds);
        if (igIds.length) {
            try {
                const d = await g("/", { ids: igIds.slice(0, 50).join(","), fields: "thumbnail_url,media_url,media_type,permalink" }, token);
                igIds.forEach(function (ig) {
                    const x = d[ig]; if (!x) return;
                    const a = cache.anuncios[igDosAds[ig]];
                    a.miniatura = x.thumbnail_url || (x.media_type === "IMAGE" ? x.media_url : "") || a.miniatura;
                    a.post_link = x.permalink || a.post_link || "";
                });
            } catch (e) { falhou("posts dos anuncios", e, "nenhum"); }
        }

        // 2) Reels: tempo medio assistido (1 consulta por Reels; recentes 1 vez por dia, antigos 1 vez so)
        const reels = posts.filter(function (p) {
            if (p.tipo !== "Reels") return false;
            const c = cache.posts[p.id] || {};
            if (!c.ins_em) return true;
            return p.data && Date.now() - new Date(p.data).getTime() < REELS_RECENTE_MS && velho(c.ins_em, DIA_MS);
        }).slice(0, 15);
        for (const p of reels) {
            try {
                const d = await g("/" + p.id + "/insights", { metric: "ig_reels_avg_watch_time" }, token);
                const m = ((d.data || [])[0]) || {};
                const ms = m.total_value ? num(m.total_value.value) : (m.values && m.values[0] ? num(m.values[0].value) : 0);
                Object.assign(post(p.id), { tempo_medio_s: ms ? Math.round(ms / 100) / 10 : null, ins_em: agora });
            } catch (e) { falhou("Instagram", e, "ig"); if (sem.ig) break; post(p.id).ins_em = agora; }
        }

        // 3) comentarios reais dos 5 melhores posts (a cada 3 dias)
        const melhores = posts.filter(function (p) { return num(p.comentarios) > 0; })
            .sort(function (a, b) { return num(b.indice) - num(a.indice); }).slice(0, 5)
            .filter(function (p) { return velho((cache.posts[p.id] || {}).com_em, COMENTARIOS_MS); });
        for (const p of melhores) {
            if (sem.ig) break;
            try {
                const d = await g("/" + p.id + "/comments", { fields: "text,like_count", limit: 30 }, token);
                const lista = (d.data || []).filter(function (c) { return c.text && c.text.replace(/[@#]\S+/g, "").trim().length >= 3; })
                    .sort(function (a, b) { return num(b.like_count) - num(a.like_count); }).map(function (c) { return corta(c.text, 200); }).slice(0, 20);
                Object.assign(post(p.id), { comentarios: lista, com_em: agora });
            } catch (e) { falhou("comentarios", e, "ig"); }
        }
    } catch (e) {
        if (!(e instanceof MetaPausada)) throw e;
    }

    cache.em = agora;
    const faltam = [sem.ig ? "o Instagram" : "", sem.ads ? "a conta de anúncios" : ""].filter(Boolean);
    cache.erro = faltam.length ? "A Meta não enxerga " + faltam.join(" nem ") + " desta loja com o seu acesso." : null;

    // 4) falas que faltam: os melhores Reels e anuncios em video (cada video e transcrito uma vez so)
    const pendentes = [];
    if (Date.now() >= pausadoAte) {
        const reelsBons = sem.ig ? [] : posts.filter(function (p) { const c = cache.posts[p.id] || {}; return p.tipo === "Reels" && num(p.indice) >= 1 && !c.transcricao && velho(c.fala_erro_em, NOVA_TENTATIVA_MS); })
            .sort(function (a, b) { return num(b.indice) - num(a.indice); }).slice(0, MAX_FALAS_POSTS);
        const adsBons = sem.ads ? [] : ads.filter(function (a) { const c = cache.anuncios[a.id] || {}; return (c.ig_media_id || c.video_id) && !c.transcricao && velho(c.fala_erro_em, NOVA_TENTATIVA_MS); })
            .sort(function (a, b) { return num(b.resultados) - num(a.resultados) || num(b.gasto) - num(a.gasto); }).slice(0, MAX_FALAS_ANUNCIOS);
        const falaDoPost = {};
        reelsBons.forEach(function (p) {
            pendentes.push(falaDoPost[p.id] = (async function () {
                const alvo = post(p.id);
                try {
                    const x = await g("/" + p.id, { fields: "media_url" }, token);
                    if (!x.media_url) throw new Error("sem link do video");
                    alvo.transcricao = corta(await transcrever(x.media_url), 3000);
                } catch (e) { alvo.fala_erro_em = new Date().toISOString(); console.error("[meta] fala do post " + p.id + ": " + (e && e.message)); }
            })());
        });
        adsBons.forEach(function (a) {
            pendentes.push((async function () {
                const alvo = cache.anuncios[a.id];
                // o mesmo video ja transcrito (ou sendo transcrito agora) como post: reaproveita
                if (alvo.ig_media_id && falaDoPost[alvo.ig_media_id]) await falaDoPost[alvo.ig_media_id];
                const doPost =alvo.ig_media_id && cache.posts[alvo.ig_media_id] && cache.posts[alvo.ig_media_id].transcricao;
                if (doPost) { alvo.transcricao = doPost; return; }
                try {
                    let url = "";
                    if (alvo.ig_media_id) url = (await g("/" + alvo.ig_media_id, { fields: "media_url,media_type" }, token)).media_url || "";
                    if (!url && alvo.video_id) url = (await g("/" + alvo.video_id, { fields: "source" }, token)).source || "";
                    if (!url) throw new Error("sem link do video");
                    alvo.transcricao = corta(await transcrever(url), 3000);
                } catch (e) { alvo.fala_erro_em = new Date().toISOString(); console.error("[meta] fala do anuncio " + a.id + ": " + (e && e.message)); }
            })());
        });
    }
    return { cache: cache, pendentes: pendentes };
}

// Espera as falas por um tempo limitado; o que terminar depois ainda entra no cache
// (o time grava o cache no fim da analise)
async function esperarFalas(pendentes) {
    if (!pendentes || !pendentes.length) return;
    await Promise.race([Promise.all(pendentes), espera(ESPERA_FALAS_MS)]);
}

// Junta o que veio da Meta nos numeros do Reportei (sem trocar nenhum numero)
function aplicarMeta(met, cache) {
    if (!met || !cache) return met;
    const cp = cache.posts || {}, ca = cache.anuncios || {};
    const porId = {};
    ((met.organico && met.organico.posts) || []).forEach(function (p) {
        porId[p.id] = p;
        const c = cp[p.id]; if (!c) return;
        if (c.tempo_medio_s) p.tempo_medio_s = c.tempo_medio_s;
        if (c.transcricao) p.transcricao = c.transcricao;
    });
    ["p7", "p30", "p90"].forEach(function (per) {
        ((met.anuncios && met.anuncios[per] && met.anuncios[per].anuncios) || []).forEach(function (a) {
            const c = ca[a.id]; if (!c) return;
            if (c.miniatura) a.miniatura = c.miniatura;
            if (c.texto) a.texto = c.texto;
            if (c.titulo) a.titulo = c.titulo;
            if (c.post_link) a.post_link = c.post_link;
            if (c.ig_media_id && porId[c.ig_media_id]) a.post_id = c.ig_media_id;
            const fala = c.transcricao || (c.ig_media_id && cp[c.ig_media_id] && cp[c.ig_media_id].transcricao);
            if (fala) a.transcricao = fala;
        });
    });
    return met;
}

// comentarios reais guardados, dos melhores posts para os outros
function comentariosDaLoja(met, cache) {
    if (!cache || !cache.posts) return [];
    const posts = ((met && met.organico && met.organico.posts) || []).slice().sort(function (a, b) { return num(b.indice) - num(a.indice); });
    const out = [];
    posts.forEach(function (p) { const c = cache.posts[p.id]; if (c && c.comentarios) c.comentarios.forEach(function (t) { out.push(t); }); });
    return out.slice(0, 60);
}

module.exports = { g, conexao, limparEstado, enriquecerLoja, esperarFalas, aplicarMeta, comentariosDaLoja, transcrever, MetaPausada, _interno: { usoDe, ehLimite } };
