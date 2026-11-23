// TESTE TEMPORARIO (23/11/2026): ate quantos meses a Meta devolve o historico de atividades das contas de anuncios,
// em especial as trocas de criativo. So leitura (GET). Roda 1 vez por hora dentro do api/atualizar.js e escreve no log
// "[teste-atividades]" e guarda em contas_meta.meta.teste_atividades (continua na rodada seguinte se faltar conta).
// Remover este arquivo e a chamada no atualizar.js depois de ler o resultado.
const { banco } = require("./_seguranca.js");
const meta = require("./_meta-leitura.js");

function dia(t) { return t ? String(t).slice(0, 10) : null; }

async function testeAtividades(prazo) {
    const c = await meta.conexao();
    if (!c || c.pausada) { console.log("[teste-atividades] sem conexao com a Meta"); return; }
    const contas = (await banco("contas_meta?select=user_id,ad_account_id,feito:meta->teste_atividades&ad_account_id=not.is.null") || []).filter(function (x) { return !x.feito; });
    if (!contas.length) return;
    const desde = Math.floor((Date.now() - 37 * 30 * 864e5) / 1000);
    for (const x of contas || []) {
        if (Date.now() > prazo) { console.log("[teste-atividades] parou por tempo"); break; }
        const act = "act_" + String(x.ad_account_id).replace(/^act_/, "");
        const tipos = {};
        let total = 0, maisAntiga = null, maisNova = null, exemplo = null, paginas = 0;
        try {
            let d = await meta.g("/" + act + "/activities", { fields: "event_time,event_type,object_type,extra_data", since: desde, limit: 500 }, c.token);
            while (d && paginas < 15 && Date.now() < prazo) {
                paginas++;
                (d.data || []).forEach(function (e) {
                    total++;
                    tipos[e.event_type] = (tipos[e.event_type] || 0) + 1;
                    if (!maisAntiga || e.event_time < maisAntiga) maisAntiga = e.event_time;
                    if (!maisNova || e.event_time > maisNova) maisNova = e.event_time;
                    if (!exemplo && /creative/i.test(e.event_type || "")) exemplo = String(e.extra_data || "").slice(0, 220);
                });
                d = d.paging && d.paging.next ? await meta.g(d.paging.next, null, null) : null;
            }
            const criativo = Object.keys(tipos).filter(function (k) { return /creative/i.test(k); }).reduce(function (s, k) { return s + tipos[k]; }, 0);
            const top = Object.keys(tipos).sort(function (a, b) { return tipos[b] - tipos[a]; }).slice(0, 8).map(function (k) { return k + ":" + tipos[k]; }).join(", ");
            const r = { total: total, paginas: paginas, mais_antiga: dia(maisAntiga), mais_nova: dia(maisNova), trocas_criativo: criativo, tipos: top, exemplo_troca: exemplo, em: new Date().toISOString() };
            console.log("[teste-atividades] " + x.user_id.slice(0, 8) + " " + JSON.stringify(r));
            await meta.salvarMeta(x.user_id, { teste_atividades: r });
        } catch (e) {
            if (e instanceof meta.MetaPausada) throw e;
            console.log("[teste-atividades] " + x.user_id.slice(0, 8) + " erro: " + (e && e.message));
            await meta.salvarMeta(x.user_id, { teste_atividades: { erro: String((e && e.message) || e).slice(0, 300), em: new Date().toISOString() } }).catch(function () {});
        }
    }
}

module.exports = { testeAtividades };
