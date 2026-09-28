// =====================================================================
//  OLHOS DO TIME: como e cada video campeao (so leitura)
//  O time entende a fala e a legenda, mas nao via o video: um curto sem
//  fala ficava invisivel. Aqui o servidor baixa o video (o mesmo link que
//  a transcricao usa), tira de 5 a 7 imagens (primeiro segundo, comeco,
//  meio e fim) e a IA descreve UMA vez: o primeiro segundo, o cenario,
//  onde fica o celular, a sequencia, as transicoes, o texto na tela e a
//  mecanica do video. Fica guardado em contas_meta.meta junto com a fala.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const fs = require("fs"), os = require("os"), path = require("path");
const { execFile } = require("child_process");
const { registrarUso } = require("./_uso-ia.js");

const MODELO = "claude-sonnet-5";
const LIMITE_BYTES = 40 * 1024 * 1024;

function objeto(props) { return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false }; }
function texto(d) { return { type: "string", description: d + " Em português do Brasil, frase curta e simples." }; }
const ESQ_VISUAL = objeto({
    primeiro_segundo: texto("O que aparece no primeiro segundo: a imagem que decide se a pessoa fica."),
    cenario: texto("Onde foi gravado (provador, arara da loja, espelho do quarto, rua...)."),
    quem_aparece: texto("Quem aparece (a dona, uma modelo, só a peça, só as mãos) e se o rosto aparece."),
    celular: texto("Como o celular foi usado: na mão, apoiado, de frente para o espelho, de cima, andando."),
    pecas: texto("As peças que aparecem, com cor e tipo."),
    sequencia: { type: "array", items: { type: "string" }, description: "O que acontece do começo ao fim, de 3 a 6 passos curtos, cada um com até 10 palavras." },
    transicoes: texto("Como passa de uma cena para outra (corte seco, troca de look, giro, mão na lente) ou 'uma cena só'."),
    texto_na_tela: texto("Os textos escritos por cima do vídeo, copiados como aparecem, ou vazio."),
    ritmo: { type: "string", enum: ["parado", "calmo", "médio", "rápido"] },
    mecanica: texto("A mecânica do vídeo em uma frase de até 10 palavras, sem citar a peça (exemplo: troca de look no pulo em frente ao espelho).")
});

// ---------- ffmpeg (no servidor pode precisar ir para /tmp para poder rodar) ----------
let binario = null;
function ffmpeg() {
    if (binario) return binario;
    // no servidor: o binario vem pronto no pacote @ffmpeg-installer/linux-x64; no computador de teste, ffmpeg-static
    const lugares = [path.join(__dirname, "..", "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg"), path.join(process.cwd(), "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg")];
    try { lugares.push(path.join(path.dirname(require.resolve("@ffmpeg-installer/linux-x64/package.json")), "ffmpeg")); } catch (e) {}
    try { lugares.push(require("ffmpeg-static")); } catch (e) {}
    const p = lugares.find(function (x) { try { return x && fs.existsSync(x); } catch (e) { return false; } });
    if (!p) return null;
    try { fs.accessSync(p, fs.constants.X_OK); binario = p; }
    catch (e) {
        const tmp = path.join(os.tmpdir(), "ffmpeg-mcp");
        try { if (!fs.existsSync(tmp)) fs.copyFileSync(p, tmp); fs.chmodSync(tmp, 0o755); binario = tmp; } catch (e2) { return null; }
    }
    return binario;
}
function rodar(args, ms) {
    return new Promise(function (ok) {
        execFile(ffmpeg(), args, { timeout: ms || 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, function (e, so, se) { ok({ erro: e, saida: String(se || "") }); });
    });
}
async function duracao(arq) {
    const r = await rodar(["-hide_banner", "-i", arq], 15000);
    const m = r.saida.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}
// momentos que mostram o video: o primeiro segundo pesa mais (e o gancho)
function momentos(d) {
    const base = [0.2, 1.2, 2.6, d * 0.35, d * 0.55, d * 0.75, d - 0.6];
    const out = [];
    base.filter(function (t) { return t >= 0 && t < d; }).sort(function (a, b) { return a - b; })
        .forEach(function (t) { if (!out.length || t - out[out.length - 1] >= 0.8) out.push(Math.round(t * 10) / 10); });
    return out.slice(0, 7);
}
// devolve as imagens em base64 (jpg pequeno, 432 px de largura)
async function quadros(buf) {
    if (!ffmpeg()) throw new Error("ffmpeg indisponível");
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "olhos-"));
    try {
        const arq = path.join(pasta, "v.mp4");
        fs.writeFileSync(arq, buf);
        const d = await duracao(arq);
        if (!d) throw new Error("não li a duração do vídeo");
        const imgs = [];
        for (const [i, t] of momentos(d).entries()) {
            const saida = path.join(pasta, "q" + i + ".jpg");
            await rodar(["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", arq, "-frames:v", "1", "-vf", "scale=432:-2", "-q:v", "6", "-y", saida], 20000);
            if (fs.existsSync(saida) && fs.statSync(saida).size > 500) imgs.push({ t: t, b64: fs.readFileSync(saida).toString("base64") });
        }
        return { duracao: Math.round(d * 10) / 10, imgs: imgs };
    } finally {
        try { fs.rmSync(pasta, { recursive: true, force: true }); } catch (e) {}
    }
}

