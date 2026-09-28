// =====================================================================
//  RODADA AUTOMATICA (a cada 5 minutos)
//  Chamada pelo agendador do banco (pg_cron do Supabase, a cada 5 minutos)
//  e, de reserva, pelo Vercel Cron uma vez por dia. So quem tem o CRON_SECRET chama.
//
//  1. Numeros (Reportei): cada loja a cada 30 minutos; a cada 5 minutos
//     enquanto a dona estiver usando o app.
//  2. Analises em andamento (contas_meta.dossie_job): confere o lote da
//     Anthropic ou roda a proxima etapa na hora.
//  3. Madrugada (3h as 7h): as lojas ativas (acesso nos ultimos 14 dias)
//     entram no lote, pela metade do preco, quando ha novidade (post, anuncio
//     ou produto novo; no maximo a cada 2 noites) ou a cada 3 noites.
//  4. Na hora: primeira analise, versao nova do time, loja que voltou depois
//     de parada (a dona abriu o app) ou loja ativa que ficou sem o lote.
// =====================================================================

const { banco } = require("./_seguranca.js");
const { atualizarLoja } = require("./_coleta.js");
const { iniciarAnalise, continuarAnalise, precisaAnalisarAgora, entraNoLote } = require("./_time-agentes.js");

const LIMITE_MS = 270000;               // para antes do tempo maximo da funcao
const JUNTAS = 3;                       // lojas atualizadas ao mesmo tempo
const NUMEROS_MS = 30 * 60000;          // numeros de cada loja a cada 30 minutos
const NUMEROS_USANDO_MS = 4 * 60000;    // ... e a cada rodada enquanto a dona usa o app
const USANDO_MS = 15 * 60000;           // abriu o app nos ultimos 15 minutos = usando
const ETAPA_ATE_MS = 150000;            // so comeca uma etapa na hora se ainda faltar tempo para ela terminar
const LOTE_ATE_MS = 200000;             // preparar o lote (consulta a Meta) leva ate 1 minuto por loja

function horaSP(d) { return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(d)) % 24; }

