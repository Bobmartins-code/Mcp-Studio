// =====================================================================
//  PAINEL DE RESULTADOS DA LOJA (aba Resultados do app)
//  Tudo direto da Meta, so leitura (GET), na hora em que a loja abre:
//    - resultados do periodo: investido, vendas, funil dos anuncios, conversas
//      (Direct ou WhatsApp), anuncios x organico, visitas ao perfil e quem compra
//    - anuncios ativos agora: situacao, gasto de hoje e resultado
//    - um anuncio ativo aberto, no periodo escolhido
//  Cada resposta fica guardada alguns minutos para nao repetir consulta a Meta.
//  Fica em /api com "_" no nome: nao vira rota publica (a rota e api/meta.js).
// =====================================================================

const { banco } = require("./_seguranca.js");
const meta = require("./_meta-leitura.js");

const TIPOS_COMPRA = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
const TIPO_CONVERSA = ["onsite_conversion.messaging_conversation_started_7d"];
// "Novos contatos de mensagem" no Gerenciador: quem falou com a loja pela primeira vez
const TIPO_NOVO_CONTATO = ["onsite_conversion.messaging_first_reply"];
const TIPO_ENGAJAMENTO = ["page_engagement", "post_engagement"];
const GUARDA_PAINEL_MS = 10 * 60000, GUARDA_ATIVOS_MS = 2 * 60000, GUARDA_ANUNCIO_MS = 10 * 60000;
const DIA = 864e5;

// ---------- apoio ----------
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function centavos(n) { return Math.round(num(n) * 100) / 100; }
function acao(lista, tipos) {
    const l = lista || [];
    for (const t of tipos) { const a = l.find(function (x) { return x.action_type === t; }); if (a) return num(a.value); }
    return 0;
}
function diaSP(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d); }

// periodo do app: 7, 30 ou 90 dias (contando hoje), este mes ou o mes anterior inteiro
function faixaDoPeriodo(per) {
    const hoje = new Date(), fim = diaSP(hoje);
    const p = String(per);
    if (p === "7" || p === "30" || p === "90") return { per: p, inicio: diaSP(new Date(hoje.getTime() - (Number(p) - 1) * DIA)), fim: fim };
    if (p === "mes") return { per: p, inicio: fim.slice(0, 7) + "-01", fim: fim };
    if (p === "mes_ant") { const ult = diaSP(new Date(new Date(fim.slice(0, 7) + "-01T12:00:00Z").getTime() - DIA)); return { per: p, inicio: ult.slice(0, 7) + "-01", fim: ult }; }
    throw Object.assign(new Error("Período inválido."), { status: 400 });
}
function intervalo(f) { return JSON.stringify({ since: f.inicio, until: f.fim }); }

// guarda por alguns minutos (por servidor): a mesma loja abrindo de novo nao consulta a Meta outra vez
const guardados = new Map();
async function guardado(chave, ms, fn) {
    const g = guardados.get(chave);
    if (g && g.ate > Date.now()) return g.valor;
    const valor = await fn();
    if (guardados.size > 300) guardados.clear();
    guardados.set(chave, { ate: Date.now() + ms, valor: valor });
    return valor;
}

// cada parte que falhar fica vazia (null) e a tela esconde o bloco; o resto aparece
// visitas ao perfil pelos anuncios: o campo novo (numero ou lista de acoes) ou, se vier, uma acao de visita ao perfil
const RE_VISITA = /profile_visit|ig_profile|instagram_profile/i;
function visitasDosAnuncios(linhas, conta) {
    const r = linhas && linhas[0], v = r && r.instagram_profile_visits;
    if (Array.isArray(v)) return v.reduce(function (s, x) { return s + num(x && x.value); }, 0);
    if (v != null && v !== "") return num(v);
    const acoes = ((conta && conta[0] && conta[0].actions) || []).filter(function (x) { return RE_VISITA.test(x.action_type || ""); });
    return acoes.length ? acoes.reduce(function (s, x) { return s + num(x.value); }, 0) : null;
}
async function parte(nome, avisos, fn) {
    try { return await fn(); } catch (e) {
        if (e instanceof meta.MetaPausada) throw e;
        avisos.push(nome);
        console.error("[painel] " + nome + ": " + (e && e.message));
        return null;
    }
}