async function descrever(userId, q, extra) {
    const conteudo = [];
    q.imgs.forEach(function (im) {
        conteudo.push({ type: "text", text: "Imagem no segundo " + String(im.t).replace(".", ",") + ":" });
        conteudo.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: im.b64 } });
    });
    conteudo.push({ type: "text", text: "Estas são imagens, em ordem, de um vídeo de " + String(q.duracao).replace(".", ",") + " segundos de uma loja no Instagram. Descreva como o vídeo é, para uma equipe que vai criar vídeos parecidos para esta mesma loja. Descreva só o que se vê; se algo não der para saber pelas imagens, diga que não dá." +
        (extra && extra.legenda ? "\nLegenda do post: " + String(extra.legenda).slice(0, 400) : "") +
        (extra && extra.fala ? "\nFala do vídeo (transcrita): " + String(extra.fala).slice(0, 800) : "\nO vídeo não tem fala transcrita.") });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(60000),
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODELO, max_tokens: 2500, messages: [{ role: "user", content: conteudo }], output_config: { effort: "low", format: { type: "json_schema", schema: ESQ_VISUAL } } })
    });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error((d.error && d.error.message) || ("erro " + r.status));
    await registrarUso(userId || null, "Olhos: como é o vídeo", MODELO, d.usage, false);
    if (d.stop_reason !== "end_turn") throw new Error("descrição cortada");
    const bloco = (d.content || []).find(function (b) { return b.type === "text"; });
    return JSON.parse(bloco.text);
}

// baixa o video, tira as imagens e descreve; devolve o objeto guardado no cache
async function olharVideo(url, userId, extra) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("não consegui baixar o vídeo");
    if (Number(r.headers.get("content-length")) > LIMITE_BYTES) throw new Error("vídeo grande demais");
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > LIMITE_BYTES) throw new Error("vídeo grande demais");
    const q = await quadros(buf);
    if (q.imgs.length < 2) throw new Error("não consegui tirar as imagens do vídeo");
    const v = await descrever(userId, q, extra);
    return Object.assign({ duracao_s: q.duracao, em: new Date().toISOString() }, v);
}

// o video em texto, para os agentes
function textoVisual(v) {
    if (!v || !v.mecanica) return "";
    return "mecânica: " + v.mecanica + "; primeiro segundo: " + v.primeiro_segundo + "; cenário: " + v.cenario + "; quem aparece: " + v.quem_aparece + "; celular: " + v.celular +
        "; sequência: " + (v.sequencia || []).join(" > ") + "; transições: " + v.transicoes + (v.texto_na_tela ? "; texto na tela: " + v.texto_na_tela : "") + "; ritmo " + v.ritmo + (v.duracao_s ? "; " + String(v.duracao_s).replace(".", ",") + " s" : "");
}

module.exports = { olharVideo, textoVisual, disponivel: function () { return !!ffmpeg(); }, _interno: { quadros, momentos, descrever } };
