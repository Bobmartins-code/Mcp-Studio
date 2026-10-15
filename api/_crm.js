// =====================================================================
//  VENDAS DO CRM (so leitura, so totais)
//  O CRM da loja tem um relatorio fechado (supabase/crm-relatorio-mcp.sql, no
//  Supabase do CRM) que so devolve totais somados: faturamento, numero de vendas,
//  faixas de preco, dias fortes, clientes que voltam e DDD. Nome, telefone e
//  e-mail nunca saem de la. Aqui:
//    - faturamento de cada loja no periodo (coluna "Faturamento total" no Painel Admin)
//    - a calculadora (sem IA): transforma os totais em padroes de venda da loja e
//      cruza os dias de venda alta com os posts publicados antes deles; o resultado
//      fica em contas_meta.vendas e e lido pelo Agente de Vendas (api/_time-agentes.js)
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const crypto = require("crypto");
const { banco } = require("./_seguranca.js");

const DIA = 864e5;
const VENDAS_MS = 12 * 3600 * 1000;   // padroes de venda recalculados 2 vezes por dia

function disponivel() { return !!(process.env.CRM_URL && process.env.CRM_CHAVE && process.env.CRM_SEGREDO); }
async function rpc(nome, corpo) {
    const k = process.env.CRM_CHAVE, headers = { apikey: k, "Content-Type": "application/json" };
    if (k.indexOf("sb_") !== 0) headers.Authorization = "Bearer " + k; // chave antiga (JWT) vai tambem no Authorization
    const r = await fetch(process.env.CRM_URL + "/rest/v1/rpc/" + nome, { method: "POST", headers: headers, body: JSON.stringify(Object.assign({ p_segredo: process.env.CRM_SEGREDO }, corpo)), signal: AbortSignal.timeout(20000) });
    const txt = await r.text();
    if (!r.ok) throw new Error("CRM: " + txt.slice(0, 200));
    return txt ? JSON.parse(txt) : null;
}
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function arred(n, c) { const f = Math.pow(10, c || 0); return Math.round(num(n) * f) / f; }
function diaSP(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d); }
function mediana(v) { const a = v.slice().sort(function (x, y) { return x - y; }); if (!a.length) return 0; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }

// faturamento de cada conta do CRM no periodo (inicio nulo = desde a primeira venda)
async function faturamentoPorConta(inicio, fim) {
    const lista = await rpc("mcp_faturamento", { p_inicio: inicio || null, p_fim: fim });
    const out = {};
    (lista || []).forEach(function (x) { out[x.tenant] = x; });
    return out;
}
// soma as contas de cada loja (a Julia tem duas)
function somaDaLoja(porConta, tenants) {
    const t = (tenants || []).map(function (id) { return porConta[id]; }).filter(Boolean);
    if (!t.length) return null;
    return {
        faturamento: arred(t.reduce(function (s, x) { return s + num(x.faturamento); }, 0), 2), vendas: t.reduce(function (s, x) { return s + num(x.vendas); }, 0),
        primeira_venda: t.map(function (x) { return x.primeira_venda; }).filter(Boolean).sort()[0] || null,
        ultima_venda: t.map(function (x) { return x.ultima_venda; }).filter(Boolean).sort().reverse()[0] || null
    };
}