async function lojaDe(uid) {
    const id = encodeURIComponent(uid);
    const [contas, lojas] = await Promise.all([
        banco("contas_meta?user_id=eq." + id + "&select=ig_id,ad_account_id"),
        banco("lojas?user_id=eq." + id + "&select=objetivo_anuncios").catch(function () { return []; })
    ]);
    const c = (contas && contas[0]) || {};
    return {
        ig: /^\d{8,}$/.test(String(c.ig_id || "")) ? String(c.ig_id) : null,
        act: /^\d{5,}$/.test(String(c.ad_account_id || "").replace(/^act_/, "")) ? "act_" + String(c.ad_account_id).replace(/^act_/, "") : null,
        objetivo: (lojas && lojas[0] && lojas[0].objetivo_anuncios) || "auto"
    };
}
async function tokenOuErro() {
    const c = await meta.conexao();
    if (!c) throw Object.assign(new Error("A leitura da Meta está parada agora. A equipe do MCP Studio já foi avisada."), { status: 503 });
    if (c.pausada) throw Object.assign(new Error("A Meta pediu uma pausa nas consultas. Tente de novo em alguns minutos."), { status: 503 });
    return c.token;
}

// ---------- destino das conversas (Direct, WhatsApp ou Messenger), pelo conjunto de anuncios ----------
function destinoDe(tipo) {
    const t = String(tipo || "").toUpperCase();
    const w = t.indexOf("WHATSAPP") > -1, d = t.indexOf("INSTAGRAM_DIRECT") > -1, m = t.indexOf("MESSENGER") > -1;
    if (w && !d && !m) return "whatsapp";
    if (d && !w && !m) return "direct";
    if (m && !w && !d) return "messenger";
    if (w || d || m) return "varios";
    return "outros";
}

// ---------- quem compra: idade e regiao (so os totais que a Meta da) ----------
function faixasDe(linhas, campo, tipos) {
    const soma = {};
    (linhas || []).forEach(function (r) {
        const k = String(r[campo] || "").replace(/\s*\((state|province|region)\)\s*$/i, "").trim();
        if (!k || k === "Unknown" || k === "unknown") return;
        soma[k] = (soma[k] || 0) + acao(r.actions, tipos);
    });
    return Object.keys(soma).map(function (k) { return { nome: k, valor: soma[k] }; }).filter(function (x) { return x.valor > 0; });
}
const ORDEM_IDADE = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

