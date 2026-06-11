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
    if (!url || (url.indexOf("instagram.com") === -1 && url.indexOf("instagr.am") === -1)) {
        return res.status(400).json({ error: "Link do Instagram invalido", needFile: true });
    }

    // Navegador "real" para o Instagram nao bloquear de cara
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    const headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
    };

    function decodeEntities(s) {
        if (!s) return s;
        return s.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    }

    // Tenta achar o link direto do mp4 dentro do HTML/JSON publico do post
    function extractVideoUrl(html) {
        if (!html) return "";
        const patterns = [
            /<meta\s+property="og:video"\s+content="([^"]+)"/i,
            /<meta\s+property="og:video:secure_url"\s+content="([^"]+)"/i,
            /"video_url":"([^"]+)"/,
            /"contentUrl":"([^"]+)"/,
            /"playback_url":"([^"]+)"/
        ];
        for (let i = 0; i < patterns.length; i++) {
            const m = html.match(patterns[i]);
            if (m && m[1]) {
                const u = decodeEntities(m[1]);
                if (u.indexOf("http") === 0 && u.indexOf(".mp4") > -1) return u;
                if (u.indexOf("http") === 0) return u;
            }
        }
        return "";
    }

    try {
        // 1) Busca a pagina publica do Reels/post
        let pageUrl = url.split("?")[0];
        if (pageUrl.charAt(pageUrl.length - 1) !== "/") pageUrl += "/";
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        let videoUrl = "";

        const pr = await fetch(pageUrl, { headers: headers, signal: controller.signal });
        if (pr.ok) {
            const html = await pr.text();
            videoUrl = extractVideoUrl(html);
        }

        // 2) Fallback: endpoint de embed publico
        if (!videoUrl) {
            try {
                const er = await fetch("https://www.instagram.com/api/v1/oembed/?url=" + encodeURIComponent(pageUrl), {
                    headers: Object.assign({}, headers, { "X-IG-App-ID": "936619743392459" })
                });
                if (er.ok) {
                    const ehtml = await er.text();
                    videoUrl = extractVideoUrl(ehtml);
                }
            } catch (e2) { /* ignora */ }
        }

        clearTimeout(timeout);

        if (!videoUrl) {
            return res.status(422).json({
                error: "Nao consegui pegar o video por este link (o Instagram bloqueou ou o post e privado). Baixe o video e use o botao de enviar arquivo.",
                needFile: true
            });
        }

        // 3) Baixa os bytes do video (limite de tamanho de seguranca)
        const vc = new AbortController();
        const vt = setTimeout(() => vc.abort(), 30000);
        const vr = await fetch(videoUrl, { headers: { "User-Agent": UA }, signal: vc.signal });
        clearTimeout(vt);
        if (!vr.ok) return res.status(422).json({ error: "Nao consegui baixar o video deste link. Use o botao de enviar arquivo.", needFile: true });
        const len = vr.headers.get("content-length");
        if (len && Number(len) > 24 * 1024 * 1024) {
            return res.status(413).json({ error: "Video muito grande para transcrever pelo link. Envie um clipe menor pelo arquivo.", needFile: true });
        }
        const ab = await vr.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length > 24 * 1024 * 1024) {
            return res.status(413).json({ error: "Video muito grande para transcrever pelo link. Envie um clipe menor pelo arquivo.", needFile: true });
        }

        // 4) Manda para o Whisper
        const wc = new AbortController();
        const wt = setTimeout(() => wc.abort(), 50000);
        const form = new FormData();
        form.append("file", new Blob([buf], { type: "video/mp4" }), "reel.mp4");
        form.append("model", "whisper-1");
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + apiKey },
            body: form,
            signal: wc.signal
        });
        clearTimeout(wt);
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: (d.error && d.error.message) || "Erro ao transcrever", needFile: true });
        const text = (d.text || "").trim();
        if (!text) return res.status(422).json({ error: "O video nao tem fala para transcrever.", needFile: true });
        return res.status(200).json({ text: text });
    } catch (e) {
        if (e.name === "AbortError") return res.status(504).json({ error: "Demorou demais para ler o video deste link. Tente o botao de enviar arquivo.", needFile: true });
        return res.status(500).json({ error: (e && e.message) || "Erro ao processar o link", needFile: true });
    }
};

module.exports.config = {
    api: {
        bodyParser: {
            sizeLimit: "1mb"
        }
    }
};
