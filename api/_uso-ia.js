// =====================================================================
//  GASTO DE IA
//  Cada chamada de IA grava quanto usou (tabela uso_ia), por loja e por
//  funcao, para o painel admin mostrar o custo real de cada cliente.
//  Precos oficiais por milhao de unidades de texto (platform.claude.com,
//  set/2026). Lote (Batch API) sai pela metade.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const { banco } = require("./_seguranca.js");

// [entrada, saida, leitura do cache, escrita do cache (5 min)] em US$ por milhao
const PRECOS = {
    "claude-sonnet-5": [2, 10, 0.2, 2.5],
    "claude-opus-5-5": [4, 20, 0.2, 5],
    "claude-opus-5": [5, 25, 0.5, 6.25],
    "claude-haiku-4-5-20251001": [1, 5, 0.1, 1.25]
};

function custoDe(modelo, u, lote) {
    const p = PRECOS[modelo] || PRECOS["claude-sonnet-5"];
    u = u || {};
    const usd = ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6;
    return lote ? usd / 2 : usd;
}

// grava sem atrasar nem derrubar quem chamou
function registrarUso(userId, funcao, modelo, usage, lote) {
    if (!usage) return Promise.resolve();
    const linha = {
        user_id: userId || null, funcao: String(funcao || "").slice(0, 60), modelo: modelo, lote: !!lote,
        entrada: usage.input_tokens || 0, saida: usage.output_tokens || 0,
        cache_leitura: usage.cache_read_input_tokens || 0, cache_escrita: usage.cache_creation_input_tokens || 0,
        custo_usd: Math.round(custoDe(modelo, usage, lote) * 1e6) / 1e6
    };
    return banco("uso_ia", { method: "POST", headers: { Prefer: "return=minimal" }, body: linha })
        .catch(function (e) { console.error("[uso_ia] " + (e && e.message)); });
}

// erro que a dona viu (roteiro, chat, analise do video...): o Painel Admin mostra os dos ultimos 7 dias
function registrarFalha(userId, onde, erro) {
    return banco("falhas", { method: "POST", headers: { Prefer: "return=minimal" }, body: { user_id: userId || null, onde: String(onde || "").slice(0, 60), erro: String(erro || "").slice(0, 300) } })
        .catch(function (e) { console.error("[falhas] " + (e && e.message)); });
}

module.exports = { registrarUso, registrarFalha, custoDe, PRECOS };