// ---------- RESULTADOS DO PERIODO ----------
async function painel(uid, per) {
    const f = faixaDoPeriodo(per);
    return guardado(uid + "|painel|" + f.per + "|" + f.fim, GUARDA_PAINEL_MS, async function () {
        const loja = await lojaDe(uid);
        const out = { periodo: f, anuncios: null, conversas: null, organico: null, publico: null, em: new Date().toISOString(), sem_anuncios: !loja.act, sem_instagram: !loja.ig };
        if (!loja.act && !loja.ig) return out;
        const token = await tokenOuErro(), avisos = [];
        const ins = function (p) { return meta.g("/" + loja.act + "/insights", Object.assign({ time_range: intervalo(f), limit: 200 }, p), token).then(function (d) { return (d && d.data) || []; }); };

        const [conta, porIdade, porRegiao, porConjunto, porPlataforma, ig, visitasAds] = await Promise.all([
            loja.act ? parte("anúncios", avisos, function () { return ins({ level: "account", fields: "spend,impressions,reach,clicks,inline_link_clicks,actions,action_values" }); }) : null,
            loja.act ? parte("idade", avisos, function () { return ins({ level: "account", fields: "actions", breakdowns: "age" }); }) : null,
            loja.act ? parte("região", avisos, function () { return ins({ level: "account", fields: "actions", breakdowns: "region" }); }) : null,
            loja.act ? parte("conversas", avisos, function () { return ins({ level: "adset", fields: "adset_id,actions" }); }) : null,
            loja.act ? parte("plataformas", avisos, function () { return ins({ level: "account", fields: "impressions,reach", breakdowns: "publisher_platform" }); }) : null,
            loja.ig ? parte("instagram", avisos, function () { return instagramDoPeriodo(loja.ig, f, token); }) : null,
            // visitas ao perfil vindas dos anuncios: metrica nova da Meta (dez/2025), ainda nao liberada em toda conta;
            // se a Meta recusar, a tela fica so com o total (sem aviso)
            loja.act && loja.ig ? ins({ level: "account", fields: "instagram_profile_visits" }).catch(function (e) { if (e instanceof meta.MetaPausada) throw e; console.error("[painel] visitas dos anuncios: " + (e && e.message)); return null; }) : null
        ]);

        if (conta) {
            const r = conta[0] || {};
            out.anuncios = {
                gasto: centavos(r.spend), receita: centavos(acao(r.action_values, TIPOS_COMPRA)),
                impressoes: num(r.impressions), alcance: num(r.reach), cliques: num(r.clicks), cliques_link: num(r.inline_link_clicks),
                engajamento: acao(r.actions, TIPO_ENGAJAMENTO), compras: acao(r.actions, TIPOS_COMPRA), conversas: acao(r.actions, TIPO_CONVERSA),
                novos_contatos: acao(r.actions, TIPO_NOVO_CONTATO)
            };
        }

        // conversas e novos contatos por destino: cada conjunto de anuncios leva para um lugar (Direct, WhatsApp, Messenger ou varios)
        if (porConjunto && out.anuncios && (out.anuncios.conversas > 0 || out.anuncios.novos_contatos > 0)) {
            const com = porConjunto.filter(function (r) { return (acao(r.actions, TIPO_CONVERSA) > 0 || acao(r.actions, TIPO_NOVO_CONTATO) > 0) && /^\d+$/.test(String(r.adset_id || "")); });
            const destinos = await parte("destino das conversas", avisos, async function () {
                const mapa = {};
                for (let i = 0; i < com.length; i += 50) {
                    // a Meta nao aceita mais o "ids" (v26): pergunta pela propria conta, filtrando pelos conjuntos
                    const ids = com.slice(i, i + 50).map(function (r) { return r.adset_id; });
                    const d = await meta.g("/" + loja.act + "/adsets", { fields: "id,destination_type", filtering: JSON.stringify([{ field: "adset.id", operator: "IN", value: ids }]), limit: 50 }, token);
                    ((d && d.data) || []).forEach(function (s) { mapa[s.id] = s.destination_type; });
                }
                return mapa;
            });
            if (destinos) {
                const soma = { direct: 0, whatsapp: 0, messenger: 0, varios: 0, outros: 0 }, novos = Object.assign({}, soma);
                com.forEach(function (r) { const d = destinoDe(destinos[r.adset_id]); soma[d] += acao(r.actions, TIPO_CONVERSA); novos[d] += acao(r.actions, TIPO_NOVO_CONTATO); });
                out.conversas = soma;
                out.novos_contatos = novos;
            }
        }

        // quem compra (ou quem chama no direct, na loja medida por conversas)
        if (porIdade || porRegiao) {
            const compras = out.anuncios ? out.anuncios.compras : 0;
            const tipo = /^conversas/.test(loja.objetivo) || (loja.objetivo === "auto" && !compras) ? "conversas" : "compras";
            const tipos = tipo === "compras" ? TIPOS_COMPRA : TIPO_CONVERSA;
            const idade = faixasDe(porIdade, "age", tipos).sort(function (a, b) { return ORDEM_IDADE.indexOf(a.nome) - ORDEM_IDADE.indexOf(b.nome); });
            const regiao = faixasDe(porRegiao, "region", tipos).sort(function (a, b) { return b.valor - a.valor; });
            if (idade.length || regiao.length) out.publico = { tipo: tipo, idade: idade, regiao: regiao };
        }

        // anuncios x organico: o Instagram da o total da conta (com o que veio dos anuncios no Instagram);
        // o organico e o total menos os anuncios no Instagram (estimativa, como o Reportei faz)
        if (ig) {
            const noIg = (porPlataforma || []).find(function (r) { return r.publisher_platform === "instagram"; }) || null;
            const o = { seguidores: ig.seguidores, novos_seguidores: ig.novos_seguidores, visitas_perfil: ig.visitas_perfil, impressoes: null, alcance: null, alcance_aprox: true };
            // visitas: total do Instagram menos as que vieram dos anuncios (mesma estimativa das impressoes)
            const va = visitasDosAnuncios(visitasAds, conta);
            if (va != null && ig.visitas_perfil != null) { o.visitas_anuncios = va; o.visitas_organico = Math.max(0, ig.visitas_perfil - va); }
            if (ig.views != null) o.impressoes = Math.max(0, ig.views - (noIg ? num(noIg.impressions) : 0));
            if (ig.alcance != null) o.alcance = Math.max(0, ig.alcance - (noIg ? num(noIg.reach) : 0));
            o.total_instagram = { impressoes: ig.views, alcance: ig.alcance, anuncios_impressoes: noIg ? num(noIg.impressions) : null, anuncios_alcance: noIg ? num(noIg.reach) : null };
            out.organico = o;
        }
        if (avisos.length) out.faltou = avisos;
        console.log("[painel] " + uid.slice(0, 8) + " " + f.per + " " + JSON.stringify({ anuncios: out.anuncios, conversas: out.conversas, novos_contatos: out.novos_contatos, visitas_anuncios: out.organico ? out.organico.visitas_anuncios : null, ig: out.organico && out.organico.total_instagram, faltou: out.faltou || [] }));
        return out;
    });
}