// ---------- DDD: regiao de cada codigo de area ----------
const DDD = {
    "11": ["São Paulo e Grande SP", "SP"], "12": ["São José dos Campos e Vale do Paraíba", "SP"], "13": ["Santos e Baixada Santista", "SP"], "14": ["Bauru e Marília", "SP"], "15": ["Sorocaba", "SP"], "16": ["Ribeirão Preto e Franca", "SP"],
    "17": ["São José do Rio Preto", "SP"], "18": ["Presidente Prudente e Araçatuba", "SP"], "19": ["Campinas e Piracicaba", "SP"], "21": ["Rio de Janeiro e Grande Rio", "RJ"], "22": ["Campos dos Goytacazes e Macaé", "RJ"],
    "24": ["Volta Redonda e Petrópolis", "RJ"], "27": ["Vitória e Grande Vitória", "ES"], "28": ["Cachoeiro de Itapemirim", "ES"], "31": ["Belo Horizonte e região", "MG"], "32": ["Juiz de Fora", "MG"], "33": ["Governador Valadares", "MG"],
    "34": ["Uberlândia e Triângulo Mineiro", "MG"], "35": ["Sul de Minas (Poços de Caldas e Varginha)", "MG"], "37": ["Divinópolis", "MG"], "38": ["Montes Claros e norte de Minas", "MG"], "41": ["Curitiba e região", "PR"],
    "42": ["Ponta Grossa", "PR"], "43": ["Londrina", "PR"], "44": ["Maringá", "PR"], "45": ["Cascavel e Foz do Iguaçu", "PR"], "46": ["Pato Branco e Francisco Beltrão", "PR"], "47": ["Joinville, Blumenau e Itajaí", "SC"],
    "48": ["Florianópolis e região", "SC"], "49": ["Chapecó e Lages", "SC"], "51": ["Porto Alegre e região", "RS"], "53": ["Pelotas", "RS"], "54": ["Caxias do Sul e serra gaúcha", "RS"], "55": ["Santa Maria", "RS"],
    "61": ["Brasília e entorno", "DF"], "62": ["Goiânia e região", "GO"], "63": ["Tocantins", "TO"], "64": ["Rio Verde e sul de Goiás", "GO"], "65": ["Cuiabá", "MT"], "66": ["Rondonópolis e interior de MT", "MT"],
    "67": ["Mato Grosso do Sul", "MS"], "68": ["Acre", "AC"], "69": ["Rondônia", "RO"], "71": ["Salvador e região", "BA"], "73": ["Ilhéus e Itabuna", "BA"], "74": ["Juazeiro (BA)", "BA"], "75": ["Feira de Santana", "BA"],
    "77": ["Vitória da Conquista e Barreiras", "BA"], "79": ["Sergipe", "SE"], "81": ["Recife e região", "PE"], "82": ["Alagoas", "AL"], "83": ["Paraíba", "PB"], "84": ["Rio Grande do Norte", "RN"], "85": ["Fortaleza e região", "CE"],
    "86": ["Teresina e norte do Piauí", "PI"], "87": ["Petrolina e sertão de PE", "PE"], "88": ["Juazeiro do Norte e interior do CE", "CE"], "89": ["Picos e sul do Piauí", "PI"], "91": ["Belém e região", "PA"], "92": ["Manaus e região", "AM"],
    "93": ["Santarém", "PA"], "94": ["Marabá", "PA"], "95": ["Roraima", "RR"], "96": ["Amapá", "AP"], "97": ["interior do Amazonas", "AM"], "98": ["São Luís e região", "MA"], "99": ["Imperatriz e interior do MA", "MA"]
};
const DIAS = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];
const FAIXAS_MES = ["dias 1 a 5", "dias 6 a 10", "dias 11 a 15", "dias 16 a 20", "dias 21 a 25", "dias 26 a 31"];
const MESES = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function pct(parte, todo) { return todo > 0 ? arred(parte / todo * 100, 0) : 0; }

// regiao: onde estao as clientes que compraram no ultimo ano
function regiaoDe(lista) {
    const tot = (lista || []).reduce(function (s, x) { return s + num(x.clientes); }, 0);
    if (!tot) return null;
    const porUF = {};
    const ddds = lista.map(function (x) { const d = DDD[x.ddd] || ["DDD " + x.ddd, "?"]; porUF[d[1]] = (porUF[d[1]] || 0) + num(x.clientes); return { ddd: x.ddd, regiao: d[0], uf: d[1], clientes: num(x.clientes), pct: pct(num(x.clientes), tot) }; });
    const ufs = Object.keys(porUF).map(function (k) { return { uf: k, pct: pct(porUF[k], tot) }; }).sort(function (a, b) { return b.pct - a.pct; });
    const topo = ddds[0] ? ddds[0].pct : 0, topoUF = ufs[0] ? ufs[0].pct : 0;
    return { ddds: ddds.slice(0, 8), estados: ufs.slice(0, 5), alcance: topo >= 60 ? "local" : topoUF >= 75 ? "regional" : "nacional", clientes_com_ddd: tot };
}

