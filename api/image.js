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
    const prompt = req.body && req.body.prompt;
    if (!prompt) return res.status(400).json({ error: "Prompt obrigatorio" });
    const allowedSizes = { "1024x1024": 1, "1024x1536": 1, "1536x1024": 1 };
    const size = (req.body && allowedSizes[req.body.size]) ? req.body.size : "1024x1536";
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 55000);
        const r = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey
            },
            body: JSON.stringify({
                model: "gpt-image-1",
                prompt: prompt,
                size: size,
                quality: "medium",
                n: 1
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Erro ao gerar imagem" });
        const b64 = d.data && d.data[0] && d.data[0].b64_json;
        if (!b64) return res.status(500).json({ error: "Imagem nao retornada" });
        return res.status(200).json({ b64: b64 });
    } catch (e) {
        if (e.name === "AbortError") return res.status(504).json({ error: "A geracao da imagem demorou demais. Tente novamente." });
        return res.status(500).json({ error: e.message });
    }
};

module.exports.config = {
    api: {
        bodyParser: {
            sizeLimit: "2mb"
        }
    }
};
