// =====================================================================
//  STORIES DE UMA LOJA (direto da Meta, so leitura)
//  A Meta so entrega os stories (e os numeros deles) enquanto estao no ar,
//  24 horas. Por isso, a cada atualizacao da loja, os stories no ar tem os
//  numeros lidos de novo e guardados na tabela stories; quando um story sai
//  do ar, ficam os ultimos numeros lidos (final = true). A capa e copiada
//  para o nosso armazenamento, porque o link da Meta vence em poucos dias.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const crypto = require("crypto");
const { banco, enviarArquivo } = require("./_seguranca.js");

// da lista mais completa para a mais simples (se a Meta recusar uma metrica, recusa o pedido todo)
const METRICAS = [
    "reach,views,replies,shares,total_interactions,follows,profile_visits,link_clicks",
    "reach,views,replies,shares,total_interactions,follows,profile_visits",
    "reach,replies,shares,total_interactions"
];
const NAVEGACAO = { tap_forward: "avancar", tap_back: "voltar", tap_exit: "sair", swipe_forward: "proximo" };

function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function codigoMeta(e) { return Number(e && e.meta && e.meta.code); }
// "(#10) Not enough viewers": story com menos de 5 visualizacoes nao tem numeros
function poucasVisualizacoes(e) { return codigoMeta(e) === 10 && /viewers|not enough/i.test(String(e && e.message)); }
function valor(m) { return num(m.total_value ? m.total_value.value : (m.values && m.values[0] ? m.values[0].value : 0)); }

async function numerosDoStory(g, id, token, estado) {
    const out = {};
    for (let n = estado.nivel; n < METRICAS.length; n++) {
        try {
            const d = await g("/" + id + "/insights", { metric: METRICAS[n] }, token);
            (d.data || []).forEach(function (m) { out[m.name] = valor(m); });
            estado.nivel = n;
            break;
        } catch (e) {
            if (poucasVisualizacoes(e)) return { poucos: true };
            if (codigoMeta(e) !== 100 || n === METRICAS.length - 1) throw e;
        }
    }
    try {
        const d = await g("/" + id + "/insights", { metric: "navigation", breakdown: "story_navigation_action_type" }, token);
        const m = (d.data || [])[0] || {};
        const res = (m.total_value && m.total_value.breakdowns && m.total_value.breakdowns[0] && m.total_value.breakdowns[0].results) || [];
        res.forEach(function (r) { const k = NAVEGACAO[String((r.dimension_values || [])[0] || "").toLowerCase()]; if (k) out[k] = num(r.value); });
    } catch (e) { if (!poucasVisualizacoes(e) && codigoMeta(e) !== 100) throw e; }
    return out;
}

// numeros prontos para a tela e para os agentes
function calcular(m) {
    const o = {
        alcance: num(m.reach), visualizacoes: num(m.views), respostas: num(m.replies), compartilhamentos: num(m.shares),
        interacoes: num(m.total_interactions), seguiram: num(m.follows), visitas_perfil: num(m.profile_visits), cliques_link: num(m.link_clicks),
        avancar: num(m.avancar), voltar: num(m.voltar), sair: num(m.sair), proximo: num(m.proximo)
    };
    if (m.poucos) o.poucos = true;
    // retencao como o Reportei mostra: quem nao saiu nem pulou para a proxima conta
    o.retencao = o.alcance > 0 ? Math.max(0, Math.round((1 - (o.sair + o.proximo) / o.alcance) * 1000) / 10) : null;
    return o;
}

async function guardarCapa(userId, s) {
    const url = s.media_type === "VIDEO" ? s.thumbnail_url : (s.media_url || s.thumbnail_url);
    if (!url) return "";
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return "";
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 5 * 1024 * 1024) return "";
    // nome que nao da para adivinhar
    return enviarArquivo("stories", userId + "/" + s.id + "-" + crypto.randomBytes(6).toString("hex") + ".jpg", buf, "image/jpeg");
}

