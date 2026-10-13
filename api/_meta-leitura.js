// =====================================================================
//  META NO TIME DE AGENTES (so leitura)
//  Completa o que o Reportei nao traz, usando os mesmos codigos de posts
//  e anuncios que o Reportei manda (sao os codigos da propria Meta):
//    - Reels: fala do video (transcrita), tempo medio assistido
//    - melhores posts: comentarios reais das seguidoras
//    - anuncios: capa, texto e titulo do criativo e a fala do video
//    - publico: idade, genero e cidades de quem segue (1 vez por semana)
//    - fichas dos campeoes: os 5 melhores videos de cada criterio (api/_cerebro.js) tem a fala
//      lida e o video assistido (api/_olhos.js), uma vez so
//    - visitas ao perfil de cada anuncio (loja medida por conversas e visitas; a cada 6 horas)
//  Regras para a Meta nao estranhar:
//    - so leitura: so consulta (GET), nunca publica, responde ou altera nada
//    - poucas consultas: pede so o que e novo e guarda em contas_meta.meta
//    - recuo automatico: se a Meta avisar que o uso esta alto ou mandar
//      parar, pausa todas as consultas (meta_conexao.pausa_ate)
//  O Reportei continua com os numeros; a Meta nunca sobrescreve numero.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const { banco, descriptografar } = require("./_seguranca.js");
const olhos = require("./_olhos.js");
const cerebro = require("./_cerebro.js");

const GRAPH = "https://graph.facebook.com/v23.0";
const DIA_MS = 24 * 3600 * 1000;
const LIMITE_USO = 75;                 // % do limite da Meta: acima disso, pausa
const PAUSA_PADRAO_MIN = 60;
const CAPAS_MS = DIA_MS;               // as capas da Meta vencem: renova 1 vez por dia (anuncios dos ultimos 30 dias)
const ANTIGOS_MS = 5 * DIA_MS;
const MAX_ANUNCIOS_RODADA = 25;
const COMENTARIOS_MS = 3 * DIA_MS;
const DEMOGRAFIA_MS = 7 * DIA_MS;
const REELS_RECENTE_MS = 14 * DIA_MS;  // tempo assistido ainda muda: atualiza 1 vez por dia ate 14 dias
const NOVA_TENTATIVA_MS = 3 * DIA_MS;  // video que nao deu para transcrever: tenta de novo depois
const MAX_FALAS_POSTS = 3, MAX_FALAS_ANUNCIOS = 2, ESPERA_FALAS_MS = 60000;
const MAX_FICHAS_ANALISE = 2;          // fichas de campeoes feitas durante a analise (o resto sai na rodada do cerebro)
const LIMITE_BYTES = 24 * 1024 * 1024;  // limite do Whisper
const LIMITE_VIDEO = 40 * 1024 * 1024;  // limite para baixar (os olhos aceitam ate 40 MB)
const VISITAS_MS = 6 * 3600 * 1000;

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
function espera(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Baixa o video e manda para o Whisper
async function baixar(url, limite) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("Nao consegui baixar o video");
    if (num(r.headers.get("content-length")) > (limite || LIMITE_BYTES)) throw new Error("Video grande demais");
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > (limite || LIMITE_BYTES)) throw new Error("Video grande demais");
    return buf;
}
// frases que o Whisper inventa em video so com musica
function falaInventada(t) { const s = String(t || "").trim(); return !s || (s.length < 90 && /amara\.org|legendas pela comunidade|obrigad[oa] por assistir|inscreva-se no canal|legenda adriana/i.test(s)); }
async function transcrever(url, buf) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Sem chave da OpenAI");
    if (!buf) buf = await baixar(url, LIMITE_BYTES);
    // video grande: manda so o audio (fica bem menor)
    let nome = "video.mp4", tipo = "video/mp4";
    if (buf.length > LIMITE_BYTES && olhos.disponivel()) { buf = await olhos.audioDoVideo(buf); nome = "audio.mp3"; tipo = "audio/mpeg"; }
    if (buf.length > LIMITE_BYTES) throw new Error("Video grande demais para transcrever");
    const form = new FormData();
    form.append("file", new Blob([buf], { type: tipo }), nome);
    form.append("model", "whisper-1");
    form.append("language", "pt");
    const t = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + apiKey }, body: form, signal: AbortSignal.timeout(50000) });
    const d = await t.json().catch(function () { return {}; });
    if (!t.ok) throw new Error((d.error && d.error.message) || "Erro ao transcrever");
    const txt = String(d.text || "").trim();
    return falaInventada(txt) ? "" : txt;
}

