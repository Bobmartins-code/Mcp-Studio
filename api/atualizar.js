// =====================================================================
//  ATUALIZACAO DOS NUMEROS, A CADA 5 MINUTOS
//  Chamado pelo agendador do banco (pg_cron do Supabase, a cada 5 minutos)
//  e, de reserva, pelo Vercel Cron uma vez por dia. Para cada loja ativada
//  no Reportei Connect: puxa posts e anuncios e grava em contas_meta.metricas
//  + uma foto do dia em metricas_diarias. So quem tem o CRON_SECRET chama.
// =====================================================================

const { banco } = require("./_seguranca.js");
const { atualizarLoja } = require("./_coleta.js");

const LIMITE_MS = 270000; // para antes do tempo maximo da funcao
const JUNTAS = 3;         // lojas atualizadas ao mesmo tempo
const INTERVALO_MS = 4 * 60000; // loja atualizada ha menos que isso fica para a proxima rodada

module.exports = async function handler(req, res) {
    const segredo = process.env.CRON_SECRET;
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (!segredo || auth !== "Bearer " + segredo) return res.status(401).json({ error: "Nao autorizado" });
    const inicio = Date.now();
    try {
        // quem ficou mais tempo sem atualizar vai primeiro
        const [clientes, contas] = await Promise.all([
            banco("connect_clientes?select=user_id"),
            banco("contas_meta?select=user_id,metricas_em")
        ]);
        const quando = {};
        (contas || []).forEach(function (c) { quando[c.user_id] = c.metricas_em ? new Date(c.metricas_em).getTime() : 0; });
        const fila = (clientes || []).map(function (c) { return c.user_id; }).filter(function (uid) { return inicio - (quando[uid] || 0) >= INTERVALO_MS; }).sort(function (a, b) { return (quando[a] || 0) - (quando[b] || 0); });
        const feitos = [], falhas = [], puladas = [];
        let i = 0;
        async function trabalhador() {
            while (i < fila.length) {
                if (Date.now() - inicio > LIMITE_MS) { puladas.push(fila[i++]); continue; }
                const uid = fila[i++];
                try { const r = await atualizarLoja(uid); feitos.push({ user_id: uid, posts: r.posts, anuncios: r.anuncios }); }
                catch (e) { falhas.push({ user_id: uid, erro: (e && e.message) || "erro" }); console.error("[atualizar] " + uid + ": " + (e && e.message)); }
            }
        }
        await Promise.all(Array.from({ length: Math.min(JUNTAS, fila.length) }, trabalhador));
        return res.status(200).json({ ok: true, atualizadas: feitos.length, falhas: falhas, puladas: puladas.length, ms: Date.now() - inicio });
    } catch (e) {
        console.error("[atualizar] " + (e && e.message));
        return res.status(500).json({ error: (e && e.message) || "Erro na atualizacao" });
    }
};