// janelas de ate 30 dias (a Meta nao aceita mais que isso de uma vez nos numeros da conta)
function janelas(f) {
    const ini = new Date(f.inicio + "T00:00:00-03:00").getTime();
    const fim = Math.min(Date.now(), new Date(f.fim + "T00:00:00-03:00").getTime() + DIA);
    const out = [];
    for (let s = ini; s < fim; s += 30 * DIA) out.push([Math.floor(s / 1000), Math.floor(Math.min(fim, s + 30 * DIA) / 1000)]);
    return out;
}
function totalDe(d, nome) {
    const m = ((d && d.data) || []).find(function (x) { return x.name === nome; });
    return m && m.total_value ? num(m.total_value.value) : null;
}
async function instagramDoPeriodo(igId, f, token) {
    const js = janelas(f);
    const conta = await meta.g("/" + igId, { fields: "followers_count" }, token);
    const out = { seguidores: conta && conta.followers_count != null ? num(conta.followers_count) : null, views: null, alcance: null, visitas_perfil: null, novos_seguidores: null };
    // um numero de cada vez se o pedido junto falhar (a Meta recusa o pedido inteiro por um numero so)
    async function somar(metrica, extra) {
        let total = 0;
        for (const j of js) {
            const d = await meta.g("/" + igId + "/insights", Object.assign({ metric: metrica, period: "day", metric_type: "total_value", since: j[0], until: j[1] }, extra || {}), token);
            if (extra && extra.breakdown) {
                const m = ((d && d.data) || [])[0], res = (m && m.total_value && m.total_value.breakdowns && m.total_value.breakdowns[0] && m.total_value.breakdowns[0].results) || [];
                const seguiram = res.find(function (x) { return (x.dimension_values || [])[0] === "FOLLOWER"; });
                total += seguiram ? num(seguiram.value) : 0;
            } else total += totalDe(d, metrica) || 0;
        }
        return total;
    }
    const [views, alcance, visitas, novos] = await Promise.all([
        somar("views").catch(function (e) { console.error("[painel] ig views: " + e.message); return null; }),
        somar("reach").catch(function (e) { console.error("[painel] ig reach: " + e.message); return null; }),
        somar("profile_views").catch(function (e) { console.error("[painel] ig profile_views: " + e.message); return null; }),
        somar("follows_and_unfollows", { breakdown: "follow_type" }).catch(function (e) { console.error("[painel] ig follows: " + e.message); return null; })
    ]);
    out.views = views; out.alcance = alcance; out.visitas_perfil = visitas; out.novos_seguidores = novos;
    return out;
}

