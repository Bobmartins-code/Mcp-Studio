// =====================================================================
//  LOJAS DE REFERENCIA (tela Descobertas)
//  A dona salva ate 5 perfis publicos que admira; lemos os melhores posts
//  deles na hora (so leitura, pela Meta) e o time passa a usar como
//  inspiracao nas proximas ideias. Veja api/_referencias.js.
// =====================================================================

const { banco, acessoLiberado, SEM_ACESSO } = require("./_seguranca.js");
const { limparNomes, atualizarReferencias, REF_MS } = require("./_referencias.js");
const { registrarFalha } = require("./_uso-ia.js");

module.exports = async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    const jwt = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7) : "";
    let uid;
    try { uid = await acessoLiberado(jwt); } catch (e) { return res.status(500).json({ error: "Não consegui confirmar o seu acesso. Tente de novo." }); }
    if (!uid) return res.status(jwt ? 403 : 401).json({ error: jwt ? SEM_ACESSO : "Entre na sua conta de novo." });
    const nomes = limparNomes((req.body || {}).perfis);
    try {
        const id = encodeURIComponent(uid);
        // mesma lista lida ha pouco: devolve o que ja tem (a cota da Meta e de todas as lojas)
        const atual = await banco("contas_meta?user_id=eq." + id + "&select=referencias").catch(function () { return []; });
        const ref0 = atual && atual[0] && atual[0].referencias;
        const lojaAtual = await banco("lojas?user_id=eq." + id + "&select=referencias").catch(function () { return []; });
        const lista0 = (lojaAtual && lojaAtual[0] && lojaAtual[0].referencias) || [];
        if (ref0 && ref0.em && lista0.join(",") === nomes.join(",") && Date.now() - new Date(ref0.em).getTime() < REF_MS) return res.status(200).json({ ok: true, perfis: nomes, referencias: ref0 });
        if (ref0 && ref0.em && Date.now() - new Date(ref0.em).getTime() < 60000) return res.status(429).json({ error: "Espere um minutinho antes de trocar as referências de novo." });
        // guarda a lista na loja (cria a linha se ainda nao existir)
        const feito = await banco("lojas?user_id=eq." + id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: { referencias: nomes } });
        if (!feito || !feito.length) {
            const cc = await banco("connect_clientes?user_id=eq." + id + "&select=nome").catch(function () { return []; });
            await banco("lojas", { method: "POST", headers: { Prefer: "return=minimal" }, body: { user_id: uid, nome: (cc && cc[0] && cc[0].nome) || "Minha loja", referencias: nomes } });
        }
        const ref = await atualizarReferencias(uid, nomes);
        return res.status(200).json({ ok: true, perfis: nomes, referencias: ref });
    } catch (e) {
        console.error("[referencias] " + uid + ": " + (e && e.message));
        registrarFalha(uid, "lojas de referência", e && e.message);
        return res.status(500).json({ error: "Não consegui salvar as referências agora. Tente de novo." });
    }
};
