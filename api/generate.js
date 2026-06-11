module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Sem chave API" });
    // Exige sessao valida do Supabase — impede uso anonimo da chave da IA
    const SUPA_URL = "https://yutqrrcdlkocrpznryqi.supabase.co";
    const SUPA_ANON = "sb_publishable_U3wOTwbeEvXtHOqP_I29VQ_ARH5CAkH";
    const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
    const token = (authHeader && authHeader.indexOf("Bearer ") === 0) ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Nao autenticado" });
    try {
        const ur = await fetch(SUPA_URL + "/auth/v1/user", {
            headers: { apikey: SUPA_ANON, Authorization: "Bearer " + token }
        });
        if (!ur.ok) return res.status(401).json({ error: "Sessao invalida ou expirada. Faca login novamente." });
    } catch (e) {
        return res.status(401).json({ error: "Falha ao validar sessao" });
    }
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
    // Ferramentas nativas (ex: web_fetch para ler URLs) — repassadas quando enviadas
    const tools = (req.body && Array.isArray(req.body.tools) && req.body.tools.length) ? req.body.tools : null;
    const wantStream = !!(req.body && req.body.stream) && !tools;

    // CAMINHO STREAMING: envia o texto da IA chegando ao vivo (sensacao de chat)
    if (wantStream) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 58000);
        let r;
        try {
            r = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
                body: JSON.stringify({
                    model: model,
                    max_tokens: maxTokens,
                    system: "Voce gera JSON puro sem markdown. REGRA CRITICA: NUNCA use aspas duplas dentro dos valores de texto. Use apenas aspas simples quando precisar de citacao dentro de um texto. Todo o JSON deve ser valido e parseable.",
                    messages: messages,
                    stream: true
                }),
                signal: controller.signal
            });
        } catch (e) {
            clearTimeout(timeout);
            return res.status(500).json({ error: e.message });
        }
        if (!r.ok || !r.body) {
            clearTimeout(timeout);
            let errTxt = ""; try { errTxt = await r.text(); } catch (_) {}
            return res.status(r.status || 500).json({ error: "Erro na IA", detail: errTxt.slice(0, 400) });
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.flushHeaders) res.flushHeaders();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for await (const part of r.body) {
                buffer += decoder.decode(part, { stream: true });
                let idx;
                while ((idx = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (line.indexOf("data:") === 0) {
                        const payload = line.slice(5).trim();
                        if (!payload || payload === "[DONE]") continue;
                        try {
                            const ev = JSON.parse(payload);
                            if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta.text === "string") {
                                res.write(ev.delta.text);
                            }
                        } catch (_) {}
                    }
                }
            }
        } catch (e) { /* stream interrompido — cliente trata o que recebeu */ }
        clearTimeout(timeout);
        return res.end();
    }

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
            body: JSON.stringify(Object.assign({
                model: model,
                max_tokens: maxTokens,
                system: "Voce gera JSON puro sem markdown. REGRA CRITICA: NUNCA use aspas duplas dentro dos valores de texto. Use apenas aspas simples quando precisar de citacao dentro de um texto. Todo o JSON deve ser valido e parseable.",
                messages: messages
            }, tools ? { tools: tools } : {})),
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
