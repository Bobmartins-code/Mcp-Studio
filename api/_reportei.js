// =====================================================================
//  CLIENTE HTTP DO REPORTEI CONNECT (https://connect.reportei.com/api)
//  Compartilhado entre o painel admin (api/connect.js), a coleta dos
//  numeros (api/_coleta.js) e a atualizacao diaria (api/atualizar.js).
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const { banco, descriptografar } = require("./_seguranca.js");
const CONNECT = "https://connect.reportei.com/api";
const PLATAFORMAS = ["instagram_business", "facebook_ads"];

// ---------- timeout + retry com backoff so em 429 e 5xx ----------
class ErroConnect extends Error {
    constructor(status, corpo) {
        // tres formatos de erro: validacao {errors}, recusa de metricas {message, extra}, resto {message}
        let msg = (corpo && corpo.message) || "";
        if (corpo && corpo.errors) msg = Object.keys(corpo.errors).map(function (k) { return k + ": " + [].concat(corpo.errors[k]).join(", "); }).join(" | ");
        if (!msg) msg = "Erro " + status + " do Reportei Connect";
        super(msg);
        this.status = status;
        this.extra = corpo && corpo.extra;
    }
}

function espera(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function connect(caminho, opcoes) {
    const o = opcoes || {};
    const chave = process.env.CONNECT_API_KEY;
    if (!chave) throw new ErroConnect(500, { message: "CONNECT_API_KEY nao configurada no Vercel." });
    const headers = { Authorization: "Bearer " + chave, Accept: "application/json" };
    if (o.body) headers["Content-Type"] = "application/json";
    if (o.customerToken) headers["x-customer-token"] = o.customerToken;
    const tentativas = 4;
    for (let t = 0; t < tentativas; t++) {
        const ctrl = new AbortController();
        const timer = setTimeout(function () { ctrl.abort(); }, o.timeout || 30000);
        let r;
        try {
            r = await fetch(CONNECT + caminho, { method: o.method || "GET", headers: headers, body: o.body ? JSON.stringify(o.body) : undefined, signal: ctrl.signal });
        } catch (e) {
            clearTimeout(timer);
            if (t < tentativas - 1) { await espera(500 * Math.pow(2, t)); continue; }
            throw new ErroConnect(504, { message: e.name === "AbortError" ? "O Reportei Connect demorou demais para responder." : "Falha de rede ao falar com o Reportei Connect." });
        }
        clearTimeout(timer);
        const txt = await r.text();
        let corpo = null;
        try { corpo = txt ? JSON.parse(txt) : null; } catch (_) { corpo = { message: txt.slice(0, 300) }; }
        if (r.ok) return corpo;
        // 429 e 5xx podem mudar na proxima tentativa; 4xx nao
        if ((r.status === 429 || r.status >= 500) && t < tentativas - 1) {
            const ra = Number(r.headers.get("retry-after"));
            await espera(ra > 0 ? Math.min(ra, 10) * 1000 : 500 * Math.pow(2, t));
            continue;
        }
        const erro = new ErroConnect(r.status, corpo);
        console.error("[connect] " + (o.method || "GET") + " " + caminho + " -> " + r.status + ": " + erro.message);
        throw erro;
    }
}

// ---------- token da cliente: so o servidor le, e ele fica criptografado no banco ----------
async function clienteDoUsuario(userId) {
    const rows = await banco("connect_clientes?user_id=eq." + encodeURIComponent(userId) + "&select=customer_uuid,api_token,nome");
    if (!rows || !rows.length) throw new ErroConnect(404, { message: "Esta cliente ainda nao foi ativada no Reportei Connect." });
    return { customer_uuid: rows[0].customer_uuid, nome: rows[0].nome, api_token: descriptografar(rows[0].api_token) };
}

// ---------- contas que a cliente ja conectou ----------
async function integracoesDoCliente(cli) {
    let pagina = 1, todas = [];
    while (pagina <= 5) {
        const d = await connect("/customer-integrations?per_page=100&page=" + pagina, { customerToken: cli.api_token });
        todas = todas.concat(d.data || []);
        if (!d.meta || pagina >= d.meta.last_page) break;
        pagina++;
    }
    return todas.map(function (i) { return { uuid: i.uuid, nome: i.source_name, plataforma: i.integration && i.integration.slug, plataforma_nome: i.integration && i.integration.name, status: i.status, moeda: i.currency || null }; });
}

module.exports = { CONNECT, PLATAFORMAS, ErroConnect, connect, clienteDoUsuario, integracoesDoCliente };
