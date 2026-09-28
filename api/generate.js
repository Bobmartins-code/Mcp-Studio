const { acessoLiberado, SEM_ACESSO, banco } = require("./_seguranca.js");
const LIMITE_DIA = 80; // pedidos por dia por loja nesta rota
const { registrarUso, registrarFalha } = require("./_uso-ia.js");
// Agente MCP: o cerebro do agente (quem ele e, como escreve e os metodos) fica em api/_agente-mcp.js
const { SISTEMA: AGENTE } = require("./_agente-mcp.js");
const FORMATO = "FORMATO DA RESPOSTA: quando o pedido for JSON, responda só com o JSON puro, sem markdown. Dentro dos textos, use aspas simples para citações, porque aspas duplas quebram o JSON e a cliente perde o resultado.";
const SYSTEM = AGENTE + " " + FORMATO;
// Garantia final: troca qualquer travessao que escape por virgula
function semTravessao(t) { return typeof t === "string" ? t.replace(/,?[ \t]*[\u2014\u2013][ \t]*/g, ", ") : t; }

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
    // acesso fechado: so quem o admin cadastrou usa a IA
    let quem;
    try { quem = await acessoLiberado(token); if (!quem) return res.status(403).json({ error: SEM_ACESSO }); }
    catch (e) { return res.status(500).json({ error: "Não consegui confirmar o seu acesso. Tente de novo." }); }
    const messages = req.body && req.body.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "Messages obrigatorio" });
    }
    // Os roteiros, o chat e as ideias rodam nas rotas proprias (com limites). Esta rota so atende
    // as tarefas pequenas do app (ler um link, variacoes de gancho): modelo Sonnet, texto limitado e teto diario.
    const funcao = "app: " + String((req.body && req.body.funcao) || "geral").replace(/[^a-z0-9 _-]/gi, "").slice(0, 30);
    let tamanho = 0;
    try { tamanho = JSON.stringify(messages).length; } catch (e) { tamanho = Infinity; }
    if (messages.length > 6 || tamanho > 60000) return res.status(413).json({ error: "O pedido ficou grande demais. Encurte o texto e tente de novo." });
    try {
        const inicioDia = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) + "T00:00:00-03:00").toISOString();
        const usos = await banco("uso_ia?user_id=eq." + encodeURIComponent(quem) + "&funcao=like.app*&criado_em=gte." + encodeURIComponent(inicioDia) + "&select=id");
        if ((usos || []).length >= LIMITE_DIA) return res.status(429).json({ error: "Você usou bastante a IA hoje. Amanhã tem mais!" });
    } catch (e) { /* sem conseguir contar, segue: o teto e uma protecao extra */ }
    const model = "claude-sonnet-5";
    const ALLOWED_EFFORT = { low: 1, medium: 1 };
    const effort = (req.body && ALLOWED_EFFORT[req.body.effort]) ? req.body.effort : "low";
    const extra = { output_config: { effort: effort } };
    const reqMax = req.body && Number(req.body.max_tokens);
    const maxTokens = (reqMax && reqMax > 0) ? Math.min(reqMax, 6000) : 4000;
    // Ferramenta nativa: so ler uma URL, e so no "ler link" (nada vindo do navegador passa direto)
    const FERRAMENTAS = { web_fetch_20260209: "web_fetch" };
    const pedidas = (req.body && Array.isArray(req.body.tools) && funcao === "app: ler link") ? req.body.tools : [];
    const tools = pedidas.filter(function (t) { return t && FERRAMENTAS[t.type]; }).slice(0, 1)
        .map(function (t) { return { type: t.type, name: FERRAMENTAS[t.type], max_uses: 2 }; });
    const usarFerramentas = tools.length > 0;
    const wantStream = !!(req.body && req.body.stream) && !usarFerramentas;

    // CAMINHO STREAMING: envia o texto da IA chegando ao vivo (sensacao de chat)
    if (wantStream) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 115000);
        let r;
        try {
            r = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
                body: JSON.stringify(Object.assign({
                    model: model,
                    max_tokens: maxTokens,
                    system: SYSTEM,
                    messages: messages,
                    stream: true
                }, extra)),
                signal: controller.signal
            });
        } catch (e) {
            clearTimeout(timeout);
            registrarFalha(quem, funcao, e.message);
            return res.status(500).json({ error: "Não consegui falar com a IA agora. Tente de novo." });
        }
        if (!r.ok || !r.body) {
            clearTimeout(timeout);
            let errTxt = ""; try { errTxt = await r.text(); } catch (_) {}
            registrarFalha(quem, funcao, "IA respondeu " + r.status + ": " + errTxt.slice(0, 200));
            return res.status(r.status === 429 || r.status === 529 ? r.status : 502).json({ error: r.status === 429 || r.status === 529 ? "A IA está com muita procura agora. Espere 30 segundos e tente de novo." : "A IA não conseguiu responder agora. Tente de novo." });
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("X-Accel-Buffering", "no");
        if (res.flushHeaders) res.flushHeaders();
        const decoder = new TextDecoder();
        let buffer = "", uso = null;
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
                                res.write(semTravessao(ev.delta.text));
                            } else if (ev.type === "message_start" && ev.message && ev.message.usage) {
                                uso = Object.assign({}, ev.message.usage);
                            } else if (ev.type === "message_delta" && ev.usage && uso) {
                                Object.assign(uso, ev.usage);
                            }
                        } catch (_) {}
                    }
                }
            }
        } catch (e) { /* stream interrompido — cliente trata o que recebeu */ }
        clearTimeout(timeout);
        await registrarUso(quem, funcao, model, uso, false);
        return res.end();
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 110000);
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
                system: SYSTEM,
                messages: messages
            }, extra, usarFerramentas ? { tools: tools } : {})),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const d = await r.json();
        await registrarUso(quem, funcao, model, d && d.usage, false);
        if (!r.ok) registrarFalha(quem, funcao, "IA respondeu " + r.status + ": " + String((d && d.error && d.error.message) || "").slice(0, 200));
        if (d && Array.isArray(d.content)) d.content.forEach(function (b) { if (b && typeof b.text === "string") b.text = semTravessao(b.text); });
        if (!r.ok) return res.status(r.status === 429 || r.status === 529 ? r.status : 502).json({ error: r.status === 429 || r.status === 529 ? "A IA está com muita procura agora. Espere 30 segundos e tente de novo." : "A IA não conseguiu responder agora. Tente de novo." });
        return res.status(200).json(d);
    } catch(e) {
        if (e.name === "AbortError") {
            registrarFalha(quem, funcao, "a IA demorou demais");
            return res.status(504).json({ error: "A IA demorou demais. Tente novamente." });
        }
        registrarFalha(quem, funcao, e.message);
        return res.status(500).json({ error: "Não consegui falar com a IA agora. Tente de novo." });
    }
};

module.exports.config = {
    api: {
        bodyParser: {
            sizeLimit: "10mb"
        }
    }
};
