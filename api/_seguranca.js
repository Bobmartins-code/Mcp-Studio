// =====================================================================
//  SEGURANCA COMPARTILHADA DO SERVIDOR
//  - confirma que quem chama e o admin (pelo ID da conta; com a
//    verificacao em 2 etapas ativa, exige a sessao verificada)
//  - acesso ao banco com a chave de servico, so para as tabelas de tokens
//    (o navegador nao consegue ler essas tabelas, nem o admin)
//  - criptografia dos tokens guardados (AES-256-GCM)
//  - registro de auditoria
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================
const crypto = require("crypto");

const SUPA_URL = "https://yutqrrcdlkocrpznryqi.supabase.co";
const SUPA_ANON = "sb_publishable_U3wOTwbeEvXtHOqP_I29VQ_ARH5CAkH";
const ADMIN_ID = "1c4d2a2b-c60b-4e99-982b-5b4a09e8cc0f";

function payloadDoJwt(jwt) {
    try { return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString("utf8")); } catch (e) { return {}; }
}

// Devolve o usuario admin, ou null. O Supabase valida o token; aqui conferimos quem e.
async function validarAdmin(jwt) {
    if (!jwt) return null;
    const r = await fetch(SUPA_URL + "/auth/v1/user", { headers: { apikey: SUPA_ANON, Authorization: "Bearer " + jwt } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || u.id !== ADMIN_ID) return null;
    const temMfa = (u.factors || []).some(function (f) { return f.status === "verified"; });
    if (temMfa && payloadDoJwt(jwt).aal !== "aal2") return null;
    return u;
}

// Banco com a chave de servico (so no servidor)
function chaveServico() {
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY nao configurada no Vercel.");
    return k;
}
async function banco(caminho, opcoes) {
    const o = opcoes || {}, k = chaveServico();
    const headers = Object.assign({ apikey: k, "Content-Type": "application/json" }, o.headers || {});
    if (k.indexOf("sb_secret_") !== 0) headers.Authorization = "Bearer " + k; // chave antiga (JWT) vai tambem no Authorization
    const r = await fetch(SUPA_URL + "/rest/v1/" + caminho, { method: o.method || "GET", headers: headers, body: o.body ? JSON.stringify(o.body) : undefined });
    const txt = await r.text();
    if (!r.ok) throw new Error("Banco: " + txt.slice(0, 200));
    return txt ? JSON.parse(txt) : null;
}

// Contas de login (auth do Supabase) com a chave de servico: criar, convidar e apagar
async function authAdmin(caminho, opcoes) {
    const o = opcoes || {}, k = chaveServico();
    const headers = { apikey: k, "Content-Type": "application/json" };
    if (k.indexOf("sb_secret_") !== 0) headers.Authorization = "Bearer " + k;
    const r = await fetch(SUPA_URL + "/auth/v1/" + caminho, { method: o.method || "GET", headers: headers, body: o.body ? JSON.stringify(o.body) : undefined });
    const txt = await r.text();
    let d = null;
    try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = { msg: txt.slice(0, 200) }; }
    if (!r.ok) {
        const e = new Error((d && (d.msg || d.message || d.error_description || d.error)) || ("Erro " + r.status + " no login"));
        e.status = r.status; e.codigo = d && (d.error_code || d.code);
        throw e;
    }
    return d;
}

// ---------- criptografia dos tokens ----------
function chaveCripto() {
    const b = process.env.TOKENS_ENC_KEY;
    if (!b) throw new Error("TOKENS_ENC_KEY nao configurada no Vercel.");
    const k = Buffer.from(b, "base64");
    if (k.length !== 32) throw new Error("TOKENS_ENC_KEY invalida.");
    return k;
}
function criptografar(texto) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", chaveCripto(), iv);
    const ct = Buffer.concat([c.update(String(texto), "utf8"), c.final()]);
    return "v1:" + iv.toString("base64") + ":" + c.getAuthTag().toString("base64") + ":" + ct.toString("base64");
}
function descriptografar(valor) {
    const v = String(valor || "");
    if (v.indexOf("v1:") !== 0) return v; // registro antigo, ainda sem criptografia
    const p = v.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", chaveCripto(), Buffer.from(p[1], "base64"));
    d.setAuthTag(Buffer.from(p[2], "base64"));
    return Buffer.concat([d.update(Buffer.from(p[3], "base64")), d.final()]).toString("utf8");
}

// Auditoria: nunca derruba a acao principal se falhar
async function auditar(adminId, acao, alvo, detalhe) {
    try { await banco("auditoria", { method: "POST", body: { admin_id: adminId, acao: acao, alvo: alvo || null, detalhe: detalhe || null } }); } catch (e) { console.error("[auditoria] " + e.message); }
}

module.exports = { SUPA_URL, SUPA_ANON, ADMIN_ID, validarAdmin, banco, authAdmin, criptografar, descriptografar, auditar };