module.exports = async function handler(req, res) {
    const segredo = process.env.CRON_SECRET;
    const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (!segredo || auth !== "Bearer " + segredo) return res.status(401).json({ error: "Nao autorizado" });
    const inicio = Date.now();
    const passou = function () { return Date.now() - inicio; };
    try {
        const [clientes, contas, acessosRows] = await Promise.all([
            banco("connect_clientes?select=user_id,criado_em"),
            banco("contas_meta?select=user_id,metricas_em"),
            banco("acessos?select=user_id,em").catch(function () { return []; })
        ]);
        const acesso = {}, entrou = {}, quando = {};
        (acessosRows || []).forEach(function (a) { acesso[a.user_id] = a.em; });
        (clientes || []).forEach(function (c) { entrou[c.user_id] = c.criado_em; });
        (contas || []).forEach(function (c) { quando[c.user_id] = c.metricas_em ? new Date(c.metricas_em).getTime() : 0; });
        function usando(uid) { return acesso[uid] && inicio - new Date(acesso[uid]).getTime() < USANDO_MS; }

        // 1) numeros: quem ficou mais tempo sem atualizar vai primeiro
        const fila = (clientes || []).map(function (c) { return c.user_id; })
            .filter(function (uid) { const idade = inicio - (quando[uid] || 0); return idade >= NUMEROS_MS || (usando(uid) && idade >= NUMEROS_USANDO_MS); })
            .sort(function (a, b) { return (quando[a] || 0) - (quando[b] || 0); });
        const feitos = [], falhas = [], puladas = [];
        let i = 0;
        async function trabalhador() {
            while (i < fila.length) {
                if (passou() > LIMITE_MS) { puladas.push(fila[i++]); continue; }
                const uid = fila[i++];
                try { const r = await atualizarLoja(uid); feitos.push({ user_id: uid, posts: r.posts, anuncios: r.anuncios }); }
                catch (e) { falhas.push({ user_id: uid, erro: (e && e.message) || "erro" }); console.error("[atualizar] " + uid + ": " + (e && e.message)); }
            }
        }
        await Promise.all(Array.from({ length: Math.min(JUNTAS, fila.length) }, trabalhador));

        // estado das analises
        const [estado, lojasRows] = await Promise.all([
            banco("contas_meta?select=user_id,status,atualizado_em,assinatura:metricas->>assinatura,ultimo_post:metricas->organico->posts->0->>data,dossie_versao:dossie->>versao,dossie_em:dossie->>gerado_em,dossie_assinatura:dossie->>assinatura,job_modo:dossie_job->>modo,falhas_analise"),
            banco("lojas?select=user_id,produtos_dona_em").catch(function () { return []; })
        ]);
        const produtosEm = {};
        (lojasRows || []).forEach(function (l) { produtosEm[l.user_id] = l.produtos_dona_em; });
        const ativas = {};
        (clientes || []).forEach(function (c) { ativas[c.user_id] = 1; });
        const lojas = (estado || []).filter(function (c) { return ativas[c.user_id]; }).map(function (c) { return Object.assign({}, c, { tem_job: !!c.job_modo, produtos_em: produtosEm[c.user_id] || null }); });
        const analises = [], falhasAnalise = [];
        async function tentar(uid, oque, fn) {
            try { const r = await fn(); analises.push({ user_id: uid, oque: oque, status: r && r.status }); }
            catch (e) { falhasAnalise.push({ user_id: uid, oque: oque, erro: (e && e.message) || "erro" }); console.error("[atualizar] " + oque + " " + uid + ": " + (e && e.message)); }
        }
        const temTempo = function () { return passou() < ETAPA_ATE_MS; };

        // 2) analises em andamento: lote primeiro (so confere, e rapido); na hora, se houver tempo
        for (const c of lojas.filter(function (c) { return c.job_modo; }).sort(function (a, b) { return (a.job_modo === "lote" ? 0 : 1) - (b.job_modo === "lote" ? 0 : 1); })) {
            if (c.job_modo === "agora" && !temTempo()) break;
            if (passou() > LIMITE_MS - 30000) break;
            await tentar(c.user_id, "continuar", function () { return continuarAnalise(c.user_id, temTempo); });
        }

        // 3) madrugada: lojas ativas entram no lote diario
        const h = horaSP(new Date());
        if (h >= 3 && h < 7) {
            for (const c of lojas.filter(function (c) { return entraNoLote(c, inicio, acesso[c.user_id], entrou[c.user_id]); })) {
                if (passou() > LOTE_ATE_MS) break;
                await tentar(c.user_id, "lote", function () { return iniciarAnalise(c.user_id, "lote", "diaria"); });
            }
        }

        // 4) na hora: quem esta usando o app primeiro, depois a mais antiga (uma por rodada)
        const agora = lojas.filter(function (c) { return precisaAnalisarAgora(c, inicio, acesso[c.user_id], entrou[c.user_id]); })
            .sort(function (a, b) { return (usando(b.user_id) ? 1 : 0) - (usando(a.user_id) ? 1 : 0) || (a.dossie_em ? new Date(a.dossie_em).getTime() : 0) - (b.dossie_em ? new Date(b.dossie_em).getTime() : 0); });
        if (agora.length && passou() < 60000) {
            const c = agora[0];
            await tentar(c.user_id, "agora", async function () {
                await iniciarAnalise(c.user_id, "agora", c.dossie_em ? (usando(c.user_id) ? "voltou" : "sem_lote") : "primeira");
                return temTempo() ? continuarAnalise(c.user_id, temTempo) : { status: "etapa_feita" };
            });
        }

        return res.status(200).json({ ok: true, atualizadas: feitos.length, falhas: falhas, puladas: puladas.length, analises: analises, falhas_analise: falhasAnalise, na_fila_agora: Math.max(0, agora.length - 1), olhos: require("./_olhos.js").disponivel(), ms: passou() });
    } catch (e) {
        console.error("[atualizar] " + (e && e.message));
        return res.status(500).json({ error: (e && e.message) || "Erro na atualizacao" });
    }
};
