// =====================================================================
//  LOJAS DE REFERENCIA (so leitura)
//  A dona escolhe ate 5 perfis publicos que admira. Pela conta comercial
//  da propria loja, a Meta deixa ler os posts publicos desses perfis
//  (business_discovery): curtidas, comentarios, legenda e capa.
//  Guardamos os 6 melhores de cada perfil (contas_meta.referencias) e o
//  time usa como inspiracao de formato, nunca para copiar.
//  So funciona com perfil comercial ou de criador (limite da Meta).
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const { banco } = require("./_seguranca.js");
const { g, conexao } = require("./_meta-leitura.js");

const REF_MS = 7 * 24 * 3600 * 1000;   // atualiza 1 vez por semana
function corta(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; }
function mediana(v) { const a = v.filter(function (x) { return x > 0; }).sort(function (x, y) { return x - y; }); if (!a.length) return 0; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }

function limparNomes(lista) {
    return (Array.isArray(lista) ? lista : String(lista || "").split(/[\s,;]+/))
        .map(function (s) { return String(s || "").trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").replace(/^@/, "").toLowerCase(); })
        .filter(function (s, i, v) { return /^[a-z0-9._]{1,30}$/.test(s) && v.indexOf(s) === i; })
        .slice(0, 5);
}

async function buscarPerfil(igId, token, usuario) {
    const campos = "business_discovery.username(" + usuario + "){username,name,followers_count,media_count,media.limit(30){caption,like_count,comments_count,timestamp,media_type,media_product_type,permalink,media_url,thumbnail_url}}";
    const d = await g("/" + igId, { fields: campos }, token);
    const b = d.business_discovery || {};
    const posts = ((b.media && b.media.data) || []).map(function (m) {
        return {
            legenda: corta(m.caption, 300), curtidas: Number(m.like_count) || 0, comentarios: Number(m.comments_count) || 0, link: m.permalink || "",
            capa: m.thumbnail_url || (m.media_type === "VIDEO" ? "" : m.media_url) || "", data: m.timestamp || null,
            tipo: m.media_product_type === "REELS" ? "Reels" : m.media_type === "CAROUSEL_ALBUM" ? "Carrossel" : m.media_type === "VIDEO" ? "Vídeo" : "Foto"
        };
    });
    // comentario vale o dobro; o indice compara com a media do proprio perfil
    const med = mediana(posts.map(function (p) { return p.curtidas + p.comentarios * 2; }));
    posts.forEach(function (p) { p.indice = med > 0 ? Math.round((p.curtidas + p.comentarios * 2) / med * 10) / 10 : 0; });
    return { username: b.username || usuario, nome: b.name || "", seguidores: Number(b.followers_count) || 0, posts: posts.sort(function (a, c) { return c.indice - a.indice; }).slice(0, 6) };
}

async function atualizarReferencias(userId, nomes) {
    const id = encodeURIComponent(userId);
    const out = { em: new Date().toISOString(), perfis: [] };
    if (nomes.length) {
        const contas = await banco("contas_meta?user_id=eq." + id + "&select=meta").catch(function () { return []; });
        const igId = contas && contas[0] && contas[0].meta && contas[0].meta.ig_id;
        const cx = await conexao().catch(function () { return null; });
        if (!igId) out.erro = "Ainda não temos a conta do Instagram da loja ligada à Meta. Assim que o time analisar a conta, as referências aparecem.";
        else if (!cx || cx.pausada) out.erro = "A leitura da Meta está pausada agora. As referências aparecem na próxima atualização.";
        else {
            for (const u of nomes) {
                try { out.perfis.push(await buscarPerfil(igId, cx.token, u)); }
                catch (e) {
                    const m = String((e && e.message) || "");
                    out.perfis.push({ username: u, erro: /business|not found|cannot be found|invalid user|does not exist/i.test(m) ? "Esse perfil não existe ou não é comercial. A Meta só deixa acompanhar perfis comerciais ou de criador." : "Não consegui ler esse perfil agora." });
                }
            }
        }
    }
    if (out.erro || (out.perfis.length && out.perfis.every(function (p) { return p.erro; }))) out.em = new Date(Date.now() - REF_MS + 6 * 3600 * 1000).toISOString();
    await banco("contas_meta?user_id=eq." + id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { referencias: out } }).catch(function () {});
    return out;
}

// para o time de agentes: so o formato e os numeros, sem copiar
function textoReferencias(ref) {
    const perfis = ((ref && ref.perfis) || []).filter(function (p) { return (p.posts || []).length; });
    if (!perfis.length) return "";
    return "\n\nLOJAS DE REFERÊNCIA QUE A DONA ADMIRA (inspiração de formato e de gancho; nunca copie texto, peça ou preço, e nunca cite a outra loja):\n" +
        perfis.map(function (p) {
            return "@" + p.username + (p.seguidores ? " (" + p.seguidores + " seguidores)" : "") + ": " + p.posts.slice(0, 4).map(function (x) { return "[" + x.tipo + ", " + String(x.indice).replace(".", ",") + "x a média do perfil] " + corta(x.legenda, 140); }).join(" | ");
        }).join("\n");
}

module.exports = { limparNomes, atualizarReferencias, textoReferencias, REF_MS };
