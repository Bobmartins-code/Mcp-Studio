// =====================================================================
//  "GERAR MAIS IDEIAS" (tela Ideias do app)
//  A dona pede uma nova leva de ideias de conteudo para a propria loja.
//  So o Agente de Ideias roda, com o que o time ja estudou (sem nova
//  analise nem consulta a Meta). Limite de 3 levas por dia por loja.
// =====================================================================

const { acessoLiberado, SEM_ACESSO } = require("./_seguranca.js");
const { gerarMaisIdeias, ErroIdeias } = require("./_time-agentes.js");
const { registrarFalha } = require("./_uso-ia.js");


module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    // so quem o admin cadastrou (acesso fechado, como nas outras rotas de IA)
    let uid;
    try { uid = await acessoLiberado(jwt); } catch (e) { return res.status(500).json({ error: "Não consegui confirmar o seu acesso. Tente de novo." }); }
    if (!uid) return res.status(jwt ? 403 : 401).json({ error: jwt ? SEM_ACESSO : "Entre na sua conta de novo." });
    const u = { id: uid };
    try {
        return res.status(200).json(await gerarMaisIdeias(u.id));
    } catch (e) {
        if (e instanceof ErroIdeias) return res.status(e.status).json({ error: e.message });
        console.error("[ideias] " + u.id + ": " + (e && e.message));
        registrarFalha(u.id, "gerar mais ideias", e && e.message);
        return res.status(500).json({ error: "Não consegui gerar ideias agora. Tente de novo em alguns minutos." });
    }
};