// le os stories no ar da loja e grava; marca como finais os que sairam do ar. Devolve { no_ar, novos, sem_numeros }
async function coletarStories(userId, igId, token) {
    const { g, MetaPausada } = require("./_meta-leitura.js");
    const d = await g("/" + igId + "/stories", { fields: "id,media_type,media_url,thumbnail_url,permalink,timestamp", limit: 50 }, token);
    const vivos = (d.data || []).filter(function (s) { return s && s.id; });
    const id = encodeURIComponent(userId);
    const guardados = await banco("stories?user_id=eq." + id + "&final=eq.false&select=story_id,capa_url");
    const capa = {}, abertos = {};
    (guardados || []).forEach(function (x) { capa[x.story_id] = x.capa_url; abertos[x.story_id] = 1; });
    // capas que ja estao guardadas de stories que viraram finais (nao baixa de novo)
    const ids = vivos.map(function (s) { return String(s.id); }).filter(function (x) { return !(x in capa); });
    if (ids.length) {
        const ja = await banco("stories?user_id=eq." + id + "&story_id=in.(" + ids.map(encodeURIComponent).join(",") + ")&select=story_id,capa_url");
        (ja || []).forEach(function (x) { capa[x.story_id] = x.capa_url; });
    }
    const estado = { nivel: 0 }, agora = new Date().toISOString(), linhas = [];
    let novos = 0, semNumeros = 0;
    for (const s of vivos) {
        let m = {};
        try { m = await numerosDoStory(g, s.id, token, estado); }
        catch (e) { if (e instanceof MetaPausada) throw e; m = {}; console.error("[stories] " + s.id + ": " + (e && e.message)); }
        if (m.poucos) semNumeros++;
        const linha = { user_id: userId, story_id: String(s.id), publicado_em: s.timestamp ? new Date(s.timestamp).toISOString() : null, tipo: s.media_type === "VIDEO" ? "Vídeo" : "Foto", link: s.permalink || null, metricas: calcular(m), final: false, visto_em: agora };
        if (!capa[s.id]) {
            try { linha.capa_url = await guardarCapa(userId, s); } catch (e) { console.error("[stories] capa " + s.id + ": " + (e && e.message)); }
            novos++;
        }
        linhas.push(linha);
        delete abertos[s.id];
    }
    if (linhas.length) {
        // grava sem apagar a capa ja guardada (cada linha so leva capa_url quando e nova)
        const comCapa = linhas.filter(function (l) { return "capa_url" in l; }), semCapa = linhas.filter(function (l) { return !("capa_url" in l); });
        for (const grupo of [comCapa, semCapa]) {
            if (grupo.length) await banco("stories", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: grupo });
        }
    }
    // sairam do ar desde a ultima leitura: ficam os ultimos numeros
    const sairam = Object.keys(abertos);
    if (sairam.length) await banco("stories?user_id=eq." + id + "&story_id=in.(" + sairam.map(encodeURIComponent).join(",") + ")", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { final: true } });
    return { no_ar: vivos.length, novos: novos, sem_numeros: semNumeros, encerrados: sairam.length };
}

// resumo dos stories para os agentes (ultimos 30 dias)
function textoStories(lista, seguidores) {
    const com = (lista || []).filter(function (s) { return s.metricas && s.metricas.alcance > 0; });
    if (!com.length) return "";
    const soma = function (k) { return com.reduce(function (t, s) { return t + num(s.metricas[k]); }, 0); };
    const med = function (k) { return Math.round(soma(k) / com.length * 10) / 10; };
    const ret = com.filter(function (s) { return s.metricas.retencao != null; });
    const dias = {};
    com.forEach(function (s) { const d = String(s.publicado_em || "").slice(0, 10); if (d) dias[d] = 1; });
    function quando(s) { return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long" }).format(new Date(s.publicado_em)); }
    function linha(s, i) {
        const m = s.metricas;
        return "S" + (i + 1) + ") " + (s.tipo || "Story") + " de " + quando(s) + " | alcance " + m.alcance + " | respostas " + m.respostas + " | compartilhamentos " + m.compartilhamentos +
            (m.retencao != null ? " | retenção " + String(m.retencao).replace(".", ",") + "%" : "") + " | saíram " + m.sair + " | voltaram para rever " + m.voltar +
            (m.visitas_perfil ? " | visitas ao perfil " + m.visitas_perfil : "") + (m.cliques_link ? " | cliques no link " + m.cliques_link : "");
    }
    const porResposta = com.slice().sort(function (a, b) { return num(b.metricas.respostas) - num(a.metricas.respostas); }).slice(0, 5);
    const piores = ret.slice().sort(function (a, b) { return a.metricas.retencao - b.metricas.retencao; }).slice(0, 3);
    return "STORIES DOS ÚLTIMOS 30 DIAS (" + com.length + " stories em " + Object.keys(dias).length + (Object.keys(dias).length === 1 ? " dia" : " dias") + "; a Meta não entrega curtidas de story nem o que está escrito nele): " +
        "alcance médio " + med("alcance") + (seguidores ? " (" + Math.round(med("alcance") / seguidores * 1000) / 10 + "% das seguidoras)" : "") +
        ", respostas médias " + med("respostas") + ", compartilhamentos médios " + med("compartilhamentos") +
        (ret.length ? ", retenção média " + String(Math.round(ret.reduce(function (t, s) { return t + s.metricas.retencao; }, 0) / ret.length * 10) / 10).replace(".", ",") + "%" : "") +
        ".\nOS QUE MAIS GERARAM RESPOSTAS (conversa no direct começando):\n" + porResposta.map(linha).join("\n") +
        (piores.length ? "\nONDE MAIS GENTE SAIU:\n" + piores.map(linha).join("\n") : "");
}

module.exports = { coletarStories, textoStories, _interno: { calcular, numerosDoStory, poucasVisualizacoes } };