// conteudo antes das vendas: cada post comparado com o normal daquele dia da semana nos 3 dias seguintes
function conteudoAntesDasVendas(diario, posts) {
    const hoje = diaSP(new Date()), porDia = {};
    (diario || []).forEach(function (x) { porDia[String(x.d).slice(0, 10)] = num(x.f); });
    const dias = [];
    for (let i = 90; i >= 1; i--) dias.push(diaSP(new Date(Date.now() - i * DIA)));
    const comVenda = dias.filter(function (d) { return porDia[d] > 0; }).length;
    if (comVenda < 30) return { pouco_dado: true, dias_com_venda: comVenda };
    const dow = function (d) { return new Date(d + "T12:00:00Z").getUTCDay(); };
    const normal = {};
    [0, 1, 2, 3, 4, 5, 6].forEach(function (w) { normal[w] = mediana(dias.filter(function (d) { return dow(d) === w; }).map(function (d) { return porDia[d] || 0; })); });
    const esperado = function (d) { return normal[dow(d)]; };
    const fortes = dias.filter(function (d) { return esperado(d) > 0 && (porDia[d] || 0) >= esperado(d) * 1.5; });
    const medidos = (posts || []).filter(function (p) { return p.data; }).map(function (p) {
        const d0 = diaSP(new Date(p.data)), janela = [0, 1, 2].map(function (k) { return diaSP(new Date(new Date(d0 + "T12:00:00Z").getTime() + k * DIA)); });
        if (janela[2] >= hoje || janela[0] < dias[0]) return null;
        const real = janela.reduce(function (s, d) { return s + (porDia[d] || 0); }, 0), esp = janela.reduce(function (s, d) { return s + esperado(d); }, 0);
        if (!(esp > 0)) return null;
        return { data: d0, tipo: p.tipo || "Post", legenda: String(p.legenda || "").replace(/\s+/g, " ").trim().slice(0, 110), visualizacoes: num(p.visualizacoes), razao: arred(real / esp, 2) };
    }).filter(Boolean);
    const porTipo = {};
    medidos.forEach(function (m) { (porTipo[m.tipo] = porTipo[m.tipo] || []).push(m.razao); });
    return {
        dias_com_venda: comVenda, dias_fortes: fortes.length,
        por_tipo: Object.keys(porTipo).filter(function (k) { return porTipo[k].length >= 3; }).map(function (k) { return { tipo: k, posts: porTipo[k].length, razao_mediana: arred(mediana(porTipo[k]), 2) }; }).sort(function (a, b) { return b.razao_mediana - a.razao_mediana; }),
        antes_de_dias_fortes: medidos.filter(function (m) { return m.razao >= 1.3; }).sort(function (a, b) { return b.razao - a.razao; }).slice(0, 6),
        antes_de_dias_fracos: medidos.filter(function (m) { return m.razao <= 0.7; }).sort(function (a, b) { return a.razao - b.razao; }).slice(0, 3),
        posts_medidos: medidos.length
    };
}