// ---------- ANUNCIOS ATIVOS AGORA ----------
// so o que esta ativo: em analise e com problema ficam de fora (decisao do dono, 22/10/2026)
const STATUS_VIVOS = ["ACTIVE"];
const MENSAGENS = /WHATSAPP|INSTAGRAM_DIRECT|MESSENGER/i;
function objetivoDe(campanha, conjunto) {
    if (MENSAGENS.test((conjunto && conjunto.destination_type) || "")) return "Mensagens";
    const o = String((campanha && campanha.objective) || "").toUpperCase();
    if (/SALES|CONVERSIONS|CATALOG/.test(o)) return "Vendas";
    if (/TRAFFIC|LINK_CLICKS/.test(o)) return "Tráfego";
    if (/ENGAGEMENT|VIDEO_VIEWS|PAGE_LIKES/.test(o)) return "Engajamento";
    if (/AWARENESS|REACH/.test(o)) return "Alcance";
    if (/LEADS|LEAD_GENERATION/.test(o)) return "Cadastros";
    if (/MESSAGES/.test(o)) return "Mensagens";
    return "Anúncio";
}
function situacaoDe(s) {
    if (s === "ACTIVE") return "ativo";
    if (s === "WITH_ISSUES") return "problema";
    return "analise";
}
// o anuncio so esta no ar se a campanha e o conjunto tambem estiverem (como a coluna Veiculacao do Gerenciador):
// ligados, ja comecados, sem data de termino vencida e com orcamento total sobrando
const PAI_NO_AR = ["ACTIVE"];
function foraDoAr(pai, nivel) {
    if (!pai) return null;
    const agora = Date.now(), fim = pai.end_time || pai.stop_time;
    if (pai.status && pai.status !== "ACTIVE") return nivel + ": desligado";
    if (pai.effective_status && PAI_NO_AR.indexOf(pai.effective_status) < 0) return nivel + ": " + String(pai.effective_status).toLowerCase();
    if (fim && new Date(fim).getTime() <= agora) return nivel + ": data de término passou";
    if (pai.start_time && new Date(pai.start_time).getTime() > agora) return nivel + ": ainda não começou";
    if (num(pai.lifetime_budget) > 0 && pai.budget_remaining != null && num(pai.budget_remaining) <= 0) return nivel + ": orçamento total acabou";
    return null;
}
// orcamento vem em centavos; no CBO fica na campanha
function orcamentoDe(campanha, conjunto) {
    const fonte = conjunto && (num(conjunto.daily_budget) || num(conjunto.lifetime_budget)) ? conjunto : campanha;
    if (!fonte) return null;
    if (num(fonte.daily_budget)) return { tipo: "dia", valor: num(fonte.daily_budget) / 100, de: fonte === conjunto ? "c" + conjunto.id : "p" + (campanha && campanha.id) };
    if (num(fonte.lifetime_budget)) return { tipo: "total", valor: num(fonte.lifetime_budget) / 100, de: fonte === conjunto ? "c" + conjunto.id : "p" + (campanha && campanha.id) };
    return null;
}
function resumoDe(r) {
    return r ? { gasto: centavos(r.spend), compras: acao(r.actions, TIPOS_COMPRA), conversas: acao(r.actions, TIPO_CONVERSA), receita: centavos(acao(r.action_values, TIPOS_COMPRA)) } : { gasto: 0, compras: 0, conversas: 0, receita: 0 };
}

