// =====================================================================
//  CONVERSA COM O TIME (aba "Pedir ao time" nas Ideias e nos Roteiros)
//  A dona escreve o que quer ("ideias para o Dia das Criancas", "sem
//  aparecer o rosto", "deixe o gancho do roteiro 2 mais curto") e o time
//  responde com ideias ou roteiros prontos, usando os dados e a memoria
//  da loja. Cada pedido fica guardado (tabela conversas): o Agente de
//  Memoria le esses pedidos para entender o gosto dela.
//  Limite de 15 pedidos por dia por loja.
// =====================================================================

const { banco, acessoLiberado, SEM_ACESSO } = require("./_seguranca.js");
const { diaSP } = require("./_coleta.js");
const { SISTEMA: AGENTE_MCP } = require("./_agente-mcp.js");
const { conversa: T } = require("./_time-agentes.js");

const MAX_DIA = 15;
const FORMATOS = ["curto", "narrado", "provador"];

function limpa(t, n) { return String(t || "").replace(/\u0000/g, "").trim().slice(0, n); }
function historicoEmTexto(h) {
    const linhas = (Array.isArray(h) ? h : []).slice(-6).map(function (m) { return (m && m.papel === "time" ? "TIME: " : "DONA: ") + limpa(m && m.texto, 1500); }).filter(function (l) { return l.length > 6; });
    return linhas.length ? "\n\nCONVERSA ATÉ AGORA:\n" + linhas.join("\n") : "";
}
async function pedidosHoje(uid) {
    const inicio = new Date(diaSP(new Date()) + "T00:00:00-03:00").toISOString();
    const r = await banco("conversas?user_id=eq." + encodeURIComponent(uid) + "&criado_em=gte." + encodeURIComponent(inicio) + "&select=id");
    return (r || []).length;
}

// ---------- ideias ----------
const ESQ_IDEIAS = T.objeto({
    resposta: T.textoPT("Resposta curta para a dona, em até 3 frases, no tom de uma consultora próxima."),
    ideias: {
        type: "array", description: "De 1 a 4 ideias completas quando ela pedir ideias ou mudança numa ideia. Lista vazia quando for só uma pergunta.",
        items: T.objeto(Object.assign({ formato: { type: "string", enum: FORMATOS } }, T.ESQ_ESPECIALISTA.properties.ideias.items.properties))
    }
});
async function conversarIdeias(uid, pedido, historico) {
    const ctx = await T.carregar(uid), dossie = ctx.dossie;
    if (!ctx.met || !(dossie.organico || dossie.anuncios || dossie.publico)) { const e = new Error("O time de agentes ainda está estudando a sua conta. Assim que a análise terminar, dá para conversar com ele."); e.status = 409; throw e; }
    await T.preparar(ctx, false);
    const p = { org: dossie.organico && dossie.organico.relatorio, ads: dossie.anuncios && dossie.anuncios.relatorio, pub: dossie.publico };
    const naTela = ((dossie.ideias && dossie.ideias.lista) || []).slice(0, 15);
    const texto = "Você é o TIME DE CRIAÇÃO do MCP Studio conversando direto com a dona desta loja pelo app. Ela pode pedir ideias novas, mudar uma ideia que já está na tela dela, ou tirar uma dúvida.\n" +
        "- Pedido de ideias ou de mudança: entregue de 1 a 4 ideias completas, no mesmo padrão dos especialistas abaixo, com o formato certo (curto, narrado ou provador). Se ela citar uma ideia da tela, reescreva essa ideia aplicando o pedido.\n" +
        "- Dúvida ou conversa: responda em até 3 frases e deixe a lista de ideias vazia.\n" +
        "- O pedido dela vale mais que as regras gerais, desde que não invente preço, produto, depoimento ou número.\n\n" +
        "COMO É CADA FORMATO\n" + T.FORMATOS_TEXTO() +
        T.regrasDasIdeias(ctx, []).replace(/\n- Entregue 6 ideias[^\n]*/, "") + T.contextoDasIdeias(ctx, p) +
        (naTela.length ? "\n\nIDEIAS QUE JÁ ESTÃO NA TELA DELA:\n" + naTela.map(function (x, i) { return (i + 1) + ") " + (x.formato || "") + " | " + x.titulo + (x.gancho ? " | gancho: " + T.corta(x.gancho, 160) : ""); }).join("\n") : "") +
        historicoEmTexto(historico) + "\n\nPEDIDO DA DONA AGORA: " + pedido;
    const r = await T.perguntar(uid, { chave: "chat_ideias", nome: "Chat de ideias", esquema: ESQ_IDEIAS, pedido: texto, max: 12000 });
    const mapa = T.mapaDeCodigos(ctx);
    const ideias = (r.ideias || []).slice(0, 4).map(function (x) {
        const insp = x.inspirado_em && mapa[String(x.inspirado_em).trim().toUpperCase()];
        const f = FORMATOS.indexOf(x.formato) > -1 ? x.formato : "curto";
        return { titulo: x.titulo, formato: f, formatos: [f === "curto" ? "rápido com transições" : f], gancho: x.gancho, como_fazer: x.gancho, passos: x.passos || [], texto_na_tela: x.texto_na_tela || "", fala: x.fala || "", stories: x.stories || [], duracao_s: x.duracao_s || null, peca: x.peca || "", inspirado: insp || null, por_que: x.por_que, metrica: x.metrica, funil: x.funil, metodo: x.metodo, origem: "conversa" };
    });
    // as ideias do chat entram no topo da tela de ideias, marcadas como novas
    if (ideias.length) {
        const ant = dossie.ideias || {};
        const lista = ideias.map(function (i) { return Object.assign({ nova: true }, i); }).concat((ant.lista || []).map(function (i) { const c = Object.assign({}, i); delete c.nova; return c; })).slice(0, 60);
        await banco("contas_meta?user_id=eq." + encodeURIComponent(uid), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { dossie: Object.assign({}, dossie, { ideias: Object.assign({}, ant, { lista: lista }) }), memoria: T.comSugeridas(ctx.memoria, ideias) } });
    }
    return { resposta: r.resposta || "", ideias: ideias };
}