// ---------- o que falta de uma loja ----------
// met = contas_meta.metricas (numeros do Reportei); anterior = contas_meta.meta (o que ja veio da Meta)
// Devolve o cache atualizado. Se a Meta nao estiver conectada ou estiver pausada, devolve o anterior.
async function enriquecerLoja(met, anterior, userId, opcoes) {
    const objetivo = opcoes && opcoes.objetivo;
    const cache = Object.assign({}, anterior || {}, { em: (anterior && anterior.em) || null, erro: (anterior && anterior.erro) || null, sem_pulo: !!(anterior && anterior.sem_pulo), posts: Object.assign({}, anterior && anterior.posts), anuncios: Object.assign({}, anterior && anterior.anuncios), ig_id: (anterior && anterior.ig_id) || "", demografia: (anterior && anterior.demografia) || null });
    const con = await conexao();
    if (!con || con.pausada) return { cache: cache, pendentes: [] };
    const token = con.token;
    const agora = new Date().toISOString();
    // collab em que a loja foi convidada: a Meta nao entrega tempo assistido nem comentarios a quem nao criou o post
    const posts = ((met && met.organico && met.organico.posts) || []).filter(function (p) { return ehCodigo(p.id) && !p.collab; });
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
        // 1) anuncios: capa, texto e titulo (1 consulta por anuncio, uma de cada vez, no maximo 25 por rodada)
        //    anuncio novo: sempre; dos ultimos 30 dias: 1 vez por dia (as capas da Meta vencem); mais antigos: a cada 5 dias
        const recentes = {};
        ((met.anuncios && met.anuncios.p30 && met.anuncios.p30.anuncios) || []).forEach(function (a) { recentes[a.id] = 1; });
        const adsPedir = ads.filter(function (a) { const c = cache.anuncios[a.id]; return !c || velho(c.em, recentes[a.id] ? CAPAS_MS : ANTIGOS_MS); })
            .sort(function (a, b) { return (cache.anuncios[a.id] ? 1 : 0) - (cache.anuncios[b.id] ? 1 : 0) || num(b.gasto) - num(a.gasto); })
            .slice(0, MAX_ANUNCIOS_RODADA);
        const postsDaLoja = {};
        posts.forEach(function (p) { postsDaLoja[p.id] = p; });
        const campos = "thumbnail_url,image_url,video_id,body,title,object_story_spec,effective_instagram_media_id";
        let tamanhoOk = true;
        for (const a of adsPedir) {
            if (sem.ads) break;
            try {
                // capa em tamanho maior; se a Meta nao aceitar o tamanho, pede a capa padrao
                let d;
                if (tamanhoOk) {
                    try { d = await g("/" + a.id, { fields: "creative.thumbnail_width(600).thumbnail_height(600){" + campos + "}" }, token); }
                    catch (e) { if (e instanceof MetaPausada || semPermissao(e)) throw e; tamanhoOk = false; }
                }
                if (!d) d = await g("/" + a.id, { fields: "creative{" + campos + "}" }, token);
                const c = (d && d.creative) || {}, oss = c.object_story_spec || {}, vd = oss.video_data || {}, ld = oss.link_data || {};
                const antes = cache.anuncios[a.id] || {};
                const x = cache.anuncios[a.id] = Object.assign({}, antes, {
                    em: agora,
                    miniatura: c.image_url || vd.image_url || c.thumbnail_url || antes.miniatura || "",
                    texto: corta(c.body || vd.message || ld.message || "", 600),
                    titulo: corta(c.title || vd.title || ld.name || "", 140),
                    video_id: c.video_id || vd.video_id || "",
                    ig_media_id: c.effective_instagram_media_id || ""
                });
                // anuncio feito a partir de um post: capa e link do post (do Reportei quando o post e da loja; senao, 1 consulta na primeira vez)
                const ig = x.ig_media_id, doPost = ig && postsDaLoja[ig];
                if (doPost) {
                    if (doPost.miniatura) x.miniatura = doPost.miniatura;
                    if (doPost.link) x.post_link = doPost.link;
                } else if (ig && !antes.post_link) {
                    try {
                        const m = await g("/" + ig, { fields: "thumbnail_url,media_url,media_type,permalink" }, token);
                        x.miniatura = m.thumbnail_url || (m.media_type === "IMAGE" ? m.media_url : "") || x.miniatura;
                        x.post_link = m.permalink || "";
                    } catch (e) { falhou("post do anuncio " + a.id, e, "nenhum"); }
                }
            } catch (e) { falhou("anuncio " + a.id, e, "ads"); }
        }

        if (objetivo === "conversas_visitas" && !sem.ads) {
            try { await visitasDosAnuncios(cache, met, token); } catch (e) { falhou("visitas dos anuncios", e, "ads"); }
        }

        // link oficial de cada post (1 consulta por post, uma vez so): o link que vem do Reportei pode apontar para outro post
        for (const p of posts.filter(function (p) { return (cache.posts[p.id] || {}).permalink === undefined; }).slice(0, 30)) {
            if (sem.ig) break;
            try {
                const d = await g("/" + p.id, { fields: "permalink" }, token);
                post(p.id).permalink = d.permalink || "";
            } catch (e) { falhou("link do post " + p.id, e, "ig"); }
        }

        // 2) Reels: tempo medio assistido e taxa de pulo nos 3 primeiros segundos
        //    (1 consulta por Reels; recentes 1 vez por dia, antigos 1 vez so; a taxa de pulo entrou na API em dez/2025)
        const reels = posts.filter(function (p) {
            if (p.tipo !== "Reels") return false;
            const c = cache.posts[p.id] || {};
            if (!c.ins_em) return true;
            if (c.pulo_pct === undefined && !cache.sem_pulo) return true;
            return p.data && Date.now() - new Date(p.data).getTime() < REELS_RECENTE_MS && velho(c.ins_em, DIA_MS);
        }).slice(0, 15);
        function valor(d, nome) {
            const m = (d.data || []).find(function (x) { return x.name === nome; }) || {};
            return m.total_value ? m.total_value.value : (m.values && m.values[0] ? m.values[0].value : null);
        }
        for (const p of reels) {
            try {
                let d = null;
                if (!cache.sem_pulo) {
                    try { d = await g("/" + p.id + "/insights", { metric: "ig_reels_avg_watch_time,reels_skip_rate" }, token); }
                    catch (e) {
                        // metrica que esta conta ou versao nao entrega: nao pede de novo
                        if (e instanceof MetaPausada || semPermissao(e) || Number(e.meta && e.meta.code) !== 100) throw e;
                        cache.sem_pulo = true;
                    }
                }
                if (!d) d = await g("/" + p.id + "/insights", { metric: "ig_reels_avg_watch_time" }, token);
                // a taxa de pulo pode vir como 0,25 ou 25
                const ms = num(valor(d, "ig_reels_avg_watch_time")), pulo = valor(d, "reels_skip_rate");
                Object.assign(post(p.id), { tempo_medio_s: ms ? Math.round(ms / 100) / 10 : null, pulo_pct: pulo == null ? null : Math.round((num(pulo) <= 1 ? num(pulo) * 100 : num(pulo)) * 10) / 10, ins_em: agora });
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

        // 4) publico: idade, genero e cidades de quem segue (1 vez por semana; a Meta so entrega com 100 seguidores ou mais)
        if (!sem.ig && posts.length && velho(cache.demografia && cache.demografia.em, DEMOGRAFIA_MS)) {
            try {
                if (!cache.ig_id) cache.ig_id = ((await g("/" + posts[0].id, { fields: "owner" }, token)).owner || {}).id || "";
                if (cache.ig_id) {
                    const dem = { em: agora };
                    for (const b of ["age", "gender", "city"]) {
                        try {
                            const d = await g("/" + cache.ig_id + "/insights", { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown: b }, token);
                            const res = (((d.data || [])[0] || {}).total_value || {}).breakdowns;
                            dem[b] = ((res && res[0] && res[0].results) || []).map(function (x) { return { chave: (x.dimension_values || []).join(" "), valor: num(x.value) }; })
                                .sort(function (a, c) { return c.valor - a.valor; }).slice(0, b === "city" ? 8 : 12);
                        } catch (e) { if (e instanceof MetaPausada || semPermissao(e)) throw e; dem[b] = []; }
                    }
                    cache.demografia = dem;
                }
            } catch (e) { falhou("publico", e, "ig"); }
        }
    } catch (e) {
        if (!(e instanceof MetaPausada)) throw e;
    }

    cache.em = agora;
    const faltam = [sem.ig ? "o Instagram" : "", sem.ads ? "a conta de anúncios" : ""].filter(Boolean);
    cache.erro = faltam.length ? "A Meta não enxerga " + faltam.join(" nem ") + " desta loja com o seu acesso." : null;

    // 4) fichas dos campeoes (fala lida e video assistido) e, com o que sobrar, a fala dos outros Reels acima da media
    const pendentes = [];
    if (Date.now() >= pausadoAte) {
        const fichas = alvosDaLoja(met, cache, objetivo).filter(function (x) { return x.tipo === "post" ? !sem.ig : !sem.ads; }).slice(0, MAX_FICHAS_ANALISE);
        const jaVai = {};
        fichas.forEach(function (x) { jaVai[x.id] = 1; });
        if (fichas.length) pendentes.push(fazerFichas(userId, met, cache, fichas, token).catch(function (e) { console.error("[meta] fichas: " + (e && e.message)); }));
        const reelsBons = sem.ig ? [] : posts.filter(function (p) { const c = cache.posts[p.id] || {}; return !jaVai[p.id] && p.tipo === "Reels" && num(p.indice) >= 1 && !c.transcricao && !c.sem_fala && velho(c.fala_erro_em, NOVA_TENTATIVA_MS); })
            .sort(function (a, b) { return num(b.indice) - num(a.indice); }).slice(0, MAX_FALAS_POSTS);
        const adsBons = sem.ads ? [] : ads.filter(function (a) { const c = cache.anuncios[a.id] || {}; return !jaVai[a.id] && !(c.ig_media_id && jaVai[c.ig_media_id]) && (c.ig_media_id || c.video_id) && !c.transcricao && !c.sem_fala && velho(c.fala_erro_em, NOVA_TENTATIVA_MS); })
            .sort(function (a, b) { return num(b.resultados) - num(a.resultados) || num(b.gasto) - num(a.gasto); }).slice(0, MAX_FALAS_ANUNCIOS);
        const falaDoPost = {};
        reelsBons.forEach(function (p) {
            pendentes.push(falaDoPost[p.id] = (async function () {
                const alvo = post(p.id);
                try {
                    const x = await g("/" + p.id, { fields: "media_url" }, token);
                    if (!x.media_url) throw new Error("sem link do video");
                    guardarFala(alvo, await transcrever(x.media_url));
                } catch (e) { alvo.fala_erro_em = new Date().toISOString(); console.error("[meta] fala do post " + p.id + ": " + (e && e.message)); }
            })());
        });
        adsBons.forEach(function (a) {
            pendentes.push((async function () {
                const alvo = cache.anuncios[a.id];
                // o mesmo video ja transcrito (ou sendo transcrito agora) como post: reaproveita
                if (alvo.ig_media_id && falaDoPost[alvo.ig_media_id]) await falaDoPost[alvo.ig_media_id];
                const doPost = alvo.ig_media_id && cache.posts[alvo.ig_media_id] && cache.posts[alvo.ig_media_id].transcricao;
                if (doPost) { alvo.transcricao = doPost; return; }
                try {
                    let url = "";
                    if (alvo.ig_media_id) url = (await g("/" + alvo.ig_media_id, { fields: "media_url,media_type" }, token)).media_url || "";
                    if (!url && alvo.video_id) url = (await g("/" + alvo.video_id, { fields: "source" }, token)).source || "";
                    if (!url) throw new Error("sem link do video");
                    guardarFala(alvo, await transcrever(url));
                } catch (e) { alvo.fala_erro_em = new Date().toISOString(); console.error("[meta] fala do anuncio " + a.id + ": " + (e && e.message)); }
            })());
        });
    }
    return { cache: cache, pendentes: pendentes };
}

// ---------- fichas dos campeoes ----------
function guardarFala(alvo, txt) {
    if (txt) { alvo.transcricao = corta(txt, 3000); delete alvo.sem_fala; }
    else alvo.sem_fala = true;   // video so com musica: nao tenta de novo
    delete alvo.fala_erro_em;
}
// os campeoes (api/_cerebro.js) que ainda nao tem ficha, olhando os numeros com o que ja veio da Meta
function alvosDaLoja(met, cache, objetivo) {
    const copia = JSON.parse(JSON.stringify(met || {}));
    aplicarMeta(copia, cache);
    return cerebro.alvosDeFicha(cerebro.mapaCampeoes(copia, objetivo), copia, cache);
}
// baixa cada video uma vez: le a fala (Whisper) e assiste (olhos); 2 ao mesmo tempo
async function fazerFichas(userId, met, cache, alvos, token, prazo) {
    const posts = {}, ads = {};
    ((met && met.organico && met.organico.posts) || []).forEach(function (p) { posts[p.id] = p; });
    ((met && met.anuncios && met.anuncios.p90 && met.anuncios.p90.anuncios) || []).forEach(function (a) { ads[a.id] = a; });
    let feitas = 0;
    for (let i = 0; i < alvos.length; i += 2) {
        if (prazo && Date.now() > prazo) break;
        await Promise.all(alvos.slice(i, i + 2).map(async function (x) {
            const alvo = x.tipo === "post" ? (cache.posts[x.id] = cache.posts[x.id] || {}) : (cache.anuncios[x.id] = cache.anuncios[x.id] || {});
            const agora = new Date().toISOString();
            try {
                let url = "";
                if (x.tipo === "post" && posts[x.id] && posts[x.id].collab && cache.ig_id) url = (((await g("/" + cache.ig_id, { fields: "collaborative_media_search.media_id(" + x.id + "){media_url}" }, token)) || {}).collaborative_media_search || {}).media_url || "";
                else if (x.tipo === "post") url = (await g("/" + x.id, { fields: "media_url" }, token)).media_url || "";
                else {
                    if (alvo.ig_media_id) url = (await g("/" + alvo.ig_media_id, { fields: "media_url,media_type" }, token)).media_url || "";
                    if (!url && alvo.video_id) url = (await g("/" + alvo.video_id, { fields: "source" }, token)).source || "";
                }
                if (!url) throw new Error("sem link do video");
                const buf = await baixar(url, LIMITE_VIDEO);
                if (x.fala) {
                    try { guardarFala(alvo, await transcrever(url, buf)); }
                    catch (e) { alvo.fala_erro_em = agora; console.error("[meta] fala do campeao " + x.id + ": " + (e && e.message)); }
                }
                if (x.olhos && !olhos.disponivel()) alvo.olhos_erro_em = agora;   // sem a ferramenta de video: tenta de novo em 3 dias
                else if (x.olhos) {
                    const it = x.tipo === "post" ? posts[x.id] : ads[x.id];
                    try {
                        alvo.visual = await olhos.olharVideo(url, userId, { legenda: x.tipo === "post" ? (it && it.legenda) : (alvo.texto || (it && it.nome)), fala: alvo.transcricao }, buf);
                        delete alvo.olhos_erro_em;
                    } catch (e) { alvo.olhos_erro_em = agora; console.error("[meta] olhos do campeao " + x.id + ": " + (e && e.message)); }
                }
                feitas++;
            } catch (e) {
                if (e instanceof MetaPausada) throw e;
                if (x.fala) alvo.fala_erro_em = agora;
                if (x.olhos) alvo.olhos_erro_em = agora;
                console.error("[meta] ficha do campeao " + x.id + ": " + (e && e.message));
            }
        }));
    }
    return feitas;
}
// rodada do cerebro (api/atualizar.js): faz ate "limite" fichas e, se a loja mede por visitas, as visitas
// devolve { cache, feitas, faltam, sem_meta }
async function fichasDaLoja(userId, met, anterior, objetivo, limite, prazo) {
    const cache = Object.assign({}, anterior || {}, { posts: Object.assign({}, anterior && anterior.posts), anuncios: Object.assign({}, anterior && anterior.anuncios) });
    const con = await conexao();
    if (!con || con.pausada) return { cache: cache, feitas: 0, faltam: 0, sem_meta: true };
    let visitas = false;
    if (objetivo === "conversas_visitas") {
        try { visitas = await visitasDosAnuncios(cache, met, con.token); } catch (e) { if (e instanceof MetaPausada) return { cache: cache, feitas: 0, faltam: 0, sem_meta: true }; console.error("[meta] visitas: " + (e && e.message)); }
    }
    const alvos = alvosDaLoja(met, cache, objetivo);
    let feitas = 0;
    try { feitas = await fazerFichas(userId, met, cache, alvos.slice(0, limite), con.token, prazo); }
    catch (e) { if (!(e instanceof MetaPausada)) throw e; }
    return { cache: cache, feitas: feitas, visitas: visitas, faltam: Math.max(0, alvos.length - limite) };
}

// ---------- visitas ao perfil por anuncio (a Meta manda nas "acoes" do anuncio) ----------
function diaSPLocal(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
function faixasDasVisitas(hoje) {
    const fim = diaSPLocal(hoje), out = {};
    [["p7", 7], ["p30", 30], ["p90", 90]].forEach(function (p) { out[p[0]] = { since: diaSPLocal(new Date(hoje.getTime() - (p[1] - 1) * DIA_MS)), until: fim }; });
    const mes = fim.slice(0, 7), dia1 = new Date(mes + "-01T12:00:00Z"), ultimoAnt = diaSPLocal(new Date(dia1.getTime() - DIA_MS));
    out.mes = { since: mes + "-01", until: fim };
    out.mes_ant = { since: ultimoAnt.slice(0, 7) + "-01", until: ultimoAnt };
    return out;
}
const RE_VISITA = /profile_visit|profile_view|ig_profile|instagram_profile/i;
async function visitasDosAnuncios(cache, met, token) {
    if (!velho(cache.visitas && cache.visitas.em, VISITAS_MS)) return false;
    const ads = ((met && met.anuncios && met.anuncios.p90 && met.anuncios.p90.anuncios) || []).filter(function (a) { return ehCodigo(a.id); });
    if (!ads.length) return false;
    if (!cache.conta_ads) cache.conta_ads = String((await g("/" + ads[0].id, { fields: "account_id" }, token)).account_id || "");
    if (!cache.conta_ads) return false;
    const faixas = faixasDasVisitas(new Date()), out = { em: new Date().toISOString() }, tipos = {};
    for (const k of Object.keys(faixas)) {
        const por = {};
        let d = await g("/act_" + cache.conta_ads + "/insights", { level: "ad", fields: "ad_id,actions", time_range: JSON.stringify(faixas[k]), limit: 500 }, token);
        for (let pag = 0; pag < 4 && d; pag++) {
            (d.data || []).forEach(function (l) {
                (l.actions || []).forEach(function (ac) { tipos[ac.action_type] = 1; if (RE_VISITA.test(ac.action_type)) por[l.ad_id] = (por[l.ad_id] || 0) + num(ac.value); });
            });
            d = d.paging && d.paging.next ? await g(d.paging.next, null, null) : null;
        }
        out[k] = por;
    }
    out.tipos = Object.keys(tipos).sort().slice(0, 60);
    cache.visitas = out;
    return true;
}

// grava o cache da Meta juntando com o que outra rodada gravou no meio tempo (nada se perde)
function juntarMeta(atual, novo) {
    if (!atual) return novo;
    if (!novo) return atual;
    const out = Object.assign({}, atual, novo);
    ["posts", "anuncios"].forEach(function (k) {
        const o = Object.assign({}, atual[k]);
        Object.keys(novo[k] || {}).forEach(function (id) { o[id] = Object.assign({}, atual[k] && atual[k][id], novo[k][id]); });
        out[k] = o;
    });
    return out;
}
async function salvarMeta(userId, cache) {
    const id = encodeURIComponent(userId);
    let atual = null;
    try { const r = await banco("contas_meta?user_id=eq." + id + "&select=meta"); atual = r && r[0] && r[0].meta; } catch (e) { /* grava o que tem */ }
    const final = juntarMeta(atual, cache);
    await banco("contas_meta?user_id=eq." + id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { meta: final } });
    return final;
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
        if (c.permalink) p.link = c.permalink;
        if (c.tempo_medio_s) p.tempo_medio_s = c.tempo_medio_s;
        if (c.pulo_pct != null) p.retencao_3s = Math.round((100 - c.pulo_pct) * 10) / 10;
        if (c.transcricao) p.transcricao = c.transcricao;
        if (c.visual) p.visual = c.visual;
    });
    ["p7", "p30", "p90", "mes", "mes_ant"].forEach(function (per) {
        ((met.anuncios && met.anuncios[per] && met.anuncios[per].anuncios) || []).forEach(function (a) {
            const c = ca[a.id]; if (!c) return;
            if (c.miniatura) a.miniatura = c.miniatura;
            if (c.texto) a.texto = c.texto;
            if (c.titulo) a.titulo = c.titulo;
            if (c.post_link) a.post_link = c.post_link;
            if (c.ig_media_id && cp[c.ig_media_id] && cp[c.ig_media_id].permalink) a.post_link = cp[c.ig_media_id].permalink;
            if (c.ig_media_id && porId[c.ig_media_id]) a.post_id = c.ig_media_id;
            const fala = c.transcricao || (c.ig_media_id && cp[c.ig_media_id] && cp[c.ig_media_id].transcricao);
            if (fala) a.transcricao = fala;
            const visual = c.visual || (c.ig_media_id && cp[c.ig_media_id] && cp[c.ig_media_id].visual);
            if (visual) a.visual = visual;
        });
        // visitas ao perfil (so na loja medida por conversas e visitas)
        const vis = cache.visitas && cache.visitas[per], bloco = met.anuncios && met.anuncios[per];
        if (vis && bloco) {
            let total = 0;
            (bloco.anuncios || []).forEach(function (a) { a.visitas = Math.max(num(a.visitas), num(vis[a.id])); total += a.visitas; });
            if (bloco.totais) bloco.totais.visitas = total;
        }
    });
    return met;
}

