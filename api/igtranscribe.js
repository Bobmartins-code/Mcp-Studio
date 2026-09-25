// a transcricao em si fica em api/_transcricao.js (o time de agentes usa a mesma)
const { transcreverReel, linkValido } = require("./_transcricao.js");

module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Sem chave da OpenAI. Configure OPENAI_API_KEY no Vercel." });
    // Exige sessao valida do Supabase
    const SUPA_URL = "https://yutqrrcdlkocrpznryqi.supabase.co";
    const SUPA_ANON = "sb_publishable_U3wOTwbeEvXtHOqP_I29VQ_ARH5CAkH";
    const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
    const token = (authHeader && authHeader.indexOf("Bearer ") === 0) ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Nao autenticado" });
    try {
        const ur = await fetch(SUPA_URL + "/auth/v1/user", {
            headers: { apikey: SUPA_ANON, Authorization: "Bearer " + token }
        });
        if (!ur.ok) return res.status(401).json({ error: "Sessao invalida ou expirada." });
    } catch (e) {
        return res.status(401).json({ error: "Falha ao validar sessao" });
    }

    const url = req.body && req.body.url;
    if (!linkValido(url)) {
        return res.status(400).json({ error: "Link do Instagram invalido", needFile: true });
    }
    try {
        const text = await transcreverReel(url);
        return res.status(200).json({ text: text });
    } catch (e) {
        return res.status((e && e.status) || 500).json({ error: (e && e.message) || "Erro ao processar o link", needFile: true });
    }
};

module.exports.config = {
    api: {
        bodyParser: {
            sizeLimit: "1mb"
        }
    }
};
