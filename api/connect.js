// =====================================================================
//  REPORTEI CONNECT (https://connect.reportei.com/api)
//  Coleta metricas do Instagram e do Meta Ads das clientes sem OAuth
//  proprio: cada cliente autoriza as contas numa tela do Reportei.
//
//  Fluxo:  merchant (a conta do MCP Studio, chave CONNECT_API_KEY)
//            -> customer (cada cliente; token proprio salvo no banco)
//            -> integration session (link onde as contas sao conectadas)
//            -> metricas
//
//  So o admin usa. A chave e os tokens dos clientes nunca saem do servidor.
// =====================================================================

const SUPA_URL = "https://yutqrrcdlkocrpznryqi.supabase.co";
const SUPA_ANON = "sb_publishable_U3wOTwbeEvXtHOqP_I29VQ_ARH5CAkH";
const ADMIN_EMAIL = "rrubensmartins@gmail.com";
const CONNECT = "https://connect.reportei.com/api";
const PLATAFORMAS = ["instagram_business", "facebook_ads"];

// ---------- cliente HTTP do Connect: timeout + retry com backoff so em 429 e 5xx ----------
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

// ---------- banco (com a sessao do admin; as regras do banco so deixam o admin ler os tokens) ----------
async function validarAdmin(token) {
    if (!token) return null;
    const r = await fetch(SUPA_URL + "/auth/v1/user", { headers: { apikey: SUPA_ANON, Authorization: "Bearer " + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.email === ADMIN_EMAIL) ? u : null;
}

async function supa(caminho, jwt, opcoes) {
    const o = opcoes || {};
    const r = await fetch(SUPA_URL + "/rest/v1/" + caminho, {
        method: o.method || "GET",
        headers: Object.assign({ apikey: SUPA_ANON, Authorization: "Bearer " + jwt, "Content-Type": "application/json" }, o.headers || {}),
        body: o.body ? JSON.stringify(o.body) : undefined
    });
    const txt = await r.text();
    if (!r.ok) throw new Error("Banco: " + txt.slice(0, 200));
    return txt ? JSON.parse(txt) : null;
}

async function clienteDoUsuario(jwt, userId) {
    const rows = await supa("connect_clientes?user_id=eq." + encodeURIComponent(userId) + "&select=customer_uuid,api_token,nome", jwt);
    if (!rows || !rows.length) throw new ErroConnect(404, { message: "Esta cliente ainda nao foi ativada no Reportei Connect." });
    return rows[0];
}

// ---------- rotas ----------
module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let admin;
    try { admin = await validarAdmin(jwt); } catch (e) { admin = null; }
    if (!admin) return res.status(403).json({ error: "Somente o admin pode usar o Reportei Connect." });
    const b = req.body || {};
    try {
        // teste de fumaca: a chave vale e a conta esta ativa?
        if (b.acao === "status") {
            if (!process.env.CONNECT_API_KEY) return res.status(200).json({ configurado: false });
            const d = await connect("/merchants/settings");
            const m = d.merchant || {};
            return res.status(200).json({ configurado: true, nome: m.name, pagante: m.is_paying, teste_ate: m.trial_ends_at, total_clientes: m.total_customers, plataformas: m.available_integrations || [] });
        }

        // cria a cliente no Connect e guarda o token dela na mesma hora (ele so aparece nesta resposta)
        if (b.acao === "ativar") {
            if (!b.user_id) throw new ErroConnect(400, { message: "Informe a cliente." });
            const existe = await supa("connect_clientes?user_id=eq." + encodeURIComponent(b.user_id) + "&select=customer_uuid", jwt);
            if (existe && existe.length) return res.status(200).json({ ok: true, ja_existia: true });
            const d = await connect("/customers", { method: "POST", body: { name: String(b.nome || "Cliente").slice(0, 255) } });
            const c = d.customer;
            try {
                await supa("connect_clientes", jwt, { method: "POST", body: { user_id: b.user_id, customer_uuid: c.uuid, api_token: c.api_token, nome: c.name } });
            } catch (e) {
                // sem o token salvo a cliente fica inutil: desfaz no Connect para nao deixar orfa
                try { await connect("/customers/" + c.uuid, { method: "DELETE" }); } catch (_) {}
                throw e;
            }
            return res.status(200).json({ ok: true, customer_uuid: c.uuid, teste_ate: c.trial_ends_at });
        }

        // link da tela onde as contas (Instagram e Meta Ads) sao autorizadas
        if (b.acao === "sessao") {
            const cli = await clienteDoUsuario(jwt, b.user_id);
            const corpo = { locale: "pt_BR", close_on_finish: true, expires_in_minutes: 60, limits: [{ name: "available_integrations", value: PLATAFORMAS }] };
            if (b.redirect_url) { corpo.redirect_url = b.redirect_url; corpo.close_on_finish = false; }
            const d = await connect("/customer-integrations/session", { method: "POST", body: corpo, customerToken: cli.api_token });
            return res.status(200).json({ link: d.integration_session.session_link, expira: d.integration_session.expires_at });
        }

        // o que a cliente ja conectou (e o uuid de cada conexao, que as metricas pedem)
        if (b.acao === "integracoes") {
            const cli = await clienteDoUsuario(jwt, b.user_id);
            let pagina = 1, todas = [];
            while (pagina <= 5) {
                const d = await connect("/customer-integrations?per_page=100&page=" + pagina, { customerToken: cli.api_token });
                todas = todas.concat(d.data || []);
                if (!d.meta || pagina >= d.meta.last_page) break;
                pagina++;
            }
            return res.status(200).json({ integracoes: todas.map(function (i) { return { uuid: i.uuid, nome: i.source_name, plataforma: i.integration && i.integration.slug, plataforma_nome: i.integration && i.integration.name, status: i.status, moeda: i.currency || null }; }) });
        }

        // metricas de uma conexao num periodo
        if (b.acao === "metricas") {
            const cli = await clienteDoUsuario(jwt, b.user_id);
            if (!b.integracao || !Array.isArray(b.metrics) || !b.metrics.length || !b.start || !b.end) throw new ErroConnect(400, { message: "Informe integracao, periodo e metricas." });
            const d = await connect("/metrics/get-data", { method: "POST", customerToken: cli.api_token, timeout: 100000, body: { customer_integration: b.integracao, start: b.start, end: b.end, client_timezone: "America/Sao_Paulo", metrics: b.metrics } });
            return res.status(200).json(d);
        }

        return res.status(400).json({ error: "Acao desconhecida" });
    } catch (e) {
        const st = (e && e.status) || 500;
        return res.status(st >= 400 && st < 600 ? st : 500).json({ error: (e && e.message) || "Erro no Reportei Connect", extra: e && e.extra });
    }
};