// quem segue a loja, em porcentagem, para os agentes (vem da Meta, 1 vez por semana)
function textoDemografia(cache) {
    const d = cache && cache.demografia;
    if (!d) return "";
    function pct(lista, nome) {
        const tot = (lista || []).reduce(function (s, x) { return s + x.valor; }, 0);
        if (!tot) return "";
        return nome + ": " + lista.map(function (x) { return (x.chave === "F" ? "mulheres" : x.chave === "M" ? "homens" : x.chave === "U" ? "não informado" : String(x.chave).replace(/, [^,]*\(state\)$/i, "")) + " " + Math.round(x.valor / tot * 100) + "%"; }).join(", ");
    }
    const idades = (d.age || []).slice().sort(function (a, b) { return String(a.chave).localeCompare(String(b.chave)); });
    return [pct(idades, "Idade"), pct(d.gender, "Gênero"), pct(d.city, "Cidades (das principais)")].filter(Boolean).join(" | ");
}

// comentarios reais guardados, dos melhores posts para os outros
function comentariosDaLoja(met, cache) {
    if (!cache || !cache.posts) return [];
    const posts = ((met && met.organico && met.organico.posts) || []).slice().sort(function (a, b) { return num(b.indice) - num(a.indice); });
    const out = [];
    posts.forEach(function (p) { const c = cache.posts[p.id]; if (c && c.comentarios) c.comentarios.forEach(function (t) { out.push(t); }); });
    return out.slice(0, 60);
}

module.exports = { g, conexao, limparEstado, enriquecerLoja, esperarFalas, aplicarMeta, comentariosDaLoja, textoDemografia, transcrever, fichasDaLoja, salvarMeta, juntarMeta, MetaPausada, _interno: { usoDe, ehLimite, falaInventada, faixasDasVisitas, alvosDaLoja } };
