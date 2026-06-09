module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Sem chave API" });
    const messages = req.body && req.body.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "Messages obrigatorio" });
    }
    // Modelo escolhido pelo cliente (com allowlist) — default Haiku para custo baixo
    const ALLOWED_MODELS = {
        "claude-haiku-4-5-20251001": 1,
        "claude-sonnet-4-6": 1,
        "claude-opus-4-8": 1
    };
    const model = (req.body && ALLOWED_MODELS[req.body.model]) ? req.body.model : "claude-haiku-4-5-20251001";
    // Respeita max_tokens do cliente com teto de seguranca
    const reqMax = req.body && Number(req.body.max_tokens);
    const maxTokens = (reqMax && reqMax > 0) ? Math.min(reqMax, 8000) : 6000;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 55000);
        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: model,
                max_tokens: maxTokens,
                system: "Voce gera JSON puro sem markdown. REGRA CRITICA: NUNCA use aspas duplas dentro dos valores de texto. Use apenas aspas simples quando precisar de citacao dentro de um texto. Todo o JSON deve ser valido e parseable.",
                messages: messages
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const d = await r.json();
        return res.status(r.ok ? 200 : r.status).json(d);
    } catch(e) {
        if (e.name === "AbortError") {
            return res.status(504).json({ error: "A IA demorou demais. Tente novamente." });
        }
        return res.status(500).json({ error: e.message });
    }
};

module.exports.config = {
    api: {
        bodyParser: {
            sizeLimit: "10mb"
        }
    }
};
