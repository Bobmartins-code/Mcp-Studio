// =====================================================================
//  LOJAS (so o admin)
//  - criar: cadastra a loja com o e-mail da dona. Se ela ainda nao tem
//    login, o login e criado agora e sai um link de convite (ou o e-mail
//    de convite, se marcado). Se ja tem, a loja e ligada a conta dela.
//  - convite: gera de novo o link para a dona criar a senha
//  - remover: apaga a loja, os dados, os projetos e o login da dona
// =====================================================================

const { validarAdmin, banco, authAdmin, enviarArquivo, auditar, ADMIN_ID } = require("./_seguranca.js");
const { connect } = require("./_reportei.js");

function emailValido(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function jaExiste(e) { return e && (e.status === 422 || e.codigo === "email_exists" || /already|registered|exists/i.test(e.message || "")); }
function destino(req) {
    const host = (req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "mcp-studio-zeta.vercel.app";
    return "https://" + host + "/index.html";
}

// Link para a dona criar a senha: convite enquanto ela nunca confirmou; depois, link de nova senha
async function gerarLink(email, redirect) {
    const q = "?redirect_to=" + encodeURIComponent(redirect);
    try {
        const d = await authAdmin("admin/generate_link" + q, { method: "POST", body: { type: "invite", email: email } });
        return { link: d.action_link, user_id: d.id, novo: true };
    } catch (e) {
        if (!jaExiste(e)) throw e;
        const d = await authAdmin("admin/generate_link" + q, { method: "POST", body: { type: "recovery", email: email } });
        return { link: d.action_link, user_id: d.id, novo: false, ja_entrou: !!d.last_sign_in_at };
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let admin;
    try { admin = await validarAdmin(jwt); } catch (e) { admin = null; }
    if (!admin) return res.status(403).json({ error: "Somente o admin pode gerenciar as lojas." });
    const b = req.body || {};
    try {
        if (b.acao === "criar") {
            const email = String(b.email || "").trim().toLowerCase();
            const nome = String(b.nome || "").trim().slice(0, 120);
            if (!emailValido(email)) return res.status(400).json({ error: "Confira o e-mail da dona da loja." });
            if (!nome) return res.status(400).json({ error: "Informe o nome da loja." });
            const redirect = destino(req);
            let userId = null, link = null, novo = false, emailEnviado = false, jaEntrou = false;
            if (b.enviar_email) {
                // o Supabase cria o login e manda o e-mail de convite
                try {
                    const u = await authAdmin("invite?redirect_to=" + encodeURIComponent(redirect), { method: "POST", body: { email: email } });
                    userId = u.id; novo = true; emailEnviado = true;
                } catch (e) { if (!jaExiste(e)) throw e; }
            }
            if (!userId) {
                const g = await gerarLink(email, redirect);
                userId = g.user_id; novo = g.novo; jaEntrou = !!g.ja_entrou;
                // quem ja usa o app nao precisa de link
                link = jaEntrou ? null : g.link;
            }
            if (!userId) throw new Error("Nao consegui criar o login da loja.");
            await banco("lojas", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: { user_id: userId, nome: nome, nicho: b.nicho || null, site: String(b.site || "").trim().slice(0, 300) || null, atualizado_em: new Date().toISOString() } });
            await auditar(admin.id, novo ? "criou loja e login da dona" : "ligou loja a um login existente", userId, { email: email, nome: nome });
            return res.status(200).json({ ok: true, user_id: userId, novo: novo, ja_entrou: jaEntrou, link: link, email_enviado: emailEnviado });
        }

        if (b.acao === "convite") {
            if (!b.user_id) return res.status(400).json({ error: "Informe a loja." });
            const u = await authAdmin("admin/users/" + encodeURIComponent(b.user_id));
            const g = await gerarLink(u.email, destino(req));
            await auditar(admin.id, "gerou link de acesso da loja", b.user_id);
            return res.status(200).json({ ok: true, link: g.link, email: u.email, ja_entrou: !!u.last_sign_in_at });
        }

        // perfil da loja pelo admin (vendo a conta da cliente): nome e logo, nada mais
        if (b.acao === "perfil") {
            const uid = String(b.user_id || "");
            if (!/^[0-9a-f-]{36}$/i.test(uid)) return res.status(400).json({ error: "Informe a loja." });
            const atual = await banco("lojas?user_id=eq." + uid + "&select=nome,logo_url");
            const linha = atual && atual[0];
            const campos = {};
            if (b.nome != null) {
                const nome = String(b.nome).trim();
                if (nome.length < 1 || nome.length > 80) return res.status(400).json({ error: "O nome da loja precisa ter de 1 a 80 letras." });
                campos.nome = nome;
            }
            if (b.remover_logo) campos.logo_url = null;
            else if (b.logo_b64) {
                const tipos = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
                if (!tipos[b.logo_tipo]) return res.status(400).json({ error: "Use uma imagem PNG, JPG ou WEBP." });
                const buf = Buffer.from(String(b.logo_b64), "base64");
                if (!buf.length || buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: "A imagem pode ter até 2 MB." });
                campos.logo_url = await enviarArquivo("logos", uid + "/logo-" + Date.now() + "." + tipos[b.logo_tipo], buf, b.logo_tipo);
            }
            if (!Object.keys(campos).length) return res.status(400).json({ error: "Nada para salvar." });
            // loja ativada so pelo Reportei ainda nao tem linha: cria com o nome do cadastro do Reportei
            if (!linha && !campos.nome) {
                const cc = await banco("connect_clientes?user_id=eq." + uid + "&select=nome");
                campos.nome = (cc && cc[0] && cc[0].nome) || "Minha loja";
            }
            await banco("lojas", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: Object.assign({ user_id: uid, atualizado_em: new Date().toISOString() }, campos) });
            await auditar(admin.id, "editou o perfil da loja", uid, { nome: campos.nome || null, logo: b.remover_logo ? "removida" : (b.logo_b64 ? "nova" : null) });
            return res.status(200).json({ ok: true, logo_url: campos.logo_url });
        }

        if (b.acao === "remover") {
            const uid = String(b.user_id || "");
            if (!uid) return res.status(400).json({ error: "Informe a loja." });
            if (uid === ADMIN_ID || uid === admin.id) return res.status(400).json({ error: "A conta do admin nao pode ser removida." });
            // tira a cliente do Reportei Connect para nao deixar conta orfa por la
            try {
                const c = await banco("connect_clientes?user_id=eq." + encodeURIComponent(uid) + "&select=customer_uuid");
                if (c && c.length) await connect("/customers/" + c[0].customer_uuid, { method: "DELETE" });
            } catch (e) { console.error("[lojas] reportei: " + e.message); }
            await auditar(admin.id, "removeu loja", uid);
            await banco("projetos?user_id=eq." + encodeURIComponent(uid), { method: "DELETE" });
            try { await banco("perfil_publico?user_id=eq." + encodeURIComponent(uid), { method: "DELETE" }); } catch (e) { /* tabela sem registro */ }
            // apagar o login leva junto loja, dossie, numeros, recados e o token do Reportei (on delete cascade)
            await authAdmin("admin/users/" + encodeURIComponent(uid), { method: "DELETE" });
            return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: "Acao desconhecida" });
    } catch (e) {
        return res.status(500).json({ error: (e && e.message) || "Erro ao gerenciar a loja" });
    }
};
