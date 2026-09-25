// =====================================================================
//  TRANSCRICAO DE UM REELS PELO LINK PUBLICO DO INSTAGRAM
//  Usado pelo botao de transcrever (api/igtranscribe.js) e pelo time de
//  agentes (api/_time-agentes.js), que transcreve os videos vencedores.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

class ErroTranscricao extends Error {
    constructor(status, msg) { super(msg); this.status = status; }
}

// Navegador "real" para o Instagram nao bloquear de cara
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
};
const LIMITE_BYTES = 24 * 1024 * 1024;

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
            if (u.indexOf("http") === 0) return u;
        }
    }
    return "";
}

function linkValido(url) {
    return !!url && (url.indexOf("instagram.com") > -1 || url.indexOf("instagr.am") > -1);
}

async function transcreverReel(url) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ErroTranscricao(500, "Sem chave da OpenAI. Configure OPENAI_API_KEY no Vercel.");
    if (!linkValido(url)) throw new ErroTranscricao(400, "Link do Instagram invalido");
    try {
        // 1) Busca a pagina publica do Reels/post
        let pageUrl = url.split("?")[0];
        if (pageUrl.charAt(pageUrl.length - 1) !== "/") pageUrl += "/";
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        let videoUrl = "";
        const pr = await fetch(pageUrl, { headers: HEADERS, signal: controller.signal });
        if (pr.ok) videoUrl = extractVideoUrl(await pr.text());

        // 2) Fallback: endpoint de embed publico
        if (!videoUrl) {
            try {
                const er = await fetch("https://www.instagram.com/api/v1/oembed/?url=" + encodeURIComponent(pageUrl), {
                    headers: Object.assign({}, HEADERS, { "X-IG-App-ID": "936619743392459" })
                });
                if (er.ok) videoUrl = extractVideoUrl(await er.text());
            } catch (e2) { /* ignora */ }
        }
        clearTimeout(timeout);
        if (!videoUrl) throw new ErroTranscricao(422, "Nao consegui pegar o video por este link (o Instagram bloqueou ou o post e privado). Baixe o video e use o botao de enviar arquivo.");

        // 3) Baixa os bytes do video (limite de tamanho de seguranca)
        const vc = new AbortController();
        const vt = setTimeout(() => vc.abort(), 30000);
        const vr = await fetch(videoUrl, { headers: { "User-Agent": UA }, signal: vc.signal });
        clearTimeout(vt);
        if (!vr.ok) throw new ErroTranscricao(422, "Nao consegui baixar o video deste link. Use o botao de enviar arquivo.");
        const len = vr.headers.get("content-length");
        if (len && Number(len) > LIMITE_BYTES) throw new ErroTranscricao(413, "Video muito grande para transcrever pelo link. Envie um clipe menor pelo arquivo.");
        const buf = Buffer.from(await vr.arrayBuffer());
        if (buf.length > LIMITE_BYTES) throw new ErroTranscricao(413, "Video muito grande para transcrever pelo link. Envie um clipe menor pelo arquivo.");

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
        if (!r.ok) throw new ErroTranscricao(r.status, (d.error && d.error.message) || "Erro ao transcrever");
        const text = (d.text || "").trim();
        if (!text) throw new ErroTranscricao(422, "O video nao tem fala para transcrever.");
        return text;
    } catch (e) {
        if (e instanceof ErroTranscricao) throw e;
        if (e.name === "AbortError") throw new ErroTranscricao(504, "Demorou demais para ler o video deste link. Tente o botao de enviar arquivo.");
        throw new ErroTranscricao(500, (e && e.message) || "Erro ao processar o link");
    }
}

module.exports = { ErroTranscricao, transcreverReel, linkValido };
