// =====================================================================
//  "GERAR MAIS IDEIAS" (tela Ideias do app)
//  A dona pede uma nova leva de ideias de conteudo para a propria loja.
//  So o Agente de Ideias roda, com o que o time ja estudou (sem nova
//  analise nem consulta a Meta). Limite de 3 levas por dia por loja.
// =====================================================================

const { SUPA_URL, SUPA_ANON } = require("./_seguranca.js");
const { gerarMaisIdeias, ErroIdeias } = require("./_time-agentes.js");

// quem esta pedindo (o token do login da propria dona)
async function usuarioDoToken(jwt) {
    if (!jwt) return null;
    const r = await fetch(SUPA_URL + "/auth/v1/user", { headers: { apikey: SUPA_ANON, Authorization: "Bearer " + jwt } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let u;
    try { u = await usuarioDoToken(jwt); } catch (e) { u = null; }
    if (!u) return res.status(401).json({ error: "Entre na sua conta de novo." });
    try {
        return res.status(200).json(await gerarMaisIdeias(u.id));
    } catch (e) {
        if (e instanceof ErroIdeias) return res.status(e.status).json({ error: e.message });
        console.error("[ideias] " + u.id + ": " + (e && e.message));
        return res.status(500).json({ error: "Não consegui gerar ideias agora. Tente de novo em alguns minutos." });
    }
};