async function ativos(uid) {
    return guardado(uid + "|ativos", GUARDA_ATIVOS_MS, async function () {
        const loja = await lojaDe(uid);
        if (!loja.act) return { sem_anuncios: true, lista: [], em: new Date().toISOString() };
        const token = await tokenOuErro();
        // cada anuncio vem com a campanha e o conjunto dele: so fica o que esta no ar nos 3 niveis
        const d = await meta.g("/" + loja.act + "/ads", {
            effective_status: JSON.stringify(STATUS_VIVOS), limit: 100,
            fields: "id,name,effective_status,created_time,adset{id,status,effective_status,start_time,end_time,daily_budget,lifetime_budget,budget_remaining,destination_type},campaign{id,status,effective_status,start_time,stop_time,objective,daily_budget,lifetime_budget,budget_remaining},creative.thumbnail_width(600).thumbnail_height(600){thumbnail_url,image_url,instagram_permalink_url}"
        }, token);
        const fora = {};
        const ads = ((d && d.data) || []).filter(function (a) {
            const motivo = foraDoAr(a.campaign, "campanha") || foraDoAr(a.adset, "conjunto");
            if (motivo) fora[motivo] = (fora[motivo] || 0) + 1;
            return !motivo;
        });
        if (Object.keys(fora).length) console.log("[painel] ativos " + uid.slice(0, 8) + ": fora do ar " + JSON.stringify(fora));
        const hoje = diaSP(new Date()), sete = diaSP(new Date(Date.now() - 6 * DIA));
        let porHoje = {}, porSete = {};
        if (ads.length) {
            const filtro = JSON.stringify([{ field: "ad.id", operator: "IN", value: ads.map(function (a) { return a.id; }) }]);
            const [h, s] = await Promise.all([
                meta.g("/" + loja.act + "/insights", { level: "ad", fields: "ad_id,spend,actions,action_values", time_range: JSON.stringify({ since: hoje, until: hoje }), filtering: filtro, limit: 100 }, token).catch(function (e) { console.error("[painel] ativos hoje: " + e.message); return null; }),
                meta.g("/" + loja.act + "/insights", { level: "ad", fields: "ad_id,spend,actions,action_values", time_range: JSON.stringify({ since: sete, until: hoje }), filtering: filtro, limit: 100 }, token).catch(function (e) { console.error("[painel] ativos 7 dias: " + e.message); return null; })
            ]);
            ((h && h.data) || []).forEach(function (r) { porHoje[r.ad_id] = r; });
            ((s && s.data) || []).forEach(function (r) { porSete[r.ad_id] = r; });
        }
        const orcamentos = {};
        const lista = ads.map(function (a) {
            const c = a.creative || {}, orc = orcamentoDe(a.campaign, a.adset);
            if (orc && a.effective_status === "ACTIVE" && orc.tipo === "dia") orcamentos[orc.de] = orc.valor;
            return {
                id: a.id, nome: a.name || "Anúncio", situacao: situacaoDe(a.effective_status), objetivo: objetivoDe(a.campaign, a.adset),
                desde: a.created_time || null, orcamento: orc ? { tipo: orc.tipo, valor: orc.valor } : null,
                capa: c.image_url || c.thumbnail_url || "", link: c.instagram_permalink_url || "",
                hoje: resumoDe(porHoje[a.id]), sete: resumoDe(porSete[a.id])
            };
        });
        // ativos primeiro, depois em analise e com problema; dentro de cada um, quem mais gastou hoje
        const peso = { ativo: 0, analise: 1, problema: 2 };
        lista.sort(function (x, y) { return peso[x.situacao] - peso[y.situacao] || y.hoje.gasto - x.hoje.gasto || y.sete.gasto - x.sete.gasto; });
        const tot = lista.reduce(function (t, x) { t.gasto += x.hoje.gasto; t.compras += x.hoje.compras; t.conversas += x.hoje.conversas; return t; }, { gasto: 0, compras: 0, conversas: 0 });
        tot.gasto = centavos(tot.gasto);
        tot.orcamento_dia = centavos(Object.keys(orcamentos).reduce(function (s, k) { return s + orcamentos[k]; }, 0));
        return { lista: lista, hoje: tot, em: new Date().toISOString() };
    });
}

// ---------- UM ANUNCIO, NO PERIODO ESCOLHIDO ----------
async function anuncio(uid, adId, per) {
    if (!/^\d{6,}$/.test(String(adId || ""))) throw Object.assign(new Error("Anúncio inválido."), { status: 400 });
    const f = faixaDoPeriodo(per);
    return guardado(uid + "|anuncio|" + adId + "|" + f.per + "|" + f.fim, GUARDA_ANUNCIO_MS, async function () {
        const loja = await lojaDe(uid);
        if (!loja.act) throw Object.assign(new Error("Esta loja ainda não tem conta de anúncios."), { status: 404 });
        const token = await tokenOuErro();
        const d = await meta.g("/" + adId, { fields: "account_id,insights.time_range(" + intervalo(f) + "){spend,reach,impressions,inline_link_clicks,actions,action_values}" }, token);
        // so a propria loja (ou o admin vendo a loja) abre o anuncio dela
        if (!d || "act_" + String(d.account_id || "") !== loja.act) throw Object.assign(new Error("Este anúncio não é desta loja."), { status: 403 });
        const r = ((d.insights && d.insights.data) || [])[0] || {};
        return {
            periodo: f, gasto: centavos(r.spend), receita: centavos(acao(r.action_values, TIPOS_COMPRA)), alcance: num(r.reach), impressoes: num(r.impressions),
            cliques_link: num(r.inline_link_clicks), compras: acao(r.actions, TIPOS_COMPRA), conversas: acao(r.actions, TIPO_CONVERSA), em: new Date().toISOString()
        };
    });
}

module.exports = { painel, ativos, anuncio, _interno: { faixaDoPeriodo, janelas, destinoDe, faixasDe, objetivoDe, orcamentoDe, situacaoDe, foraDoAr, guardados } };