// a calculadora: os totais do CRM viram os padroes de venda da loja
function montarVendas(b, posts) {
    const d90 = b.d90 || {}, d365 = b.d365 || {}, cl = b.clientes || {};
    const totalAno = num(d365.faturamento), vendasAno = num(d365.vendas);
    const semana = (b.dia_semana || []).map(function (x) { return { dia: DIAS[x.dia], pct_faturamento: pct(num(x.faturamento), totalAno), vendas: num(x.vendas) }; });
    const mes = (b.dia_mes || []).map(function (x) { return { faixa: FAIXAS_MES[x.faixa], pct_faturamento: pct(num(x.faturamento), totalAno) }; });
    const quinzena1 = (b.dia_mes || []).filter(function (x) { return x.faixa <= 2; }).reduce(function (s, x) { return s + num(x.faturamento); }, 0);
    const meses = (b.meses || []).map(function (x) { const p = String(x.mes).split("-"); return { mes: MESES[Number(p[1])] + "/" + p[0], faturamento: arred(x.faturamento, 0), vendas: num(x.vendas) }; });
    const fat90 = num(cl.d90_fat_novas) + num(cl.d90_fat_voltaram);
    const out = {
        primeira_venda: b.primeira_venda, ultima_venda: b.ultima_venda,
        d90: { faturamento: arred(d90.faturamento, 2), vendas: num(d90.vendas), ticket_medio: arred(d90.ticket_medio, 2), ticket_mediana: arred(d90.ticket_mediana, 2) },
        d365: { faturamento: arred(totalAno, 2), vendas: vendasAno, ticket_medio: arred(d365.ticket_medio, 2), ticket_mediana: arred(d365.ticket_mediana, 2) },
        faixas: (b.faixas || []).map(function (x) { return { faixa: x.faixa, pct_vendas: pct(num(x.vendas), vendasAno), pct_faturamento: pct(num(x.faturamento), totalAno) }; }),
        semana: semana, mes: mes, quinzena_1_pct: pct(quinzena1, totalAno), meses: meses,
        clientes: {
            total: num(cl.total), voltaram_pct: pct(num(cl.voltaram), num(cl.total)), voltaram_em_60_dias_pct: pct(num(cl.voltaram_em_60_dias), num(cl.total)),
            mediana_dias_segunda: cl.mediana_dias_segunda != null ? num(cl.mediana_dias_segunda) : null,
            d90_novas: num(cl.d90_novas), d90_voltaram: num(cl.d90_voltaram), d90_fat_voltaram_pct: pct(num(cl.d90_fat_voltaram), fat90)
        },
        regiao: regiaoDe(b.ddd),
        conteudo: conteudoAntesDasVendas(b.diario, posts)
    };
    out.assinatura = crypto.createHash("md5").update([out.ultima_venda, out.d365.vendas, out.d90.faturamento].join("|")).digest("hex").slice(0, 12);
    return out;
}

// recalcula os padroes de venda das lojas ligadas ao CRM que estao vencidos (api/atualizar.js)
async function atualizarVendas(limite, prazo) {
    if (!disponivel()) return { feitas: 0, motivo: "CRM nao configurado" };
    const [lojas, contas] = await Promise.all([
        banco("lojas?crm_tenants=not.is.null&select=user_id,crm_tenants"),
        banco("contas_meta?select=user_id,vendas_em:vendas->>em")
    ]);
    const em = {};
    (contas || []).forEach(function (c) { em[c.user_id] = c.vendas_em ? new Date(c.vendas_em).getTime() : 0; });
    const fila = (lojas || []).filter(function (l) { return (l.crm_tenants || []).length && Date.now() - (em[l.user_id] || 0) >= VENDAS_MS; })
        .sort(function (a, b) { return (em[a.user_id] || 0) - (em[b.user_id] || 0); }).slice(0, limite || 2);
    let feitas = 0;
    for (const l of fila) {
        if (prazo && Date.now() > prazo) break;
        try { await vendasDaLoja(l.user_id, l.crm_tenants); feitas++; }
        catch (e) { console.error("[crm] " + l.user_id.slice(0, 8) + ": " + (e && e.message)); }
    }
    return { feitas: feitas, na_fila: fila.length };
}
async function vendasDaLoja(userId, tenants) {
    const id = encodeURIComponent(userId);
    const [bruto, conta] = await Promise.all([
        rpc("mcp_vendas", { p_tenants: tenants }),
        banco("contas_meta?user_id=eq." + id + "&select=posts:metricas->organico->posts,leitura:vendas->leitura")
    ]);
    const posts = (conta && conta[0] && conta[0].posts) || [];
    // a leitura do Agente de Vendas continua (ele roda de novo quando as vendas mudam: api/_time-agentes.js)
    const vendas = Object.assign(montarVendas(bruto || {}, posts), { em: new Date().toISOString(), contas_crm: tenants.length, leitura: (conta && conta[0] && conta[0].leitura) || null });
    await banco("contas_meta?user_id=eq." + id, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { vendas: vendas } });
    return vendas;
}

module.exports = { disponivel, faturamentoPorConta, somaDaLoja, atualizarVendas, vendasDaLoja, montarVendas, _interno: { regiaoDe, conteudoAntesDasVendas, DDD } };
