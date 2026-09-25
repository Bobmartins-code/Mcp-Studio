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

const { validarAdmin, banco, criptografar, auditar } = require("./_seguranca.js");
const { PLATAFORMAS, ErroConnect, connect, clienteDoUsuario, integracoesDoCliente } = require("./_reportei.js");
const { atualizarLoja } = require("./_coleta.js");
const { analisarLoja } = require("./_time-agentes.js");

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

        // lista quem ja foi ativada (sem os tokens)
        if (b.acao === "listar") {
            const rows = await banco("connect_clientes?select=user_id,customer_uuid,nome,criado_em");
            // so os campos publicos saem daqui, nunca o token
            return res.status(200).json({ clientes: (rows || []).map(function (c) { return { user_id: c.user_id, customer_uuid: c.customer_uuid, nome: c.nome, criado_em: c.criado_em }; }) });
        }

        // cria a cliente no Connect e guarda o token dela na mesma hora (ele so aparece nesta resposta)
        if (b.acao === "ativar") {
            if (!b.user_id) throw new ErroConnect(400, { message: "Informe a cliente." });
            const existe = await banco("connect_clientes?user_id=eq." + encodeURIComponent(b.user_id) + "&select=customer_uuid");
            if (existe && existe.length) return res.status(200).json({ ok: true, ja_existia: true });
            const d = await connect("/customers", { method: "POST", body: { name: String(b.nome || "Cliente").slice(0, 255) } });
            const c = d.customer;
            try {
                await banco("connect_clientes", { method: "POST", body: { user_id: b.user_id, customer_uuid: c.uuid, api_token: criptografar(c.api_token), nome: c.name } });
            } catch (e) {
                // sem o token salvo a cliente fica inutil: desfaz no Connect para nao deixar orfa
                try { await connect("/customers/" + c.uuid, { method: "DELETE" }); } catch (_) {}
                throw e;
            }
            await auditar(admin.id, "ativou cliente no Reportei Connect", b.user_id);
            return res.status(200).json({ ok: true, customer_uuid: c.uuid, teste_ate: c.trial_ends_at });
        }

        // link da tela onde as contas (Instagram e Meta Ads) sao autorizadas
        if (b.acao === "sessao") {
            const cli = await clienteDoUsuario(b.user_id);
            await auditar(admin.id, "abriu tela de conexao de contas", b.user_id);
            const corpo = { locale: "pt_BR", close_on_finish: true, expires_in_minutes: 60, limits: [{ name: "available_integrations", value: PLATAFORMAS }] };
            if (b.redirect_url) { corpo.redirect_url = b.redirect_url; corpo.close_on_finish = false; }
            const d = await connect("/customer-integrations/session", { method: "POST", body: corpo, customerToken: cli.api_token });
            return res.status(200).json({ link: d.integration_session.session_link, expira: d.integration_session.expires_at });
        }

        // o que a cliente ja conectou (e o uuid de cada conexao, que as metricas pedem)
        if (b.acao === "integracoes") {
            const cli = await clienteDoUsuario(b.user_id);
            return res.status(200).json({ integracoes: await integracoesDoCliente(cli) });
        }

        // metricas de uma conexao num periodo
        if (b.acao === "metricas") {
            const cli = await clienteDoUsuario(b.user_id);
            if (!b.integracao || !Array.isArray(b.metrics) || !b.metrics.length || !b.start || !b.end) throw new ErroConnect(400, { message: "Informe integracao, periodo e metricas." });
            const d = await connect("/metrics/get-data", { method: "POST", customerToken: cli.api_token, timeout: 100000, body: { customer_integration: b.integracao, start: b.start, end: b.end, client_timezone: "America/Sao_Paulo", metrics: b.metrics } });
            return res.status(200).json(d);
        }

        // puxa agora os posts e anuncios da loja e grava os numeros (o mesmo que a atualizacao diaria faz)
        if (b.acao === "atualizar") {
            if (!b.user_id) throw new ErroConnect(400, { message: "Informe a loja." });
            const r = await atualizarLoja(b.user_id);
            await auditar(admin.id, "atualizou os numeros da loja", b.user_id);
            return res.status(200).json(Object.assign({ ok: true }, r));
        }

        // roda agora o time de agentes da loja (organico, anuncios, publico e diretor)
        if (b.acao === "analisar") {
            if (!b.user_id) throw new ErroConnect(400, { message: "Informe a loja." });
            const r = await analisarLoja(b.user_id, "manual");
            await auditar(admin.id, "rodou o time de agentes da loja", b.user_id);
            return res.status(200).json(r);
        }

        return res.status(400).json({ error: "Acao desconhecida" });
    } catch (e) {
        const st = (e && e.status) || 500;
        return res.status(st >= 400 && st < 600 ? st : 500).json({ error: (e && e.message) || "Erro no Reportei Connect", extra: e && e.extra });
    }
};