// ---------- roteiros ----------
const ESQ_ROTEIROS = T.objeto({
    resposta: T.textoPT("Resposta curta para a dona, em até 3 frases, no tom de uma consultora próxima."),
    roteiros: {
        type: "array", description: "De 1 a 3 roteiros quando ela pedir roteiro novo ou mudança num roteiro. Lista vazia quando for só uma pergunta.",
        items: T.objeto({
            base: { type: "string", description: "Número do roteiro do projeto que foi reescrito, ou vazio quando for um roteiro novo." },
            titulo: T.textoPT("Título curto do roteiro."),
            gancho: T.textoPT("O gancho: o que aparece e o que é dito nos primeiros segundos."),
            corpo: T.textoPT("O corpo do roteiro, com as cenas e a fala."),
            cta: T.textoPT("A chamada final."),
            funil: { type: "string", enum: ["topo", "meio", "fundo"] }
        })
    }
});
async function conversarRoteiros(uid, pedido, historico, projetoId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(projetoId || ""))) { const e = new Error("Abra um projeto de roteiros para conversar sobre ele."); e.status = 400; throw e; }
    const [ctx, projs] = await Promise.all([
        T.carregar(uid),
        banco("projetos?id=eq." + encodeURIComponent(projetoId) + "&user_id=eq." + encodeURIComponent(uid) + "&select=id,nome,objetivo,form,rodadas")
    ]);
    const proj = projs && projs[0];
    if (!proj) { const e = new Error("Não achei esse projeto."); e.status = 404; throw e; }
    const roteiros = [];
    (proj.rodadas || []).forEach(function (rod) { ((rod.resultado && rod.resultado.roteiros) || []).forEach(function (s) { roteiros.push(s); }); });
    const f = proj.form || {};
    const dossie = ctx.dossie || {};
    const texto = "Você está conversando direto com a dona desta loja pelo app, dentro de um projeto de roteiros. Ela pode pedir roteiros novos, mudar um roteiro do projeto ou tirar uma dúvida.\n" +
        "- Pedido de mudança num roteiro: reescreva esse roteiro aplicando o pedido e diga em base o número dele.\n" +
        "- Pedido de roteiro novo: entregue de 1 a 3 roteiros completos, com base vazio.\n" +
        "- Dúvida ou conversa: responda em até 3 frases e deixe a lista de roteiros vazia.\n" +
        "- O pedido dela vale mais que as regras gerais, desde que não invente preço, produto, depoimento ou número.\n" +
        "- Nada de palavras em inglês (só Reels, stories, direct, close e POV) e nada de termo técnico: frases curtas e simples, como uma consultora falando com a dona.\n\n" +
        "PROJETO: " + T.corta(proj.nome, 120) + (proj.objetivo ? " | objetivo: " + T.corta(proj.objetivo, 120) : "") +
        "\nSOBRE A PEÇA: " + T.corta([f.produto, f.descricao, f.diferenciais, f.preco ? "preço: " + f.preco : ""].filter(Boolean).join(" | "), 1500) +
        (dossie.texto ? "\n\nDOSSIÊ DA LOJA (do time de agentes): " + T.corta(dossie.texto, 1800) : "") +
        T.textoMemoria(ctx.memoria) + T.textoGosto(ctx) +
        "\n\nROTEIROS DO PROJETO:\n" + roteiros.slice(-15).map(function (s) { return s.id + ") " + T.corta(s.titulo, 100) + " | GANCHO: " + T.corta(s.gancho, 300) + " | CORPO: " + T.corta(s.corpo, 700) + " | CTA: " + T.corta(s.cta, 200); }).join("\n") +
        historicoEmTexto(historico) + "\n\nPEDIDO DA DONA AGORA: " + pedido;
    const r = await T.perguntar(uid, { chave: "chat_roteiros", nome: "Chat de roteiros", esquema: ESQ_ROTEIROS, pedido: texto, max: 12000, sistema: AGENTE_MCP });
    const ids = {};
    roteiros.forEach(function (s) { ids[String(s.id)] = 1; });
    return {
        resposta: r.resposta || "",
        roteiros: (r.roteiros || []).slice(0, 3).map(function (s) { const b = String(s.base || "").replace(/\D/g, ""); return { base: ids[b] ? Number(b) : null, titulo: s.titulo, gancho: s.gancho, corpo: s.corpo, cta: s.cta, funil: s.funil }; })
    };
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let uid;
    try { uid = await acessoLiberado(jwt); } catch (e) { return res.status(500).json({ error: "Não consegui confirmar o seu acesso. Tente de novo." }); }
    if (!uid) return res.status(jwt ? 403 : 401).json({ error: jwt ? SEM_ACESSO : "Entre na sua conta de novo." });
    const b = req.body || {};
    const area = b.area === "roteiros" ? "roteiros" : "ideias";
    const pedido = limpa(b.pedido, 1000);
    if (pedido.length < 3) return res.status(400).json({ error: "Escreva o que você quer pedir ao time." });
    try {
        const feitos = await pedidosHoje(uid);
        if (feitos >= MAX_DIA) return res.status(429).json({ error: "Você já fez " + MAX_DIA + " pedidos hoje. Amanhã o time volta a responder!" });
        const out = area === "roteiros" ? await conversarRoteiros(uid, pedido, b.historico, b.projeto_id) : await conversarIdeias(uid, pedido, b.historico);
        await banco("conversas", { method: "POST", headers: { Prefer: "return=minimal" }, body: { user_id: uid, area: area, projeto_id: area === "roteiros" ? String(b.projeto_id) : null, pedido: pedido, resposta: { texto: out.resposta, ideias: (out.ideias || []).map(function (i) { return i.titulo; }), roteiros: (out.roteiros || []).map(function (s) { return s.titulo; }) } } }).catch(function (e) { console.error("[conversa] gravar: " + (e && e.message)); });
        return res.status(200).json(Object.assign({ ok: true, restam_hoje: MAX_DIA - feitos - 1 }, out));
    } catch (e) {
        if (e && e.status) return res.status(e.status).json({ error: e.message });
        console.error("[conversa] " + uid + ": " + (e && e.message));
        return res.status(500).json({ error: /credit balance/i.test((e && e.message) || "") ? "O time está sem créditos de IA agora. Avise a equipe do MCP Studio." : "Não consegui responder agora. Tente de novo em alguns minutos." });
    }
};
