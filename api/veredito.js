// =====================================================================
//  "COMO MELHORAR ESTE VIDEO" (detalhe de um post ou anuncio)
//  O veredito simples (prendeu no comeco, perdeu no meio) e calculado no
//  app, na hora. Aqui a IA le os numeros do video comparados com a media
//  da conta, a fala e o texto, e devolve o que manter e 3 correcoes para
//  o proximo video parecido. Fica guardado 7 dias (tabela vereditos).
// =====================================================================

const { banco, acessoLiberado, SEM_ACESSO } = require("./_seguranca.js");
const { conversa: T } = require("./_time-agentes.js");

const GUARDA_MS = 7 * 24 * 3600 * 1000;
const ESQ = T.objeto({
    resumo: T.textoPT("Uma frase para a dona: onde o vídeo ganha e onde perde gente, com os números comparados com a média da conta."),
    manter: T.textoPT("O que manter no próximo vídeo parecido, 1 frase."),
    correcoes: T.listaPT("Exatamente 3 correções concretas para o próximo vídeo parecido, cada uma dizendo o que fazer na gravação (exemplo: mostrar a peça vestida já no primeiro segundo).")
});
function mediana(v) { const a = v.filter(function (x) { return isFinite(x) && x > 0; }).sort(function (x, y) { return x - y; }); if (!a.length) return 0; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function n(x) { return x == null ? "sem dado" : String(Math.round(x * 10) / 10).replace(".", ","); }

module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let uid;
    try { uid = await acessoLiberado(jwt); } catch (e) { return res.status(500).json({ error: "Não consegui confirmar o seu acesso. Tente de novo." }); }
    if (!uid) return res.status(jwt ? 403 : 401).json({ error: jwt ? SEM_ACESSO : "Entre na sua conta de novo." });
    const b = req.body || {}, tipo = b.tipo === "ad" ? "ad" : "org", idItem = String(b.id || "").slice(0, 200);
    if (!idItem) return res.status(400).json({ error: "Vídeo não informado." });
    const chave = tipo + ":" + idItem, id = encodeURIComponent(uid);
    try {
        const guardado = await banco("vereditos?user_id=eq." + id + "&chave=eq." + encodeURIComponent(chave) + "&select=resposta,criado_em").catch(function () { return []; });
        if (guardado && guardado[0] && Date.now() - new Date(guardado[0].criado_em).getTime() < GUARDA_MS) return res.status(200).json(guardado[0].resposta);
        const contas = await banco("contas_meta?user_id=eq." + id + "&select=metricas,dossie");
        const met = (contas && contas[0] && contas[0].metricas) || {}, dossie = (contas && contas[0] && contas[0].dossie) || {};
        let texto;
        if (tipo === "org") {
            const posts = (met.organico && met.organico.posts) || [], p = posts.find(function (x) { return String(x.id) === idItem; });
            if (!p) return res.status(404).json({ error: "Não achei esse post nos números da loja." });
            const fala = (((dossie.organico && dossie.organico.videos) || []).find(function (v) { return v.link && v.link === p.link; }) || {}).transcricao || p.transcricao || "";
            const med = function (k) { return mediana(posts.map(function (x) { return Number(x[k]); })); };
            texto = "POST ORGÂNICO (" + (p.tipo || "Post") + ") comparado com a média da conta:\n" +
                "ficaram nos 3 primeiros segundos: " + n(p.retencao_3s) + "% (média " + n(med("retencao_3s")) + "%)\n" +
                "tempo médio assistido: " + n(p.tempo_medio_s) + " s (média " + n(med("tempo_medio_s")) + " s)\n" +
                "engajamento: " + n(p.indice) + "x a média | alcance " + (p.alcance || 0) + " (média " + n(med("alcance")) + ")\n" +
                "compartilhamentos " + (p.compartilhamentos || 0) + " (média " + n(med("compartilhamentos")) + ") | salvamentos " + (p.salvamentos || 0) + " (média " + n(med("salvamentos")) + ")\n" +
                "legenda: " + T.corta(p.legenda, 500) + (fala ? "\nfala do vídeo: " + T.corta(fala, 1200) : "");
        } else {
            const a90 = (met.anuncios && met.anuncios.p90) || {}, ads = a90.anuncios || [], a = ads.find(function (x) { return String(x.id) === idItem; });
            if (!a) return res.status(404).json({ error: "Não achei esse anúncio nos números da loja." });
            const md = a90.medias || {};
            texto = "ANÚNCIO comparado com a média da conta:\n" +
                "pararam para ver (gancho de 3 segundos): " + n(a.taxa_gancho) + "% (média " + n(md.taxa_gancho) + "%)\n" +
                "assistiram até o fim: " + n(a.retencao) + "% (média " + n(md.retencao) + "%)\n" +
                "clicaram: " + n(a.ctr) + "% (média " + n(md.ctr) + "%)\n" +
                "resultados: " + (a.resultados || 0) + " | investido R$ " + n(a.gasto) + (a.custo_por_resultado ? " | custo por resultado R$ " + n(a.custo_por_resultado) : "") + (a.receita ? " | vendeu R$ " + n(a.receita) : "") + "\n" +
                "nome: " + T.corta(a.nome, 200) + (a.texto ? "\ntexto do anúncio: " + T.corta(a.texto, 500) : "") + (a.transcricao ? "\nfala do vídeo: " + T.corta(a.transcricao, 1200) : "");
        }
        const r = await T.perguntar(uid, {
            nome: "Como melhorar o video", esquema: ESQ, max: 3000, modelo: "claude-sonnet-5", effort: "low",
            pedido: "Você é a consultora do MCP Studio olhando um vídeo desta loja com a dona. Diga, em linguagem simples, onde o vídeo prendeu e onde perdeu gente, comparando com a média da conta, e dê 3 correções práticas para o próximo vídeo parecido. Use só os números abaixo; sem dado, não chute.\n\n" + texto
        });
        await banco("vereditos", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: { user_id: uid, chave: chave, resposta: r, criado_em: new Date().toISOString() } }).catch(function () {});
        return res.status(200).json(r);
    } catch (e) {
        console.error("[veredito] " + uid + ": " + (e && e.message));
        return res.status(500).json({ error: /credit balance/i.test((e && e.message) || "") ? "O MCP Studio está sem créditos de IA agora. Avise a equipe." : "Não consegui analisar o vídeo agora. Tente de novo." });
    }
};
