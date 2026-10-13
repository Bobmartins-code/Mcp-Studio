// =====================================================================
//  ACOES DO ADMIN NUMA LOJA
//  - atualizar: puxa agora os posts e anuncios da loja direto da Meta
//  - analisar: roda agora o time de agentes da loja
//  - central: monta agora o cerebro central (licoes anonimas; so o admin ve)
//  (o nome do arquivo ficou da epoca do Reportei Connect, que saiu em out/2026)
//  So o admin usa.
// =====================================================================

const { validarAdmin, auditar } = require("./_seguranca.js");
const { atualizarLoja } = require("./_coleta.js");
const { analisarLoja } = require("./_time-agentes.js");

module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let admin;
    try { admin = await validarAdmin(jwt); } catch (e) { admin = null; }
    if (!admin) return res.status(403).json({ error: "Somente o admin pode fazer isso." });
    const b = req.body || {};
    try {
        // puxa agora os posts e anuncios da loja e grava os numeros (o mesmo que a atualizacao automatica faz)
        if (b.acao === "atualizar") {
            if (!b.user_id) return res.status(400).json({ error: "Informe a loja." });
            const r = await atualizarLoja(b.user_id);
            await auditar(admin.id, "atualizou os numeros da loja", b.user_id);
            return res.status(200).json(Object.assign({ ok: true }, r));
        }

        // roda agora o time de agentes da loja (organico, anuncios, publico e diretor)
        if (b.acao === "analisar") {
            if (!b.user_id) return res.status(400).json({ error: "Informe a loja." });
            const r = await analisarLoja(b.user_id, "manual");
            await auditar(admin.id, "rodou o time de agentes da loja", b.user_id);
            return res.status(200).json(r);
        }

        // monta agora o cerebro central (licoes anonimas de formato; so o admin ve)
        if (b.acao === "central") {
            const r = await require("./_cerebro-central.js").gerarCentral(Date.now() + 280000);
            await auditar(admin.id, "gerou o cerebro central", null);
            return res.status(200).json(r);
        }

        return res.status(400).json({ error: "Acao desconhecida" });
    } catch (e) {
        return res.status(500).json({ error: (e && e.message) || "Erro" });
    }
};
