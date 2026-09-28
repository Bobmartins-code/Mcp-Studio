// =====================================================================
//  BANCO DE TESTES DOS PROMPTS (roda no computador, nao vai para o site)
//
//  Antes de publicar uma mudanca nos prompts dos agentes, rode:
//      node testes/banco-de-testes.js --lojas=3 --rotulo=depois
//  Ele:
//   1. baixa um retrato de lojas reais (Supabase pela linha de comando) para
//      a pasta temporaria do Windows (os dados das clientes nao vao para o
//      projeto nem para o OneDrive);
//   2. gera as ideias (3 especialistas + curador) e uma rodada de roteiros
//      com os prompts ATUAIS do codigo, sem gravar nada no banco;
//   3. confere tudo sozinho (ingles, codigos internos, travessao, numero que
//      nao esta nos dados, gancho longo, aberturas repetidas) e pede notas a
//      um juiz (de 1 a 5: especifico da loja, usa os dados, simples, gravavel);
//   4. monta um relatorio HTML comparando com a rodada anterior.
//
//  Precisa da chave da Anthropic: set ANTHROPIC_API_KEY=... ou --env=<arquivo .env>
//  Opcoes: --lojas=N (padrao 2) | --so=ideias|roteiros | --rotulo=nome | --metodo=fffundo
//  Custo aproximado: US$ 0,80 por loja (ideias + roteiros + juiz).
// =====================================================================

const fs = require("fs"), path = require("path"), os = require("os");
const { execSync } = require("child_process");
const RAIZ = path.resolve(__dirname, "..");
const ARG = {};
process.argv.slice(2).forEach(function (a) { const m = a.match(/^--([^=]+)=?(.*)$/); if (m) ARG[m[1]] = m[2] || true; });
const PASTA = path.join(os.tmpdir(), "mcp-banco-de-testes");
const PROJETO_SUPABASE = "yutqrrcdlkocrpznryqi";
fs.mkdirSync(PASTA, { recursive: true });

if (ARG.env) fs.readFileSync(ARG.env, "utf8").split(/\r?\n/).forEach(function (l) { const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; });
if (!process.env.ANTHROPIC_API_KEY) { console.error("Falta a chave: set ANTHROPIC_API_KEY=... ou --env=<arquivo>"); process.exit(1); }

// o codigo dos agentes roda aqui com um banco de mentira (nada e gravado)
const seg = require(path.join(RAIZ, "api/_seguranca.js"));
let banco = null;
seg.banco = async function (rota, op) { return banco ? banco(rota, op) : []; };
seg.acessoLiberado = async function () { return "teste"; };
const TA = require(path.join(RAIZ, "api/_time-agentes.js"));
const C = TA.conversa, X = TA._teste;

