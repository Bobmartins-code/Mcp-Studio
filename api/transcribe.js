const { acessoLiberado, SEM_ACESSO } = require("./_seguranca.js");
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
    // acesso fechado: so quem o admin cadastrou usa a IA
    try { if (!(await acessoLiberado(token))) return res.status(403).json({ error: SEM_ACESSO }); }
    catch (e) { return res.status(500).json({ error: "Não consegui confirmar o seu acesso. Tente de novo." }); }
    const fileB64 = req.body && req.body.fileB64;
    if (!fileB64) return res.status(400).json({ error: "Arquivo obrigatorio" });
    const mediaType = (req.body && req.body.mediaType) || "video/mp4";
    const filename = (req.body && req.body.filename) || "audio.mp4";
    try {
        const buf = Buffer.from(fileB64, "base64");
        const form = new FormData();
        form.append("file", new Blob([buf], { type: mediaType }), filename);
        form.append("model", "whisper-1");
        form.append("language", "pt");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 55000);
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + apiKey },
            body: form,
            signal: controller.signal
        });
        clearTimeout(timeout);
        const d = await r.json();
        if (!r.ok) { console.error("[transcribe] " + ((d.error && d.error.message) || r.status)); return res.status(502).json({ error: "Não consegui transcrever agora. Tente de novo." }); }
        return res.status(200).json({ text: d.text || "" });
    } catch (e) {
        if (e.name === "AbortError") return res.status(504).json({ error: "A transcrição demorou demais. Tente um vídeo mais curto." });
        console.error("[transcribe] " + (e && e.message)); return res.status(500).json({ error: "Não consegui transcrever agora. Tente de novo." });
    }
};

module.exports.config = {
    api: {
        bodyParser: {
            sizeLimit: "8mb"
        }
    }
};