function sql(q) {
    const saida = execSync('npx -y supabase db query --linked --project-ref ' + PROJETO_SUPABASE + ' -o json "' + q.replace(/"/g, '\\"') + '"', { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 200 * 1024 * 1024 });
    return JSON.parse(saida.slice(saida.indexOf("{"))).rows || [];
}
function corta(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; }
function esc(t) { return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

// ---------- conferencia automatica ----------
const INGLES = /\b(already|loop|take|hook|trend|trending|call to action|cta|engagement|reach|scroll|b-roll|voice ?over|lifestyle|outfit|mood|vibe|insight|storytelling|lettering|feedback|unboxing|haul|try ?on|get ready with me|grwm)\b/i;
function conferir(textos, fonte) {
    const tudo = textos.join(" "), achados = [];
    const ing = tudo.match(new RegExp(INGLES.source, "gi"));
    if (ing) achados.push("inglês: " + Array.from(new Set(ing.map(function (x) { return x.toLowerCase(); }))).join(", "));
    const cod = tudo.match(/\b[PA]\d{1,2}\b/g);
    if (cod) achados.push("código interno: " + Array.from(new Set(cod)).join(", "));
    if (/[—–]/.test(tudo)) achados.push("travessão");
    const fonteNum = String(fonte || "").replace(/[\s.,]/g, "");
    const nums = (tudo.match(/R\$\s?\d[\d.,]*|\d+[.,]?\d*\s?%/g) || []).map(function (n) { return (n.match(/\d[\d.,]*/) || [""])[0].replace(/[.,]/g, ""); });
    const inv = Array.from(new Set(nums.filter(function (n) { return n && fonteNum.indexOf(n) < 0; })));
    if (inv.length) achados.push("número fora dos dados: " + inv.join(", "));
    return achados;
}
function aberturasRepetidas(ganchos) {
    const vistos = {}, rep = [];
    ganchos.forEach(function (g) { const k = String(g || "").toLowerCase().replace(/[^a-zà-ú0-9 ]/gi, "").split(/\s+/).slice(0, 3).join(" "); if (k && vistos[k]) rep.push(k); vistos[k] = 1; });
    return rep;
}

// ---------- juiz ----------
const ESQ_JUIZ = C.objeto({
    notas: {
        type: "array", items: C.objeto({
            item: { type: "integer", description: "Número do item avaliado." },
            especifico: { type: "integer", description: "1 a 5: só esta loja poderia usar (5) ou serve para qualquer loja (1)." },
            usa_dados: { type: "integer", description: "1 a 5: apoiado nos números, comentários, produtos ou público desta loja." },
            simples: { type: "integer", description: "1 a 5: a dona entende de primeira, sem jargão nem inglês." },
            gravavel: { type: "integer", description: "1 a 5: dá para gravar só com o celular seguindo o texto." },
            comentario: C.textoPT("O ponto mais fraco em 1 frase curta.")
        })
    }
});
async function julgar(resumoLoja, itens) {
    const r = await C.perguntar(null, {
        nome: "Juiz do banco de testes", esquema: ESQ_JUIZ, max: 6000, modelo: "claude-sonnet-5", effort: "low",
        pedido: "Você avalia, com rigor, conteúdos sugeridos para uma loja brasileira. Dê notas de 1 a 5 para cada item. Seja exigente: 5 só quando está excelente. Vídeo curto com cortes rápidos é o formato pedido pela consultoria: não tire nota pelo formato, avalie se os passos explicam como gravar sozinha com o celular apoiado e juntar os cortes no editor do Instagram.\n\nRESUMO DA LOJA: " + corta(resumoLoja, 3000) + "\n\nITENS:\n" + itens.map(function (x, i) { return (i + 1) + ") " + corta(JSON.stringify(x), 1800); }).join("\n")
    });
    return r.notas || [];
}
function media(notas, campo) { const v = notas.map(function (n) { return Number(n[campo]) || 0; }).filter(Boolean); return v.length ? Math.round(v.reduce(function (s, x) { return s + x; }, 0) / v.length * 100) / 100 : 0; }

// ---------- um caso (uma loja) ----------
async function rodarCaso(caso) {
    const out = { loja: caso.nome, ideias: [], roteiros: [], problemas: [] };
    const base = { userId: "teste", conta: { metricas: caso.metricas, meta: caso.meta, dossie: caso.dossie, memoria: caso.memoria, referencias: caso.referencias }, met: caso.metricas, dossie: caso.dossie || {}, loja: caso.loja || {}, projetos: [], memoria: caso.memoria || {}, gostei: [], conversas: [], semana: [] };
    const ctx = await C.preparar(base, false);
    const fonte = JSON.stringify(caso.dossie || {}) + JSON.stringify((caso.metricas && caso.metricas.organico && caso.metricas.organico.posts) || []).slice(0, 200000) + JSON.stringify((caso.metricas && caso.metricas.anuncios) || {}).slice(0, 200000) + JSON.stringify(caso.loja || {});
    const resumo = (caso.dossie && (caso.dossie.resumo_loja || caso.dossie.texto)) || caso.nome;
    if (ARG.so !== "roteiros") {
        const p = { org: caso.dossie.organico && caso.dossie.organico.relatorio, ads: caso.dossie.anuncios && caso.dossie.anuncios.relatorio, pub: caso.dossie.publico, mem: null };
        const t0 = Date.now();
        if (X.pedidoDiretor) { await X.rodarAgora(ctx, [X.pedidoDiretor(ctx, p)], p); out.oportunidades = ((p.dir && p.dir.oportunidades) || []).map(function (o) { return o.titulo; }); }
        await X.rodarAgora(ctx, X.pedidosEspecialistas(ctx, p, []), p);
        await X.rodarAgora(ctx, [X.pedidoCurador(ctx, p)], p);
        const feitas = X.montarIdeias(p, X.mapaDeCodigos(ctx));
        out.tempo_ideias_s = Math.round((Date.now() - t0) / 1000);
        out.ideias = feitas.lista.map(function (i) { return { titulo: i.titulo, formato: i.formato, tipo: i.tipo, gancho: i.gancho, passos: i.passos, fala: i.fala, por_que: i.por_que, metrica: i.metrica, problemas: conferir([i.titulo, i.gancho, (i.passos || []).join(" "), i.texto_na_tela, i.fala, i.por_que, i.metrica], fonte) }; });
        const rep = aberturasRepetidas(out.ideias.map(function (i) { return i.gancho; }));
        if (rep.length) out.problemas.push("ideias com abertura repetida: " + rep.join(" | "));
        out.notas_ideias = await julgar(resumo, out.ideias.map(function (i) { return { titulo: i.titulo, formato: i.formato, gancho: i.gancho, passos: i.passos, fala: i.fala, por_que: i.por_que }; }));
    }
    if (ARG.so !== "ideias") {
        let rodadas = [];
        banco = async function (rota, op) {
            if (op && op.method === "PATCH" && /^projetos/.test(rota)) { if (op.body.rodadas) rodadas = op.body.rodadas; return []; }
            if (op && op.method) return [];
            if (/^projetos/.test(rota)) return [{ id: "00000000-0000-0000-0000-000000000001", nome: "Teste", objetivo: "mensagens", form: { objetivo: "mensagens" }, rodadas: rodadas }];
            if (/^contas_meta/.test(rota)) return [{ dossie: caso.dossie, memoria: caso.memoria }];
            if (/^lojas/.test(rota)) return [caso.loja || {}];
            return [];
        };
        delete require.cache[require.resolve(path.join(RAIZ, "api/roteiros.js"))];
        const handler = require(path.join(RAIZ, "api/roteiros.js"));
        const produto = (caso.loja && (caso.loja.produtos_dona || caso.loja.produtos_admin)) || ((caso.dossie.ideias && caso.dossie.ideias.lista && caso.dossie.ideias.lista[0] && caso.dossie.ideias.lista[0].peca) || "a peça que mais vende");
        const t0 = Date.now();
        await handler({ method: "POST", headers: { authorization: "Bearer x" }, body: { projeto_id: "00000000-0000-0000-0000-000000000001", metodo: ARG.metodo || "fffundo", formato: "narrado", renomear: false, contexto: "Produto: " + corta(produto, 500) + ". Destino: conversa no direct." } }, { status: function () { return this; }, json: function () {} });
        banco = null;
        out.tempo_roteiros_s = Math.round((Date.now() - t0) / 1000);
        const r = rodadas[rodadas.length - 1] || {};
        out.roteiros = ((r.resultado && r.resultado.roteiros) || []).map(function (s) { return { titulo: s.titulo, estrutura: s.estrutura, gancho: s.gancho, aberturas_extras: s.aberturas_extras, corpo: s.corpo, cta: s.cta, legenda: s.legenda, duracao_s: s.duracao_s, cenas: (s.cenas || []).length, problemas: conferir([s.titulo, s.gancho, s.corpo, s.cta, s.legenda, (s.aberturas_extras || []).join(" ")], fonte + produto) }; });
        const rep = aberturasRepetidas(out.roteiros.map(function (s) { return s.gancho; }));
        if (rep.length) out.problemas.push("roteiros com abertura repetida: " + rep.join(" | "));
        if (out.roteiros.length) out.notas_roteiros = await julgar(resumo, out.roteiros.map(function (s) { return { titulo: s.titulo, gancho: s.gancho, corpo: s.corpo, cta: s.cta }; }));
    }
    return out;
}

// ---------- relatorio ----------
function resumoRodada(casos) {
    const todasI = [], todasR = [];
    let probs = 0;
    casos.forEach(function (c) { (c.notas_ideias || []).forEach(function (n) { todasI.push(n); }); (c.notas_roteiros || []).forEach(function (n) { todasR.push(n); }); probs += c.problemas.length; c.ideias.concat(c.roteiros).forEach(function (x) { probs += (x.problemas || []).length; }); });
    const campos = ["especifico", "usa_dados", "simples", "gravavel"], r = { problemas: probs, ideias: {}, roteiros: {} };
    campos.forEach(function (k) { r.ideias[k] = media(todasI, k); r.roteiros[k] = media(todasR, k); });
    return r;
}
function relatorio(atual, anterior) {
    const nomes = { especifico: "Específico da loja", usa_dados: "Usa os dados", simples: "Simples", gravavel: "Gravável" };
    function linhaNotas(tipo) {
        return Object.keys(nomes).map(function (k) {
            const a = atual.resumo[tipo][k], b = anterior && anterior.resumo[tipo][k];
            const d = b ? Math.round((a - b) * 100) / 100 : null;
            return "<tr><td>" + nomes[k] + "</td><td><b>" + a + "</b></td><td>" + (b != null ? b : "-") + "</td><td style='color:" + (d > 0 ? "#2DDE98" : d < 0 ? "#FF6B5A" : "#999") + "'>" + (d == null ? "" : (d > 0 ? "+" : "") + d) + "</td></tr>";
        }).join("");
    }
    function lista(itens, notas, tipo) {
        return itens.map(function (x, i) {
            const n = (notas || []).find(function (y) { return y.item === i + 1; }) || {};
            return "<div class='it'><div class='t'>" + (i + 1) + ". " + esc(x.titulo) + " <span class='f'>" + esc(tipo === "ideia" ? x.formato + (x.tipo === "refazer_campeao" ? " · refazer campeão" : "") : x.estrutura + " · " + x.duracao_s + " s · " + x.cenas + " cenas") + "</span></div>" +
                "<div>" + esc(x.gancho) + "</div>" + (tipo === "roteiro" ? "<div class='c'>" + esc(x.corpo) + " <i>" + esc(x.cta) + "</i></div>" : "<div class='c'>" + esc(x.por_que) + "</div>") +
                "<div class='n'>notas: específico " + (n.especifico || "-") + " · dados " + (n.usa_dados || "-") + " · simples " + (n.simples || "-") + " · gravável " + (n.gravavel || "-") + (n.comentario ? " · <i>" + esc(n.comentario) + "</i>" : "") + "</div>" +
                ((x.problemas || []).length ? "<div class='p'>⚠ " + esc(x.problemas.join(" | ")) + "</div>" : "") + "</div>";
        }).join("");
    }
    return "<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'><title>Banco de testes · " + esc(atual.rotulo) + "</title><style>body{font-family:system-ui,sans-serif;background:#0A0A0F;color:#F0EEE8;max-width:1100px;margin:0 auto;padding:24px;line-height:1.5}h1,h2{margin:18px 0 8px}table{border-collapse:collapse}td,th{padding:4px 12px;border-bottom:1px solid #333;text-align:left}.it{background:#15151C;border:1px solid #2A2A33;border-radius:10px;padding:10px 12px;margin:8px 0}.t{font-weight:700}.f{font-weight:400;color:#FF8A50;font-size:12px}.c{color:#B8B6AF;font-size:14px}.n{font-size:12.5px;color:#9B9BAA;margin-top:4px}.p{font-size:12.5px;color:#FF6B5A;margin-top:4px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:800px){.cols{grid-template-columns:1fr}}</style></head><body>" +
        "<h1>Banco de testes dos prompts</h1><div>Rodada <b>" + esc(atual.rotulo) + "</b> em " + new Date(atual.em).toLocaleString("pt-BR") + (anterior ? " · comparando com <b>" + esc(anterior.rotulo) + "</b> de " + new Date(anterior.em).toLocaleString("pt-BR") : " · primeira rodada") + "</div>" +
        "<p>Problemas encontrados pela conferência automática: <b>" + atual.resumo.problemas + "</b>" + (anterior ? " (antes: " + anterior.resumo.problemas + ")" : "") + "</p>" +
        "<div class='cols'><div><h2>Ideias</h2><table><tr><th></th><th>Agora</th><th>Antes</th><th>Diferença</th></tr>" + linhaNotas("ideias") + "</table></div><div><h2>Roteiros</h2><table><tr><th></th><th>Agora</th><th>Antes</th><th>Diferença</th></tr>" + linhaNotas("roteiros") + "</table></div></div>" +
        atual.casos.map(function (c) {
            return "<h2>" + esc(c.loja) + "</h2>" + (c.problemas.length ? "<div class='p'>⚠ " + esc(c.problemas.join(" | ")) + "</div>" : "") +
                "<div class='cols'><div><h3>Ideias (" + c.ideias.length + (c.tempo_ideias_s ? ", " + c.tempo_ideias_s + " s" : "") + ")</h3>" + lista(c.ideias, c.notas_ideias, "ideia") +
                ((c.oportunidades || []).length ? "<div class='n'>Oportunidades cruzadas: " + esc(c.oportunidades.join(' · ')) + "</div>" : "") + "</div>" +
                "<div><h3>Roteiros (" + c.roteiros.length + (c.tempo_roteiros_s ? ", " + c.tempo_roteiros_s + " s" : "") + ")</h3>" + lista(c.roteiros, c.notas_roteiros, "roteiro") + "</div></div>";
        }).join("") + "</body></html>";
}

(async function () {
    const n = Math.max(1, Math.min(6, Number(ARG.lojas) || 2));
    console.log("Baixando o retrato de " + n + " lojas...");
    const ids = sql("select c.user_id from contas_meta c where c.dossie->>'versao'='4' and c.metricas is not null order by c.atualizado_em desc limit " + n).map(function (r) { return r.user_id; });
    const casos = [];
    for (const id of ids) {
        const c = sql("select c.metricas, c.meta, c.dossie, c.memoria, c.referencias, l.nome, l.nicho, l.produtos_dona, l.produtos_admin, l.publico_admin from contas_meta c left join lojas l on l.user_id=c.user_id where c.user_id='" + id + "'")[0];
        casos.push({ nome: c.nome || ("loja " + id.slice(0, 6)), metricas: c.metricas, meta: c.meta, dossie: c.dossie || {}, memoria: c.memoria || {}, referencias: c.referencias, loja: { nome: c.nome, nicho: c.nicho, produtos_dona: c.produtos_dona, produtos_admin: c.produtos_admin, publico_admin: c.publico_admin } });
    }
    const resultado = { rotulo: String(ARG.rotulo || "rodada"), em: new Date().toISOString(), casos: [] };
    for (const caso of casos) {
        console.log("Rodando " + caso.nome + "...");
        try { resultado.casos.push(await rodarCaso(caso)); }
        catch (e) { console.error("  falhou: " + (e && e.message)); }
    }
    resultado.resumo = resumoRodada(resultado.casos);
    const ultima = path.join(PASTA, "ultima.json");
    let anterior = null; try { anterior = JSON.parse(fs.readFileSync(ultima, "utf8")); } catch (e) {}
    const html = path.join(PASTA, "relatorio-" + resultado.em.slice(0, 16).replace(/[:T]/g, "-") + ".html");
    fs.writeFileSync(html, relatorio(resultado, anterior));
    fs.writeFileSync(ultima, JSON.stringify(resultado));
    console.log("\nNotas das ideias: " + JSON.stringify(resultado.resumo.ideias) + "\nNotas dos roteiros: " + JSON.stringify(resultado.resumo.roteiros) + "\nProblemas: " + resultado.resumo.problemas + (anterior ? " (antes " + anterior.resumo.problemas + ")" : ""));
    console.log("Relatório: " + html);
})().catch(function (e) { console.error("ERRO", e); process.exit(1); });
