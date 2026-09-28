// =====================================================================
//  TIME DE AGENTES (roda no servidor, sozinho)
//  Estuda os numeros reais de UMA loja (Reportei em contas_meta.metricas),
//  completados pela Meta (fala dos videos, texto dos anuncios, comentarios
//  e idade/genero/cidades de quem segue, em api/_meta-leitura.js), e entrega:
//    - o dossie que o Agente MCP (api/_agente-mcp.js) usa nos roteiros
//    - as ideias de conteudo da tela Ideias
//
//  Etapas (cada uma espera a anterior):
//    1. Agente Organico, Agente de Anuncios, Agente de Publico (este 1 vez por semana)
//       e Agente de Memoria: liga as ideias sugeridas aos posts que a dona publicou,
//       ve o resultado, olha as capas e guarda o que funciona PARA ESTA LOJA
//       (contas_meta.memoria), junto com o gosto dela (Gostei e pedidos no chat)
//    2. Diretor (dossie) e 3 especialistas em ideias: videos curtos (topo),
//       narrados (meio) e provador (fundo); cada um escreve 6 opcoes
//    3. Curador: escolhe 4 curtos, 3 narrados e 3 provadores e guarda o resto na reserva
//
//  Economia: os 3 especialistas recebem o mesmo pacote de dados, gravado no cache
//  da Anthropic pelo primeiro (os outros pagam 10% por essa parte); e a loja so e
//  analisada de novo quando ha novidade (post, anuncio ou produto novo), no maximo
//  a cada 2 noites, e pelo menos a cada 3.
//
//  Dois jeitos de rodar as mesmas etapas (estado em contas_meta.dossie_job):
//    - "lote": a analise diaria da madrugada, pela Batch API da Anthropic (metade do preco);
//      api/atualizar.js confere o lote a cada rodada e passa para a etapa seguinte
//    - "agora": primeira analise, loja que volta depois de parada, ou o botao do admin;
//      as etapas rodam na hora, e o que ficou pronto e guardado entre as rodadas
//
//  Cada loja aprende so com os proprios dados: nada passa de uma loja para outra.
//  Fica em /api com "_" no nome: nao vira rota publica.
// =====================================================================

const crypto = require("crypto");
const { banco } = require("./_seguranca.js");
const { registrarUso } = require("./_uso-ia.js");
const { connect, clienteDoUsuario, integracoesDoCliente } = require("./_reportei.js");
const { blocoDaResposta, diaSP, assinaturaDe } = require("./_coleta.js");
const { enriquecerLoja, esperarFalas, aplicarMeta, comentariosDaLoja, textoDemografia } = require("./_meta-leitura.js");

const MODELO = "claude-sonnet-5";
const API = "https://api.anthropic.com/v1";
const VERSAO = 4; // 4: especialistas em curtos, narrados e provador + curador; mapa de publico no metodo da consultoria
const NICHOS = ["moda feminina", "moda masculina", "moda infantil", "moda fitness", "lingerie e moda intima", "calcados", "bolsas e acessorios", "joias e bijuterias", "beleza e cosmeticos", "saude e suplementos", "casa e decoracao", "alimentos e doces", "pet", "servicos", "cursos e infoprodutos", "outros"];

const HORA_MS = 3600 * 1000, DIA_MS = 24 * HORA_MS;
const PUBLICO_MS = 7 * DIA_MS;           // o mapa de publico muda devagar: refaz 1 vez por semana
const ATIVA_MS = 14 * DIA_MS;            // loja sem acesso ha mais que isso fica pausada (sem analise diaria)
const RODANDO_MS = 280 * 1000;           // uma etapa "agora" em andamento bloqueia outra rodada por esse tempo
const LOTE_VENCIDO_MS = 26 * HORA_MS;    // lote que nao terminou nesse tempo: o resto roda na hora
const AGORA_VENCIDO_MS = 3 * HORA_MS;    // analise "agora" parada ha mais que isso recomeca

const SISTEMA_TIME = `
QUEM VOCÊS SÃO
Vocês são o time de analistas e criadores do MCP Studio. Vocês estudam os dados reais de UMA loja brasileira (Instagram e anúncios da Meta dos últimos 90 dias) para que a dona grave conteúdos que dão resultado para ela.

REGRAS
- Use só os dados desta loja que vierem na mensagem. Nunca invente número, depoimento, produto, preço, promoção ou público. Se faltar dado para uma conclusão, diga que falta em vez de chutar.
- Cada conclusão precisa se apoiar no que os dados mostram (exemplo: os 3 Reels acima da média abrem com o preço na tela).
- Com poucos dados (menos de 5 posts ou anúncios), seja cauteloso, marque a confiança como baixa e diga isso no resumo.
- Seja específico desta loja. Frases genéricas como "conteúdo de valor" ou "engaje seu público" não ajudam a dona a gravar nada.
- Escreva em português do Brasil com acentuação completa e correta em todas as palavras (é, ê, á, ã, õ, ç, í, ú), inclusive quando os dados ou os nomes chegarem sem acento ou com erro de digitação. Frases curtas e linguagem simples de dona de loja. Use vírgula ou ponto no lugar de travessão.
- Quem lê é a própria dona da loja, no celular. Explique em palavras em vez de usar siglas como CTR, CPC ou ROAS.
- Nada de palavras em inglês: escreva "já" (e não already), "volta para o começo" (e não loop), "cena" (e não take), "chamada" (e não CTA), "tendência" (e não trend), "gancho" (e não hook). Só ficam Reels, stories, direct, close e POV, que a dona já usa.
- Seja simples e direto, como uma consultora falando com a dona: frases curtas, uma instrução por frase, sem termo técnico de edição ou de marketing.
- Não use etiquetas de ação para anúncios como Escalar, Manter ou Otimizar.

COMO MEDIMOS RESULTADO
- Orgânico: engajamento (curtidas, comentários, salvamentos) e compartilhamentos, com compartilhamento valendo o dobro, sempre em relação ao alcance. O índice compara cada post com a média da própria conta: 1,0 é na média, 2,0 é o dobro. Posts dos últimos 30 dias pesam mais.
- Anúncios: resultado é venda. Se a loja não tem pixel e vende pelo WhatsApp ou Direct, resultado são as conversas iniciadas. Campanhas com objetivos diferentes (alcance, visitas ao perfil, cliques) se comparam só entre as de mesmo objetivo.
- Ficaram nos 3 primeiros segundos (Reels, vem da Meta): quem não pulou o vídeo logo no começo. Mostra a força do gancho.
- Tempo médio assistido (Reels, vem da Meta): quantos segundos, em média, as pessoas assistem.
- Taxa de gancho dos anúncios = quem assistiu 3 segundos dividido pelas impressões. Retenção = quem assistiu até o fim dividido por quem assistiu 3 segundos. Taxa de clique = cliques dividido pelas impressões.
- Códigos: P1, P2... são os posts da loja e A1, A2... os anúncios, na ordem em que aparecem nos dados. Use o código quando citar um exemplo.
`.trim();

// Os 5 metodos em poucas linhas: o Diretor so precisa saber para que serve cada um
const METODOS_RESUMO = `
OS 5 MÉTODOS DE ROTEIRO DO MCP STUDIO
- fftopo, Full Funnel Topo (Consciência): para quem ainda não conhece a loja. Começa numa situação do dia a dia, desperta a dor e só depois apresenta a solução.
- ffmeio, Full Funnel Meio (Conceito Criativo): para quem já está pensando. Mostra o produto de um jeito criativo: comparação, antes e depois do look, look completo, estilo de vida, bastidor.
- fffundo, Full Funnel Fundo (Decisão e Prova): para quem já quer comprar mas trava. Responde uma objeção (preço, tamanho, qualidade, prazo, troca) com prova.
- dsb, DSB (Dor, Solução, Benefício): parte de uma dor real da cliente, apresenta o produto como a solução e fecha no benefício sentido na prática.
- angulo, Ângulo (Diferencial concreto): cada roteiro foca em um diferencial real do produto e mostra por que ele faz diferença.
`.trim();

// ---------- esquemas das respostas (a API garante o formato) ----------
const lista = { type: "array", items: { type: "string" } };
const confianca = { type: "string", enum: ["baixa", "media", "alta"] };
function objeto(props) { return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false }; }
const PT = "Em português do Brasil com acentuação completa.";
function textoPT(d) { return { type: "string", description: d + " " + PT }; }
function listaPT(d) { return { type: "array", items: { type: "string" }, description: d + " " + PT }; }

const ESQ_ORGANICO = objeto({
    resumo: { type: "string" }, o_que_funciona: lista, ganchos_que_funcionam: lista, temas: lista, formatos: lista,
    formatos_mae: listaPT("De 3 a 6 formatos que se repetem entre os posts que mais funcionaram, cada um numa frase com o nome do formato, o código do melhor exemplo e por que funciona (exemplo: Preço no gancho (P2): as seguidoras mandam para as amigas quando o valor aparece no primeiro segundo)."),
    evitar: lista, confianca: confianca
});
const ESQ_ANUNCIOS = objeto({ resumo: { type: "string" }, o_que_vende: lista, ganchos_que_convertem: lista, argumentos_e_ofertas: lista, ctas: lista, diagnostico_dos_fracos: lista, confianca: confianca });
// mapa de publico no metodo da consultoria (os campos antigos continuam, a tela Descobertas usa)
const ESQ_PUBLICO = objeto({
    resumo: { type: "string" }, quem_e: { type: "string" }, idade_genero: { type: "string" }, regioes: { type: "string" }, quem_compra: { type: "string" },
    faixas: listaPT("Uma frase por faixa de idade relevante: como compra, o que quer e que conteúdo funciona (exemplo: 35 a 44 anos: mais racionais, querem praticidade e custo-benefício; funciona mostrar 1 peça em 3 ocasiões)."),
    dores: lista, desejos: lista, objecoes: lista,
    motivos_compra: listaPT("O que faz esse público comprar desta loja."),
    motivos_nao_compra: listaPT("O que faz desistir da compra."),
    gatilhos: listaPT("Gatilhos que os dados mostram que funcionam nesta loja (preço no gancho, novidade, ocasião, prova no corpo)."),
    situacoes: listaPT("De 5 a 8 situações do dia a dia dessa cliente, do jeito que ela diria (exemplo: provei 5 looks e não gostei de nenhum)."),
    angulos: listaPT("De 3 a 5 ângulos de comunicação para esta loja."),
    expressoes_reais: lista, confianca: confianca
});
const ESQ_DIRETOR = objeto({
    texto: textoPT("Dossiê para o Agente MCP, até 1400 caracteres."),
    resumo_loja: textoPT("2 ou 3 frases curtas para a dona da loja ler no celular."),
    por_metodo: objeto({ fftopo: textoPT("Full Funnel Topo nesta loja."), ffmeio: textoPT("Full Funnel Meio nesta loja."), fffundo: textoPT("Full Funnel Fundo nesta loja."), dsb: textoPT("DSB nesta loja."), angulo: textoPT("Ângulo nesta loja.") }),
    nicho: { type: "string", enum: NICHOS }
});
const ESQ_ESPECIALISTA = objeto({
    ideias: {
        type: "array",
        items: objeto({
            titulo: textoPT("A ideia numa frase curta e concreta, do jeito que a dona entende na hora."),
            gancho: textoPT("O que aparece (e, se tiver fala, o que é dito) no primeiro segundo."),
            passos: listaPT("As tomadas na ordem, cada uma dizendo o que aparece na tela."),
            texto_na_tela: textoPT("O texto escrito por cima do vídeo, curto e grande."),
            fala: textoPT("Os pontos principais do que a dona fala, no jeito dela. Vazio nos vídeos curtos sem fala."),
            stories: listaPT("Sequência de stories que acompanha o vídeo (só no provador; nos outros, lista vazia)."),
            duracao_s: { type: "integer", description: "Duração sugerida em segundos." },
            peca: textoPT("A peça ou produto do vídeo, como está nos dados ou nos produtos do momento. Vazio se não houver informação."),
            inspirado_em: { type: "string", description: "Código do post (P1...) ou anúncio (A1...) desta loja que inspirou a ideia, ou vazio." },
            por_que: textoPT("Em uma frase, o dado desta loja que sustenta a ideia. A dona lê este texto: nunca use códigos como P1 ou A1, descreva o post ou anúncio (exemplo: o Reels do vestido azul de 18/09 teve 3,6x a média)."),
            metrica: textoPT("Como a dona sabe se deu certo, em palavras simples."),
            funil: { type: "string", enum: ["topo", "meio", "fundo"] },
            metodo: { type: "string", enum: ["fftopo", "ffmeio", "fffundo", "dsb", "angulo"], description: "O método de roteiro mais próximo, se a ideia virar roteiro." }
        })
    }
});
const ESQ_CURADOR = objeto({
    resumo: textoPT("2 frases para a dona: por onde começar esta semana e por quê."),
    principais: { type: "array", items: { type: "string" }, description: "Códigos escolhidos, em ordem de prioridade: 4 curtos (C), 3 narrados (N) e 3 provadores (V)." },
    reserva: { type: "array", items: { type: "string" }, description: "Os outros códigos bons, do melhor para o pior. Fora os fracos ou repetidos." }
});

const ESQ_MEMORIA = objeto({
    resumo: textoPT("2 frases para a dona: o que o time aprendeu sobre a loja dela até agora."),
    vinculos: {
        type: "array", description: "Cada post recente (R) que seguiu uma ideia sugerida (I).",
        items: objeto({
            ideia: { type: "string", description: "Código da ideia (I1...)." },
            post: { type: "string", description: "Código do post (R1...)." },
            confianca: confianca,
            resultado: { type: "string", enum: ["acima", "na_media", "abaixo", "sem_dado"] }
        })
    },
    aprendizados: {
        type: "array", description: "A memória atualizada, no máximo 12 itens, do mais forte para o mais fraco.",
        items: objeto({
            texto: textoPT("Regra prática desta loja, com números (exemplo: provador com espelho e luz natural rende 1,8x a média; fundo branco de estúdio fica abaixo)."),
            evidencias: textoPT("Os posts que provam, pela data e uma descrição curta (exemplo: Reels de 18/09 do conjunto azul e Reels de 25/09 do cropped)."),
            forca: { type: "string", enum: ["pista", "media", "forte"] }
        })
    },
    visual: listaPT("De 2 a 6 padrões visuais das capas: o que se repete nos melhores e nos piores posts (cenário, luz, enquadramento, rosto, texto na capa, peça em destaque)."),
    gosto: listaPT("O gosto e os limites da dona: o que ela marca como Gostei, o que pede no chat, o que escolhe gravar. Lista vazia se não houver sinal.")
});

// ---------- chamada da IA ----------
function espera(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// garantia final: troca qualquer travessao que escape por virgula (mesma regra do api/generate.js)
function semTravessao(v) {
    if (typeof v === "string") return v.replace(/,?[ \t]*[—–][ \t]*/g, ", ");
    if (Array.isArray(v)) return v.map(semTravessao);
    if (v && typeof v === "object") { const o = {}; Object.keys(v).forEach(function (k) { o[k] = semTravessao(v[k]); }); return o; }
    return v;
}
function chave() {
    const k = process.env.ANTHROPIC_API_KEY;
    if (!k) throw new Error("ANTHROPIC_API_KEY nao configurada no Vercel.");
    return k;
}
function cabecalhos() { return { "Content-Type": "application/json", "x-api-key": chave(), "anthropic-version": "2023-06-01" }; }
function corpoDe(p) {
    return {
        model: p.modelo || MODELO,
        max_tokens: p.max || 12000,
        system: [{ type: "text", text: p.sistema || SISTEMA_TIME }],
        messages: [{ role: "user", content: p.pedido }],
        output_config: { effort: p.effort || "medium", format: { type: "json_schema", schema: p.esquema } }
    };
}
// resposta da API (na hora ou do lote) virando o JSON pedido
function lerResposta(nome, d) {
    if (d.stop_reason === "refusal") throw new Error(nome + ": a IA recusou o pedido");
    if (d.stop_reason === "max_tokens") throw new Error(nome + ": resposta cortada");
    const bloco = (d.content || []).find(function (b) { return b.type === "text"; });
    if (!bloco) throw new Error(nome + ": resposta vazia");
    return semTravessao(JSON.parse(bloco.text));
}

// le a resposta em pedacos (streaming): assim da para saber quando a IA comecou a responder
async function lerStream(r, aoComecar) {
    const leitor = r.body.getReader(), dec = new TextDecoder();
    let buf = "", texto = "", usage = {}, stop = null, erro = null, comecou = false;
    for (;;) {
        const lido = await leitor.read();
        if (lido.done) break;
        buf += dec.decode(lido.value, { stream: true }).replace(/\r\n/g, "\n");
        let i;
        while ((i = buf.indexOf("\n\n")) > -1) {
            const linha = buf.slice(0, i).split("\n").find(function (l) { return l.indexOf("data:") === 0; });
            buf = buf.slice(i + 2);
            if (!linha) continue;
            let ev; try { ev = JSON.parse(linha.slice(5)); } catch (e) { continue; }
            if (ev.type === "message_start") { usage = Object.assign({}, ev.message && ev.message.usage); if (!comecou) { comecou = true; if (aoComecar) aoComecar(); } }
            else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") texto += ev.delta.text;
            else if (ev.type === "message_delta") { if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; if (ev.usage) Object.assign(usage, ev.usage); }
            else if (ev.type === "error") erro = (ev.error && ev.error.message) || "falha na resposta";
        }
    }
    if (erro) throw new Error(erro);
    return { content: [{ type: "text", text: texto }], stop_reason: stop, usage: usage };
}

// p = { chave, nome, pedido, esquema, max }; aoComecar: chamada quando a IA comeca a responder
async function perguntar(userId, p, aoComecar) {
    const corpo = Object.assign(corpoDe(p), { stream: true });
    for (let t = 0; t < 3; t++) {
        let r, d;
        try {
            r = await fetch(API + "/messages", { method: "POST", headers: cabecalhos(), body: JSON.stringify(corpo), signal: AbortSignal.timeout(170000) });
        } catch (e) {
            if (t < 2) { await espera(1500 * (t + 1)); continue; }
            throw new Error(p.nome + ": " + (e.name === "TimeoutError" || e.name === "AbortError" ? "a IA demorou demais" : "falha de rede"));
        }
        if (!r.ok) {
            const e = await r.json().catch(function () { return {}; });
            // 429, 529 e 5xx podem passar na proxima tentativa
            if ((r.status === 429 || r.status >= 500) && t < 2) { await espera(2000 * (t + 1)); continue; }
            throw new Error(p.nome + ": " + ((e.error && e.error.message) || ("erro " + r.status)));
        }
        try { d = await lerStream(r, aoComecar); }
        catch (e) {
            if (t < 2) { await espera(2000 * (t + 1)); continue; }
            throw new Error(p.nome + ": " + (e.name === "TimeoutError" || e.name === "AbortError" ? "a IA demorou demais" : (e.message || "falha na resposta")));
        }
        await registrarUso(userId, p.nome, p.modelo || MODELO, d.usage, false);
        return lerResposta(p.nome, d);
    }
}

// ---------- lote (Batch API: metade do preco, fica pronto em minutos ou horas) ----------
async function criarLote(pedidos) {
    const r = await fetch(API + "/messages/batches", {
        method: "POST", headers: cabecalhos(), signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ requests: pedidos.map(function (p) { return { custom_id: p.chave, params: corpoDe(p) }; }) })
    });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok || !d.id) throw new Error("Lote: " + ((d.error && d.error.message) || ("erro " + r.status)));
    return d.id;
}
async function lerLote(id) {
    const r = await fetch(API + "/messages/batches/" + encodeURIComponent(id), { headers: cabecalhos(), signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error("Lote: " + ((d.error && d.error.message) || ("erro " + r.status)));
    return d;
}
async function resultadosDoLote(url) {
    const r = await fetch(url, { headers: cabecalhos(), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error("Lote: resultados indisponiveis (" + r.status + ")");
    return (await r.text()).split("\n").filter(function (l) { return l.trim(); }).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

// ---------- preparo dos dados ----------
function arred(n, c) { const f = Math.pow(10, c || 0); return Math.round((n || 0) * f) / f; }
function corta(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "..." : t; }
function brl(n) { return "R$ " + arred(n, 2).toFixed(2).replace(".", ","); }
function dataCurta(iso) { return iso ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }).format(new Date(iso)) : ""; }

function postsDaLoja(met) {
    const posts = (met && met.organico && met.organico.posts) || [];
    const desde30 = Date.now() - 30 * 864e5;
    const peso = function (p) { return (p.indice || 0) * (p.recente ? 1.3 : 1); };
    const ord = posts.filter(function (p) { return p.alcance > 0; })
        .map(function (p) { return Object.assign({}, p, { recente: !!(p.data && new Date(p.data).getTime() >= desde30) }); })
        .sort(function (a, b) { return peso(b) - peso(a); });
    // conta pequena: manda tudo; conta grande: os 15 melhores e os 5 piores
    return ord.length <= 20 ? ord : ord.slice(0, 15).concat(ord.slice(-5));
}
function linhaPost(p, i) {
    return "P" + (i + 1) + ") " + (p.tipo || "Post") + " de " + String(p.data || "").slice(0, 10) + (p.recente ? " (últimos 30 dias)" : "") +
        " | " + (p.pouco_alcance ? "ALCANCE MUITO BAIXO, número pouco confiável" : String(arred(p.indice, 2)).replace(".", ",") + "x a média") + " | alcance " + p.alcance + " | visualizações " + (p.visualizacoes || 0) +
        (p.tempo_medio_s ? " | tempo médio assistido " + String(p.tempo_medio_s).replace(".", ",") + " s" : "") +
        (p.retencao_3s != null ? " | ficaram nos 3 primeiros segundos " + String(p.retencao_3s).replace(".", ",") + "%" : "") +
        " | curtidas " + p.curtidas + " | comentários " + p.comentarios + " | salvamentos " + p.salvamentos + " | compartilhamentos " + p.compartilhamentos +
        (p.seguiram ? " | começaram a seguir " + p.seguiram : "") + (p.visitas_perfil ? " | visitas ao perfil " + p.visitas_perfil : "") +
        " | legenda: " + corta(p.legenda, 300) + (p.transcricao ? " | FALA DO VÍDEO: " + corta(p.transcricao, 700) : "");
}

function anunciosDaLoja(met) {
    const a90 = met && met.anuncios && met.anuncios.p90;
    if (!a90 || !(a90.anuncios || []).length) return null;
    const r30 = {}, r7 = {};
    ((met.anuncios.p30 && met.anuncios.p30.anuncios) || []).forEach(function (x) { r30[x.id] = x.resultados; });
    ((met.anuncios.p7 && met.anuncios.p7.anuncios) || []).forEach(function (x) { r7[x.id] = x; });
    return { tipo: a90.tipo_resultado, totais: a90.totais || {}, medias: a90.medias || {}, lista: a90.anuncios.slice(0, 25).map(function (x) { return Object.assign({}, x, { resultados_30d: r30[x.id] || 0, ultimos7: r7[x.id] || null }); }) };
}
function nomeResultado(tipo, a) {
    if (tipo === "vendas") return "compras";
    if (tipo === "conversas") return "conversas";
    return (a && a.res_nome && a.res_nome[1]) || "resultados da campanha";
}
function linhaAnuncio(tipo, a, i) {
    // sinal de cansaco: nos ultimos 7 dias o custo por resultado ficou bem acima dos 90 dias
    const c7 = a.ultimos7 && a.ultimos7.custo_por_resultado, cansou = c7 && a.custo_por_resultado && c7 > a.custo_por_resultado * 1.4;
    return "A" + (i + 1) + ") " + corta(a.nome, 140) + " | objetivo medido: " + nomeResultado(tipo, a) + " | investido " + brl(a.gasto) +
        " | resultados em 90 dias " + a.resultados + " (últimos 30 dias: " + a.resultados_30d + ")" +
        (a.custo_por_resultado ? " | custo por resultado " + brl(a.custo_por_resultado) : "") +
        (a.receita > 0 ? " | vendeu " + brl(a.receita) + (a.roas ? " (voltou " + String(a.roas).replace(".", ",") + " vezes o investido)" : "") : "") +
        (cansou ? " | CANSANDO: nos últimos 7 dias o custo por resultado subiu para " + brl(c7) : "") +
        (a.taxa_gancho != null ? " | taxa de gancho " + a.taxa_gancho + "%" : "") + (a.retencao != null ? " | retenção " + a.retencao + "%" : "") +
        (a.ctr != null ? " | taxa de clique " + a.ctr + "%" : "") + (a.compras ? " | compras " + a.compras : "") + (a.conversas ? " | conversas " + a.conversas : "") +
        (a.diagnostico ? " | " + a.diagnostico : "") + (a.titulo ? " | TÍTULO: " + corta(a.titulo, 120) : "") + (a.texto ? " | TEXTO DO ANÚNCIO: " + corta(a.texto, 400) : "") +
        (a.transcricao ? " | FALA DO VÍDEO: " + corta(a.transcricao, 700) : "");
}

// idade, genero e cidades pelo Reportei: so quando a Meta nao entregou
async function publicoDoReportei(userId) {
    try {
        const cli = await clienteDoUsuario(userId);
        const ints = await integracoesDoCliente(cli);
        const ig = ints.find(function (i) { return i.plataforma === "instagram_business" && i.status === "active"; }) || ints.find(function (i) { return i.plataforma === "instagram_business"; });
        if (!ig) return "";
        const fim = diaSP(new Date()), inicio = diaSP(new Date(Date.now() - 29 * 864e5));
        const pedidos = {
            idade_genero: { reference_key: "ig:followers_gender_age", component: "chart_v1", metrics: ["followers"], dimensions: ["age", "gender"] },
            cidades: { reference_key: "ig:followers_city", component: "datatable_v1", metrics: ["followers"], dimensions: ["city"], sort: ["-followers"] }
        };
        const out = [];
        await Promise.all(Object.keys(pedidos).map(async function (k) {
            const w = Object.assign({ id: crypto.randomUUID() }, pedidos[k]);
            try {
                const d = await connect("/metrics/get-data", { method: "POST", customerToken: cli.api_token, timeout: 60000, body: { customer_integration: ig.uuid, start: inicio, end: fim, client_timezone: "America/Sao_Paulo", metrics: [w] } });
                const b = blocoDaResposta(d, w.id);
                if (!b || b.warning) return;
                const v = k === "cidades" && Array.isArray(b.values) ? { values: b.values.slice(0, 10) } : b;
                out.push(k + ": " + JSON.stringify(v).slice(0, 1500));
            } catch (e) { /* sem esse dado o agente segue com o resto */ }
        }));
        return out.join(" | ");
    } catch (e) { return ""; }
}

// datas do varejo das proximas 8 semanas (fixas no codigo: a IA nao chuta data)
function pascoa(ano) {
    const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(ano, mes - 1, dia));
}
function domingo(ano, mes, n) { const d = new Date(Date.UTC(ano, mes, 1)); return new Date(Date.UTC(ano, mes, 1 + (7 - d.getUTCDay()) % 7 + 7 * (n - 1))); }
function datasDoVarejo(agora) {
    const hoje = new Date(diaSP(agora) + "T12:00:00Z"), out = [];
    [hoje.getUTCFullYear(), hoje.getUTCFullYear() + 1].forEach(function (ano) {
        function dia(m, d) { return new Date(Date.UTC(ano, m - 1, d, 12)); }
        const p = pascoa(ano), nov = new Date(Date.UTC(ano, 10, 1));
        out.push(["Volta às aulas", dia(2, 1)], ["Carnaval", new Date(p.getTime() - 47 * DIA_MS)], ["Dia da Mulher", dia(3, 8)], ["Dia do Consumidor", dia(3, 15)],
            ["começo do outono", dia(3, 20)], ["Páscoa", p], ["Dia das Mães", domingo(ano, 4, 2)], ["Dia dos Namorados", dia(6, 12)], ["festas juninas", dia(6, 13)],
            ["começo do inverno", dia(6, 21)], ["Dia dos Avós", dia(7, 26)], ["Dia dos Pais", domingo(ano, 7, 2)], ["Dia do Cliente", dia(9, 15)], ["começo da primavera", dia(9, 22)],
            ["Dia das Crianças", dia(10, 12)], ["Dia do Professor", dia(10, 15)], ["Halloween", dia(10, 31)],
            ["Black Friday", new Date(Date.UTC(ano, 10, 1 + (4 - nov.getUTCDay() + 7) % 7 + 22, 12))],
            ["começo do verão", dia(12, 21)], ["Natal", dia(12, 25)], ["Réveillon", dia(12, 31)]);
    });
    const ini = hoje.getTime() - DIA_MS, fim = hoje.getTime() + 56 * DIA_MS;
    return out.filter(function (x) { const t = x[1].getTime(); return t >= ini && t <= fim; })
        .sort(function (a, b) { return a[1] - b[1]; })
        .map(function (x) { return x[0] + " (" + String(x[1].getUTCDate()).padStart(2, "0") + "/" + String(x[1].getUTCMonth() + 1).padStart(2, "0") + ")"; });
}

// o que a loja quer vender agora e o que a consultoria ajustou sobre o publico
function textoDaLoja(loja) {
    const partes = [];
    if (loja.produtos_dona) partes.push("PRODUTOS E OFERTAS DO MOMENTO, contados pela própria loja" + (loja.produtos_dona_em ? " em " + dataCurta(loja.produtos_dona_em) : "") + " (valem mais que qualquer outra fonte, porque é a dona que sabe o que tem hoje): " + corta(loja.produtos_dona, 1500));
    if (loja.produtos_admin) partes.push("PRODUTOS E OFERTAS SEGUNDO A CONSULTORIA (complemento; se falar diferente da loja, vale a loja): " + corta(loja.produtos_admin, 1500));
    if (loja.publico_admin) partes.push("AJUSTES DA CONSULTORIA SOBRE O PÚBLICO (valem mais que a leitura dos dados): " + corta(loja.publico_admin, 1500));
    return partes.join("\n");
}
function montarSobreLoja(loja, projetos, met) {
    const produtos = (projetos || []).map(function (p) { return corta((p.form && p.form.produto) || p.nome, 200); }).filter(Boolean).slice(0, 5);
    return "LOJA: " + (loja.nome || "sem nome") + (loja.nicho ? " | nicho informado: " + loja.nicho : "") + (loja.site ? " | site: " + loja.site : "") +
        (met.conta && met.conta.username ? " | Instagram @" + met.conta.username : "") + (met.conta && met.conta.seguidores ? " | " + met.conta.seguidores + " seguidores" : "") +
        (produtos.length ? "\nPRODUTOS DOS ÚLTIMOS PROJETOS DE ROTEIRO: " + produtos.join(" | ") : "") +
        (textoDaLoja(loja) ? "\n" + textoDaLoja(loja) : "");
}

// Voz da loja e biblioteca de ganchos: tirados direto dos dados (sem IA), para o roteirista
function primeiraFrase(t) {
    const txt = String(t || "").replace(/\s+/g, " ").trim();
    if (!txt) return "";
    const m = txt.match(/^(.{12,160}?[.!?])(\s|$)/);
    const f = m ? m[1] : txt;
    const palavras = f.split(" ");
    return palavras.length > 22 ? palavras.slice(0, 22).join(" ") + "..." : f;
}
function vozEGanchos(met, comentarios) {
    const posts = ((met && met.organico && met.organico.posts) || []).filter(function (p) { return p.alcance > 0; });
    const falas = posts.filter(function (p) { return p.transcricao; }).sort(function (a, b) { return (b.indice || 0) - (a.indice || 0); })
        .map(function (p) { return corta(p.transcricao, 1400); }).filter(function (t, i, v) { return v.indexOf(t) === i; }).slice(0, 2);
    const comGancho = posts.map(function (p) { return { texto: primeiraFrase(p.transcricao) || primeiraFrase(p.legenda), ficaram: p.retencao_3s, tempo: p.tempo_medio_s, indice: p.indice, fonte: p.transcricao ? "fala" : "legenda" }; })
        .filter(function (g) { return g.texto; });
    const temRet = comGancho.some(function (g) { return g.ficaram != null; });
    const ord = comGancho.slice().sort(function (a, b) { return temRet ? ((b.ficaram == null ? -1 : b.ficaram) - (a.ficaram == null ? -1 : a.ficaram)) : ((b.indice || 0) - (a.indice || 0)); });
    const medidos = temRet ? ord.filter(function (g) { return g.ficaram != null; }) : ord;
    const ads = ((met && met.anuncios && met.anuncios.p90 && met.anuncios.p90.anuncios) || [])
        .filter(function (a) { return a.taxa_gancho != null && (a.transcricao || a.texto || a.nome); })
        .map(function (a) { return { texto: primeiraFrase(a.transcricao) || primeiraFrase(a.texto) || corta(String(a.nome).replace(/^\s*\[[^\]]*\]\s*[-–:|]*\s*/, ""), 120), gancho_anuncio: a.taxa_gancho, fonte: a.transcricao ? "fala" : a.texto ? "texto" : "nome" }; })
        .sort(function (a, b) { return b.gancho_anuncio - a.gancho_anuncio; });
    return {
        voz: { falas: falas, comentarios: (comentarios || []).slice(0, 15) },
        tempo_medio_conta: (function () { const t = posts.map(function (p) { return p.tempo_medio_s; }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; }); return t.length ? t[Math.floor(t.length / 2)] : null; })(),
        ganchos: { medida: temRet ? "ficaram nos 3 primeiros segundos" : "engajamento em relação à média da conta", melhores: medidos.slice(0, 5), piores: medidos.length > 6 ? medidos.slice(-3).reverse() : [], anuncios: ads.slice(0, 4) }
    };
}

// ---------- contexto de uma loja (lido de novo a cada etapa) ----------
async function carregar(userId) {
    const id = encodeURIComponent(userId);
    const desde = encodeURIComponent(new Date(Date.now() - 60 * DIA_MS).toISOString());
    const [contas, lojas, projetos, gostei, conversas] = await Promise.all([
        banco("contas_meta?user_id=eq." + id + "&select=metricas,dossie,meta,dossie_job,memoria"),
        banco("lojas?user_id=eq." + id + "&select=nome,nicho,site,produtos_dona,produtos_dona_em,produtos_admin,publico_admin").catch(function () { return []; }),
        banco("projetos?user_id=eq." + id + "&select=nome,form&order=criado_em.desc&limit=5").catch(function () { return []; }),
        banco("gostei?user_id=eq." + id + "&criado_em=gte." + desde + "&select=tipo,titulo,conteudo,criado_em&order=criado_em.desc&limit=30").catch(function () { return []; }),
        banco("conversas?user_id=eq." + id + "&criado_em=gte." + desde + "&select=area,pedido,criado_em&order=criado_em.desc&limit=15").catch(function () { return []; })
    ]);
    const conta = (contas && contas[0]) || {};
    return { userId: userId, conta: conta, met: conta.metricas, dossie: conta.dossie || {}, job: conta.dossie_job || null, loja: (lojas && lojas[0]) || {}, projetos: projetos || [], memoria: conta.memoria || {}, gostei: gostei || [], conversas: conversas || [] };
}
// comMeta: consulta a Meta (so na primeira etapa); nas outras usa o que ja foi guardado
async function preparar(ctx, comMeta) {
    const met = ctx.met;
    const postsTodos = (met && met.organico && met.organico.posts) || [];
    if (!postsTodos.length && !anunciosDaLoja(met)) throw new Error("Ainda nao ha numeros desta loja. Conecte o Instagram e os anuncios e atualize os dados.");
    let cache = ctx.conta.meta || null;
    if (comMeta) {
        const daMeta = await enriquecerLoja(met, cache).catch(function (e) { console.error("[time] meta: " + (e && e.message)); return { cache: cache, pendentes: [] }; });
        cache = daMeta.cache;
        await esperarFalas(daMeta.pendentes);
        if (cache) await banco("contas_meta?user_id=eq." + encodeURIComponent(ctx.userId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { meta: cache } }).catch(function () {});
    }
    aplicarMeta(met, cache);
    ctx.cacheMeta = cache;
    ctx.postsTodos = postsTodos;
    ctx.posts = postsDaLoja(met);
    ctx.comentarios = comentariosDaLoja(met, cache);
    ctx.ads = anunciosDaLoja(met);
    ctx.demografia = textoDemografia(cache);
    ctx.sobreLoja = montarSobreLoja(ctx.loja, ctx.projetos, met);
    return ctx;
}
// codigos P1/A1 para achar o video que inspirou cada ideia (guardado com a etapa, porque os numeros mudam entre as etapas)
function mapaDeCodigos(ctx) {
    const m = {};
    ctx.posts.forEach(function (p, i) { m["P" + (i + 1)] = { tipo: "post", link: p.link || "", miniatura: p.miniatura || "", legenda: corta(p.legenda, 90) }; });
    ((ctx.ads && ctx.ads.lista) || []).slice(0, 12).forEach(function (a, i) { m["A" + (i + 1)] = { tipo: "anuncio", link: a.post_link || "", miniatura: a.miniatura || "", legenda: corta(a.nome, 90) }; });
    return m;
}
function publicoVencido(ctx) {
    const d = ctx.dossie;
    return !d.publico || !d.publico.situacoes || !d.publico_em || Date.now() - new Date(d.publico_em).getTime() >= PUBLICO_MS || (ctx.loja.publico_admin || "") !== (d.publico_admin_usado || "");
}
function resumoRel(rel) { return rel ? JSON.stringify(rel) : "não disponível"; }
function dadosEmTexto(ctx, nPosts, nAds, nCom) {
    const ads = ctx.ads;
    return "\n\nPOSTS DA LOJA (do melhor para o pior):\n" + (ctx.posts.slice(0, nPosts).map(linhaPost).join("\n") || "nenhum") +
        (ads ? "\n\nANÚNCIOS (do que mais deu resultado para o que menos deu):\n" + ads.lista.slice(0, nAds).map(function (a, i) { return linhaAnuncio(ads.tipo, a, i); }).join("\n") : "") +
        (ctx.comentarios.length ? "\n\nCOMENTÁRIOS REAIS DAS SEGUIDORAS:\n" + ctx.comentarios.slice(0, nCom).map(function (c) { return "- " + c; }).join("\n") : "");
}

// ---------- memoria da loja (IA que aprende com o proprio resultado) ----------
const SUGERIDAS_MS = 35 * DIA_MS;
// guarda as ideias mostradas para a dona, para o Agente de Memoria achar depois quais viraram post
function comSugeridas(memoria, ideias) {
    const agora = Date.now(), vistas = {};
    const novas = (ideias || []).map(function (x) { return { t: corta(x.titulo, 160), f: x.formato || "", g: corta(x.gancho, 200), p: corta(x.peca, 80), em: new Date(agora).toISOString() }; });
    const todas = novas.concat((memoria && memoria.sugeridas) || []).filter(function (x) {
        if (!x.t || vistas[x.t] || agora - new Date(x.em).getTime() > SUGERIDAS_MS) return false;
        vistas[x.t] = 1; return true;
    });
    return Object.assign({}, memoria || {}, { sugeridas: todas.slice(0, 60) });
}
function dataBR(iso) { return iso ? dataCurta(iso) : "sem data"; }
// o que a dona marcou como Gostei e o que pediu no chat (sinais do gosto dela)
function textoGosto(ctx) {
    const g = (ctx.gostei || []).slice(0, 20).map(function (x) { return "- " + (x.tipo === "roteiro" ? "roteiro" : "ideia") + " de " + dataBR(x.criado_em) + ": " + corta(x.titulo, 140) + (x.conteudo && x.conteudo.gancho ? " (gancho: " + corta(x.conteudo.gancho, 140) + ")" : ""); });
    const c = (ctx.conversas || []).slice(0, 12).map(function (x) { return "- " + dataBR(x.criado_em) + ", no chat de " + x.area + ": " + corta(x.pedido, 220); });
    return (g.length ? "\nIDEIAS E ROTEIROS QUE A DONA MARCOU COMO GOSTEI:\n" + g.join("\n") : "") +
        (c.length ? "\nPEDIDOS DA DONA NO CHAT COM O TIME:\n" + c.join("\n") : "");
}
// a memoria em texto, para o diretor, os especialistas, o curador e o chat
function textoMemoria(mem) {
    mem = mem || {};
    const ap = mem.aprendizados || [], vis = mem.visual || [], gos = mem.gosto || [], vin = (mem.vinculos || []).filter(function (v) { return v.confianca !== "baixa"; });
    if (!ap.length && !vis.length && !gos.length && !vin.length) return "";
    const RES = { acima: "acima da média", na_media: "na média", abaixo: "abaixo da média", sem_dado: "ainda sem resultado" };
    return "\n\nO QUE O TIME JÁ APRENDEU COM ESTA LOJA (memória, confirmada com os resultados dos posts dela)" +
        (ap.length ? "\nAPRENDIZADOS:\n" + ap.map(function (a) { return "- " + a.texto + " [" + (a.forca || "pista") + "; " + a.evidencias + "]"; }).join("\n") : "") +
        (vis.length ? "\nNAS CAPAS:\n" + vis.map(function (v) { return "- " + v; }).join("\n") : "") +
        (gos.length ? "\nGOSTO DA DONA:\n" + gos.map(function (v) { return "- " + v; }).join("\n") : "") +
        (vin.length ? "\nIDEIAS DO TIME QUE VIRARAM POST:\n" + vin.slice(0, 10).map(function (v) { return "- " + corta(v.ideia, 120) + ": " + (RES[v.resultado] || v.resultado) + (v.indice ? " (" + String(v.indice).replace(".", ",") + "x a média)" : ""); }).join("\n") : "");
}
async function imagemBase64(url) {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
        const tipo = String(r.headers.get("content-type") || "").split(";")[0].trim();
        if (!/^image\/(jpeg|png|webp|gif)$/.test(tipo)) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 1500000) return null;
        return { type: "image", source: { type: "base64", media_type: tipo, data: buf.toString("base64") } };
    } catch (e) { return null; }
}
async function pedidoMemoria(ctx) {
    const desde = Date.now() - SUGERIDAS_MS;
    const recentes = (ctx.postsTodos || []).filter(function (p) { return p.data && new Date(p.data).getTime() >= desde; })
        .sort(function (a, b) { return String(b.data).localeCompare(String(a.data)); }).slice(0, 25);
    if (recentes.length < 2) return null;
    const mem = ctx.memoria || {}, sugeridas = (mem.sugeridas || []).slice(0, 40);
    const mapa = { ideias: {}, posts: {} };
    sugeridas.forEach(function (s, i) { mapa.ideias["I" + (i + 1)] = s.t; });
    recentes.forEach(function (p, i) { mapa.posts["R" + (i + 1)] = { id: p.id, link: p.link || "", miniatura: p.miniatura || "", data: p.data, indice: p.pouco_alcance ? null : p.indice, legenda: corta(p.legenda, 90) }; });
    ctx.mapaMem = mapa;
    function linha(p, i) {
        return "R" + (i + 1) + ") " + (p.tipo || "Post") + " de " + dataBR(p.data) + " | " + (p.pouco_alcance ? "alcance muito baixo, número pouco confiável" : String(arred(p.indice, 2)).replace(".", ",") + "x a média") +
            (p.anunciado ? " | foi impulsionado" : "") + " | alcance " + p.alcance + (p.tempo_medio_s ? " | tempo médio " + String(p.tempo_medio_s).replace(".", ",") + " s" : "") +
            (p.retencao_3s != null ? " | ficaram nos 3 primeiros segundos " + String(p.retencao_3s).replace(".", ",") + "%" : "") +
            " | curtidas " + p.curtidas + " | comentários " + p.comentarios + " | salvamentos " + p.salvamentos + " | compartilhamentos " + p.compartilhamentos +
            " | legenda: " + corta(p.legenda, 160) + (p.transcricao ? " | o que é falado no vídeo (transcrito pelo time, não é legenda): " + corta(p.transcricao, 300) : "");
    }
    const texto = "Você é o AGENTE DE MEMÓRIA do time. Seu trabalho é descobrir o que funciona DE VERDADE para esta loja, comparando o que o time sugeriu com o que a dona publicou e com o resultado de cada post. O que você guardar vira a base das próximas ideias.\n\n" +
        "TAREFAS\n" +
        "A) Ligue cada post recente (R) à ideia sugerida (I) que ele seguiu. Só ligue quando o post repete o gancho, a estrutura ou a peça da ideia; ser do mesmo tema não basta. Na dúvida, não ligue.\n" +
        "B) Julgue o resultado de cada ideia gravada: acima (1,3x a média ou mais), na média, abaixo (0,7x ou menos) ou sem dado (post de menos de 2 dias ou com alcance muito baixo). Desconte post impulsionado e data especial antes de concluir.\n" +
        "C) Atualize a MEMÓRIA ATUAL: confirme um aprendizado quando surgir mais uma evidência, enfraqueça quando um resultado contradisser e remova o que ficou sem sustentação. Aprendizado com 2 posts ou mais como prova pode ser médio ou forte; com 1 post só, entra como pista. No máximo 12, do mais forte para o mais fraco. Cada um é uma regra prática desta loja, com números. Cite os posts pela data e por uma descrição curta, nunca pelo código, porque os outros agentes não veem os códigos R e I.\n" +
        "D) Olhe as CAPAS: anote padrões visuais que se repetem nos melhores e nos piores posts (cenário, luz, enquadramento, rosto, texto na capa, peça em destaque).\n" +
        "E) Registre o gosto da dona: o que ela marcou como Gostei, o que pediu no chat e que tipo de ideia escolhe gravar. Ideia não gravada, sem outro sinal, é só uma pista fraca: pode ter sido falta de tempo.\n\n" +
        "REGRAS\n- Nada de dica genérica de marketing: só o que os dados DESTA loja mostram.\n- Um post sozinho é pista, não regra.\n- Em resumo, 2 frases para a dona sobre o que o time aprendeu com a loja dela.\n\n" +
        ctx.sobreLoja +
        "\n\nMEMÓRIA ATUAL:\n" + ((mem.aprendizados || []).map(function (a, i) { return "M" + (i + 1) + ") " + a.texto + " [" + a.forca + "; " + a.evidencias + "]"; }).join("\n") || "vazia (primeira vez)") +
        ((mem.visual || []).length ? "\nPADRÕES VISUAIS JÁ ANOTADOS: " + mem.visual.join(" | ") : "") +
        "\n\nIDEIAS SUGERIDAS PELO TIME NOS ÚLTIMOS 35 DIAS:\n" + (sugeridas.map(function (s, i) { return "I" + (i + 1) + ") " + dataBR(s.em) + " | " + (NOME_FORMATO_TXT[s.f] || "vídeo") + " | " + s.t + (s.g ? " | gancho: " + s.g : "") + (s.p ? " | peça: " + s.p : ""); }).join("\n") || "nenhuma registrada ainda") +
        textoGosto(ctx) +
        "\n\nPOSTS PUBLICADOS NOS ÚLTIMOS 35 DIAS (do mais novo para o mais antigo):\n" + recentes.map(linha).join("\n");
    // capas: os 4 melhores e os 3 piores posts recentes (so os de alcance normal)
    const medidos = recentes.map(function (p, i) { return { p: p, cod: "R" + (i + 1) }; }).filter(function (x) { return x.p.miniatura && !x.p.pouco_alcance; })
        .sort(function (a, b) { return (b.p.indice || 0) - (a.p.indice || 0); });
    const escolhidos = medidos.length > 7 ? medidos.slice(0, 4).concat(medidos.slice(-3)) : medidos;
    const imgs = await Promise.all(escolhidos.map(function (x) { return imagemBase64(x.p.miniatura).then(function (im) { return im ? [x, im] : null; }); }));
    const blocos = [{ type: "text", text: texto }];
    imgs.filter(Boolean).forEach(function (par) { blocos.push({ type: "text", text: "Capa de " + par[0].cod + " (" + String(arred(par[0].p.indice, 2)).replace(".", ",") + "x a média):" }, par[1]); });
    return { chave: "mem", nome: "Agente de Memoria", esquema: ESQ_MEMORIA, pedido: blocos, max: 10000 };
}
const NOME_FORMATO_TXT = { curto: "vídeo curto", narrado: "vídeo narrado", provador: "provador" };
// a memoria nova (ou a de antes) + as ideias que acabaram de ser sugeridas
function memoriaNova(ctx, p, mapaMem, ideias) {
    const antes = ctx.memoria || {};
    let mem = Object.assign({}, antes);
    if (p.mem) {
        const m = p.mem, ideiasMap = (mapaMem && mapaMem.ideias) || {}, postsMap = (mapaMem && mapaMem.posts) || {};
        const vinculos = (m.vinculos || []).map(function (v) {
            const ideia = ideiasMap[String(v.ideia).trim().toUpperCase()], post = postsMap[String(v.post).trim().toUpperCase()];
            if (!ideia || !post) return null;
            return { ideia: ideia, post_link: post.link, miniatura: post.miniatura, data: post.data, indice: post.indice, confianca: v.confianca, resultado: v.resultado };
        }).filter(Boolean);
        // guarda as ligacoes antigas que nao voltaram (o post saiu da janela de 35 dias)
        const ja = {};
        vinculos.forEach(function (v) { ja[v.ideia + "|" + v.post_link] = 1; });
        const velhas = (antes.vinculos || []).filter(function (v) { return !ja[v.ideia + "|" + v.post_link]; });
        mem = Object.assign(mem, { resumo: m.resumo, aprendizados: (m.aprendizados || []).slice(0, 12), visual: m.visual || [], gosto: m.gosto || [], vinculos: vinculos.concat(velhas).slice(0, 40), aprendeu_em: new Date().toISOString() });
    }
    return comSugeridas(mem, ideias);
}

// ---------- etapa 1: organico, anuncios, publico e memoria ----------
async function pedidosEtapa1(ctx) {
    const pedidos = [], ads = ctx.ads, posts = ctx.posts, met = ctx.met;
    if (posts.length) pedidos.push({
        chave: "org", nome: "Agente Organico", esquema: ESQ_ORGANICO,
        pedido: "Você é o AGENTE ORGÂNICO. Estude os posts do Instagram desta loja nos últimos 90 dias, ordenados do melhor para o pior pelo índice (com peso maior para os últimos 30 dias). Descubra o que os posts acima da média têm em comum (gancho, formato, assunto, tamanho, fala) e o que os abaixo da média fazem diferente. Em ganchos_que_funcionam, traga os ganchos reais dos melhores posts (da legenda ou da fala), reescritos de forma curta. Em formatos_mae, os formatos que a loja deve repetir com variação (80% do conteúdo). Em resumo, 2 frases para a dona da loja.\n\n" +
            ctx.sobreLoja + "\nTOTAL DE POSTS NOS 90 DIAS: " + ctx.postsTodos.length + " | taxa média de engajamento da conta: " + ((met.organico && met.organico.taxa_media) || 0) + "%\nPOSTS:\n" + posts.map(linhaPost).join("\n")
    });
    if (ads) {
        const comTexto = ads.lista.filter(function (a) { return a.texto || a.transcricao; }).length;
        const tipoTxt = ads.tipo === "vendas" ? "compras (a loja tem pixel)" : ads.tipo === "conversas" ? "conversas iniciadas no WhatsApp ou Direct (a loja vende por conversa)" : (ads.totais.misto ? "cada campanha tem o próprio objetivo (veja objetivo medido em cada anúncio); compare só anúncios de mesmo objetivo" : "o objetivo da campanha, indicado em cada anúncio");
        pedidos.push({
            chave: "ads", nome: "Agente de Anuncios", esquema: ESQ_ANUNCIOS,
            pedido: "Você é o AGENTE DE ANÚNCIOS. Estude os anúncios desta loja nos últimos 90 dias. " +
                (comTexto ? "Os números vêm do Reportei. Em " + comTexto + " de " + ads.lista.length + " anúncios também vêm o TEXTO DO ANÚNCIO e a FALA DO VÍDEO (da Meta): use-os como fonte principal do gancho e do argumento. Nos outros só há o nome, que costuma descrever o vídeo." : "Só há o nome de cada anúncio (que costuma descrever o vídeo) e os números.") +
                " Descubra o que os anúncios que mais dão resultado têm em comum (gancho, assunto, argumento, oferta, chamada), quais trazem venda de valor alto e quais estão cansando, e onde os fracos perdem gente (no gancho, no corpo ou na chamada). Em resumo, 2 frases para a dona da loja.\n\n" +
                ctx.sobreLoja + "\nRESULTADO = " + tipoTxt + "\nTOTAIS 90 DIAS: investido " + brl(ads.totais.gasto) + " | alcance " + (ads.totais.alcance || 0) + " | cliques " + (ads.totais.cliques || 0) +
                (ads.tipo !== "resultados" ? " | " + ads.totais.resultados + " " + nomeResultado(ads.tipo) : "") + (ads.totais.receita > 0 ? " | vendeu " + brl(ads.totais.receita) : "") +
                "\nMÉDIAS DA CONTA: taxa de gancho " + (ads.medias.taxa_gancho || 0) + "% | retenção " + (ads.medias.retencao || 0) + "% | taxa de clique " + (ads.medias.ctr || 0) + "%\nANÚNCIOS (do que mais deu resultado para o que menos deu):\n" +
                ads.lista.map(function (a, i) { return linhaAnuncio(ads.tipo, a, i); }).join("\n")
        });
    }
    if (publicoVencido(ctx)) {
        const seguidores = ctx.demografia || await publicoDoReportei(ctx.userId);
        pedidos.push({
            chave: "pub", nome: "Agente de Publico", esquema: ESQ_PUBLICO,
            pedido: "Você é o AGENTE DE PÚBLICO. Monte o mapa do público desta loja no método da consultoria: quem é (idade, gênero, cidades), como cada faixa de idade compra, dores, desejos, objeções, motivos de compra e de desistência, gatilhos que funcionam, situações do dia a dia e ângulos de comunicação. Esse mapa é a base das ideias de conteúdo, então cada item precisa ser concreto e reconhecível pela cliente.\n" +
                "- Idade, gênero e cidades vêm dos DADOS DE SEGUIDORES. Divida por faixa de idade só as faixas que têm peso de verdade nos dados.\n" +
                "- " + (ctx.comentarios.length ? "Os COMENTÁRIOS REAIS são a fonte principal para dores, desejos, objeções e jeito de falar. Em expressoes_reais, traga de 5 a 10 expressões que as seguidoras usam, copiadas como elas escreveram (corrigindo só a acentuação)." : "Não há comentários do público nos dados. Em expressoes_reais, traga as frases das legendas ou falas da loja que mais engajaram; se não houver, deixe a lista vazia.") + "\n" +
                "- Os outros itens são leituras suas a partir do que mais engajou e vendeu: diga quando não há dado direto.\n" +
                "- Se vierem AJUSTES DA CONSULTORIA SOBRE O PÚBLICO, eles valem mais que a sua leitura.\n" +
                "Em resumo, 2 frases para a dona da loja.\n\n" +
                ctx.sobreLoja + "\nDADOS DE SEGUIDORES: " + (seguidores || "não disponível") +
                (ctx.comentarios.length ? "\nCOMENTÁRIOS REAIS DAS SEGUIDORAS (dos melhores posts):\n" + ctx.comentarios.map(function (c) { return "- " + c; }).join("\n") : "") +
                "\nLEGENDAS E FALAS DOS MELHORES POSTS:\n" + (ctx.posts.slice(0, 8).map(function (p, i) { return "P" + (i + 1) + ") " + corta(p.legenda, 250) + (p.transcricao ? " | fala: " + corta(p.transcricao, 500) : ""); }).join("\n") || "nenhum") +
                (ads ? "\nANÚNCIOS QUE MAIS DERAM RESULTADO:\n" + ads.lista.slice(0, 6).map(function (a, i) { return "A" + (i + 1) + ") " + corta(a.nome, 120) + " | " + a.resultados + " " + nomeResultado(ads.tipo, a) + (a.texto ? " | texto: " + corta(a.texto, 250) : ""); }).join("\n") : ""),
            max: 14000
        });
    }
    const mem = await pedidoMemoria(ctx);
    if (mem) pedidos.push(mem);
    return pedidos;
}

// ---------- etapa 2: diretor e especialistas em ideias ----------
const ESPECIALISTAS = {
    curto: {
        letra: "C", nome: "Especialista em videos curtos",
        texto: "Você é o ESPECIALISTA EM VÍDEOS CURTOS. Você cria vídeos dopaminérgicos de topo de funil: de 7 a 15 segundos, sem fala, que param a rolagem no primeiro segundo e fazem a pessoa assistir de novo. É o formato que leva a loja a quem ainda não a conhece, porque o Instagram entrega para fora quando as pessoas assistem até o fim, repetem e mandam para uma amiga.\n" +
            "COMO É UM BOM VÍDEO CURTO\n" +
            "- O primeiro quadro já tem movimento e a peça, porque é ali que a pessoa decide se fica. A abertura começa na ação, sem logo e sem a dona se preparando.\n" +
            "- Cortes a cada 1 ou 2 segundos, no ritmo do áudio, com transições que viram brincadeira: troca de look no pulo ou no estalar de dedos, a peça jogada na câmera, giro, mão passando na lente.\n" +
            "- Texto grande na tela, de 3 a 8 palavras, dizendo o que a pessoa vê ou o preço, porque muita gente assiste sem som.\n" +
            "- Final que emenda no começo, para o vídeo ser assistido de novo.\n" +
            "- Cara de conteúdo nativo do Instagram, gravado com o celular. Visual cru e real prende mais que anúncio produzido.\n" +
            "REPERTÓRIO (referência de formato para adaptar a esta loja): 1 peça, 5 looks no ritmo da música; troca de look a cada batida; do pijama ao look do evento; o provador em 7 segundos; close no tecido, no bordado e no caimento; o look inteiro montado em 10 segundos; POV só em texto na tela (POV: você achou o look do casamento); a mesma peça em 4 cores; antes e depois do look (da roupa, nunca do corpo); unboxing dos lançamentos; esgotou e voltou, quando for verdade.\n" +
            "EM CADA IDEIA: passos = de 4 a 8 tomadas na ordem, cada uma com o que aparece e quantos segundos; fala vazia; stories vazio; duracao_s entre 7 e 15; funil topo; metrica em palavras simples (quantas pessoas ficaram nos 3 primeiros segundos, quantas assistiram de novo e compartilharam)."
    },
    narrado: {
        letra: "N", nome: "Especialista em videos narrados",
        texto: "Você é o ESPECIALISTA EM VÍDEOS NARRADOS. Você cria vídeos de meio de funil, de 20 a 45 segundos, com a dona falando para a câmera, para quem já viu a loja e está pensando em comprar. Eles funcionam quando a cliente se reconhece na situação e vê a peça resolvendo a vida dela.\n" +
            "FORMATOS QUE FUNCIONAM: POV de ocasião (você tem um jantar sábado e ainda não escolheu o look); identificação com uma dor do dia a dia (abro o guarda-roupa e não tenho roupa); esse ou esse, comparando modelagens; 1 peça, 3 ocasiões; a dúvida dos comentários respondida; oferta com o preço já no gancho, quando a loja informar o preço; bastidor da loja e da chegada das peças.\n" +
            "COMO É UM BOM NARRADO: a peça já aparece enquanto a dona fala a primeira frase (o gancho, em até 2 segundos); o corpo traz um argumento concreto (tecido, caimento, tamanhos, preço, ocasião); o fechamento dá a conclusão e um convite leve.\n" +
            "EM CADA IDEIA: passos = de 3 a 6 cenas; fala = os pontos principais do que ela fala, no jeito dela (o roteiro completo sai depois, no Novo roteiro); stories vazio; duracao_s entre 20 e 45; funil meio; metrica em palavras simples (tempo que as pessoas assistem, salvamentos e comentários)."
    },
    provador: {
        letra: "V", nome: "Especialista em provador",
        texto: "Você é o ESPECIALISTA EM PROVADOR. Você cria conteúdos de fundo de funil: a peça provada no corpo, no espelho ou no provador da loja, para quem já quer comprar e tem dúvida. Em loja de moda é o formato que mais gera conversa no direct e venda, porque responde à pergunta que trava a compra: vai vestir bem em mim?\n" +
            "COMO É UM BOM PROVADOR: frente, costas, lateral e movimento; close no tecido, na costura e no detalhe; a dona diz o tamanho que está usando, a altura dela, o tecido, os tamanhos disponíveis e o preço (quando a loja informar); responde a objeção principal do público (marca, transparece, aperta, veste o 46, amassa); fecha chamando para o direct com uma palavra.\n" +
            "O Reels do provador continua nos Stories: mostrar o look, falar da sensação (leve, confortável, veste bem), mostrar o detalhe, fazer uma enquete ou caixinha e chamar para o direct.\n" +
            "EM CADA IDEIA: passos = as tomadas do provador; fala = os pontos do que falar; stories = sequência de 3 a 5 stories que acompanha; duracao_s entre 15 e 35; funil fundo; metrica em palavras simples (conversas no direct, respostas nos stories e vendas)."
    }
};
function regrasDasIdeias(ctx, anteriores) {
    const hoje = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "long", year: "numeric" }).format(new Date());
    const datas = datasDoVarejo(new Date());
    return "\n\nCOMO USAR OS DADOS DESTA LOJA\n" +
        "- Regra 80/20: a maior parte das ideias repete, com peça e situação novas, os FORMATOS-MÃE que já provaram resultado nesta conta; o resto testa um formato novo. Repetir o que funcionou com variação é o que dá constância.\n" +
        "- Cada ideia se apoia num dado desta loja: um post (P) ou anúncio (A) que funcionou, com o código em inspirado_em; um comentário; uma dor ou situação do MAPA DE PÚBLICO; um produto do momento; ou uma data do calendário.\n" +
        "- Use as peças dos PRODUTOS E OFERTAS DO MOMENTO sempre que fizer sentido. Sem produto informado, use a peça como aparece nos posts que funcionaram ou escreva 'a peça que você quer vender'.\n" +
        "- Fale com a faixa de idade que mais segue a loja e com as situações do dia a dia dela.\n" +
        "- Se vier O QUE O TIME JÁ APRENDEU COM ESTA LOJA, parta disso: repita com variação o que deu resultado aqui, evite o que ficou abaixo, siga os padrões das capas que funcionaram e respeite o gosto da dona. Ideias parecidas com as que ela marcou como Gostei têm prioridade.\n" +
        "- Hoje é " + hoje + ". Datas do varejo das próximas semanas: " + (datas.join(", ") || "nenhuma") + ".\n\n" +
        "REGRAS\n" +
        "- Preço, promoção, estoque, depoimento e número só entram se estiverem nos dados ou nos produtos informados. Urgência e escassez só com estoque baixo informado.\n" +
        "- Antes e depois só do look. Fale da peça e da situação, não do corpo da cliente (a calça que não marca, e não você que tem barriga), porque a Meta reprova anúncio que aponta característica pessoal e porque assim a cliente se sente bem.\n" +
        "- Tudo gravável só com o celular pela dona ou pela equipe.\n" +
        "- Escreva para a dona entender de primeira: cada passo com até 12 palavras, dizendo o que aparece; por_que e metrica com uma frase curta cada.\n" +
        "- Entregue 6 ideias diferentes entre si (peças, situações e ganchos distintos)." +
        (anteriores.length ? "\n- Estas ideias já foram sugeridas; traga outras: " + anteriores.slice(0, 40).join(" | ") : "");
}
function contextoDasIdeias(ctx, p) {
    const pub = p.pub || ctx.dossie.publico;
    return textoMemoria(p.mem || ctx.memoria) + textoGosto(ctx) + "\n\n" + ctx.sobreLoja +
        "\nDADOS DE SEGUIDORES: " + (ctx.demografia || "não disponível") +
        "\nMAPA DE PÚBLICO: " + resumoRel(pub) +
        "\nRELATÓRIO ORGÂNICO (com os formatos-mãe): " + resumoRel(p.org) +
        "\nRELATÓRIO DE ANÚNCIOS: " + resumoRel(p.ads) +
        dadosEmTexto(ctx, 20, 12, 30);
}
// o pacote de dados vem primeiro e igual para os 3: o primeiro grava no cache e os outros leem por 10% do preco
function pedidosEspecialistas(ctx, p, anteriores) {
    const base = (regrasDasIdeias(ctx, anteriores) + contextoDasIdeias(ctx, p)).trim();
    return Object.keys(ESPECIALISTAS).map(function (f) {
        const e = ESPECIALISTAS[f];
        return { chave: "esp_" + f, nome: e.nome, esquema: ESQ_ESPECIALISTA, cache: true, max: 16000,
            pedido: [{ type: "text", text: base, cache_control: { type: "ephemeral" } }, { type: "text", text: "SUA TAREFA\n" + e.texto }] };
    });
}
function pedidoDiretor(ctx, p) {
    return {
        chave: "dir", nome: "Diretor", esquema: ESQ_DIRETOR,
        pedido: "Você é o DIRETOR do time. Junte os relatórios num dossiê para o Agente MCP, que escreve os roteiros desta loja. Tudo com acentuação correta.\n" +
            "- texto: até 1400 caracteres, denso e específico, para o Agente MCP: quem é o público e como fala, os formatos-mãe desta conta, o que dá resultado nos anúncios, os produtos do momento (se houver), de 3 a 5 ganchos modelo no estilo do que já funcionou e o que evitar.\n" +
            "- resumo_loja: 2 ou 3 frases curtas para a dona ler no celular, sem jargão: o que mais tem dado certo e o que gravar a seguir.\n" +
            "- por_metodo: para cada um dos 5 métodos abaixo, 1 ou 2 frases de como aplicar nesta loja com base nos dados.\n" +
            "- nicho: o nicho desta loja.\n" +
            "- Se vier O QUE O TIME JÁ APRENDEU COM ESTA LOJA, isso vale mais que as leituras gerais: coloque no texto os aprendizados fortes e o gosto da dona.\n\n" + METODOS_RESUMO + textoMemoria(p.mem || ctx.memoria) + "\n\n" + ctx.sobreLoja +
            "\nRELATÓRIO ORGÂNICO: " + resumoRel(p.org) + "\nRELATÓRIO DE ANÚNCIOS: " + resumoRel(p.ads) + "\nMAPA DE PÚBLICO: " + resumoRel(p.pub || ctx.dossie.publico)
    };
}
function pedidosEtapa2(ctx, p) {
    return [pedidoDiretor(ctx, p)].concat(pedidosEspecialistas(ctx, p, titulosAnteriores(ctx)));
}
function titulosAnteriores(ctx) {
    const i = ctx.dossie.ideias || {};
    return (i.lista || []).concat(i.reserva || []).map(function (x) { return x.titulo; }).filter(Boolean);
}

// ---------- etapa 3: curador ----------
function candidatas(p) {
    const out = [];
    Object.keys(ESPECIALISTAS).forEach(function (f) {
        (((p["esp_" + f] || {}).ideias) || []).forEach(function (x, i) { out.push({ codigo: ESPECIALISTAS[f].letra + (i + 1), formato: f, ideia: x }); });
    });
    return out;
}
function pedidoCurador(ctx, p) {
    const cands = candidatas(p);
    return {
        chave: "cur", nome: "Curador", esquema: ESQ_CURADOR,
        pedido: "Você é o CURADOR do time. Os especialistas escreveram opções de vídeos curtos (C), narrados (N) e provador (V) para esta loja. Escolha as melhores para esta semana: 4 curtos, 3 narrados e 3 provadores, em ordem de prioridade dentro de cada formato. Critérios, nesta ordem:\n" +
            "1. apoiada num dado real desta loja (post ou anúncio que funcionou, comentário, dor do público, produto do momento, data próxima);\n" +
            "2. primeiro segundo forte e fácil de entender sem som;\n" +
            "3. executável só com o celular;\n" +
            "4. diferentes entre si: sem duas com o mesmo tema, peça ou gancho;\n" +
            "5. sem preço, promoção ou número que não esteja nos dados;\n" +
            "6. de acordo com o que o time já aprendeu com esta loja e com o gosto da dona, quando houver.\n" +
            "Depois ordene as que sobraram em reserva, da melhor para a pior, deixando de fora as fracas ou repetidas. Em resumo, 2 frases para a dona: por onde começar esta semana e por quê.\n\n" +
            ctx.sobreLoja + "\nMAPA DE PÚBLICO (resumo): " + (((p.pub || ctx.dossie.publico) || {}).resumo || "não disponível") + textoMemoria(p.mem || ctx.memoria) + textoGosto(ctx) +
            "\n\nOPÇÕES:\n" + cands.map(function (c) { return c.codigo + ") " + JSON.stringify(c.ideia); }).join("\n")
    };
}
function formatoAntigo(f) { return f === "curto" ? "rápido com transições" : f; }
// junta a escolha do curador com as ideias dos especialistas (sem curador, pega as primeiras de cada formato)
function montarIdeias(p, mapa) {
    const cands = candidatas(p), porCodigo = {};
    cands.forEach(function (c) { porCodigo[c.codigo] = c; });
    const cur = p.cur || {};
    let principais = (cur.principais || []).filter(function (c) { return porCodigo[c]; });
    if (principais.length < 6) {
        principais = [];
        [["curto", 4], ["narrado", 3], ["provador", 3]].forEach(function (x) { cands.filter(function (c) { return c.formato === x[0]; }).slice(0, x[1]).forEach(function (c) { principais.push(c.codigo); }); });
    }
    const usados = {};
    principais.forEach(function (c) { usados[c] = 1; });
    let reserva = (cur.reserva || []).filter(function (c) { return porCodigo[c] && !usados[c]; });
    if (!cur.reserva) reserva = cands.map(function (c) { return c.codigo; }).filter(function (c) { return !usados[c]; });
    function ideia(codigo) {
        const c = porCodigo[codigo], x = c.ideia, insp = x.inspirado_em && mapa && mapa[String(x.inspirado_em).trim().toUpperCase()];
        return {
            titulo: x.titulo, formato: c.formato, formatos: [formatoAntigo(c.formato)],
            gancho: x.gancho, como_fazer: x.gancho, passos: x.passos || [], texto_na_tela: x.texto_na_tela || "", fala: x.fala || "", stories: x.stories || [],
            duracao_s: x.duracao_s || null, peca: x.peca || "", inspirado: insp || null, por_que: x.por_que, metrica: x.metrica, funil: x.funil, metodo: x.metodo
        };
    }
    // ordem da tela: curtos, narrados e provador
    const ordem = { curto: 0, narrado: 1, provador: 2 };
    const lista = principais.map(ideia).sort(function (a, b) { return ordem[a.formato] - ordem[b.formato]; });
    return { resumo: cur.resumo || "", lista: lista, reserva: reserva.map(ideia) };
}

// ---------- dossie final ----------
async function salvarDossie(ctx, p, motivo, mapa, mapaMem) {
    const met = ctx.met, dossieAnt = ctx.dossie, posts = ctx.posts, ads = ctx.ads;
    const dir = p.dir || {};
    const ideias = montarIdeias(p, mapa);
    const antIdeias = dossieAnt.ideias || {};
    const pubNovo = !!p.pub;
    const dossie = {
        versao: VERSAO, periodo_dias: 90, gerado_em: new Date().toISOString(), motivo: motivo || "manual",
        assinatura: met.assinatura || assinaturaDe(met), modelo: MODELO,
        texto: dir.texto || dossieAnt.texto, resumo_loja: dir.resumo_loja || dossieAnt.resumo_loja, por_metodo: dir.por_metodo || dossieAnt.por_metodo, nicho: dir.nicho || dossieAnt.nicho,
        ...vozEGanchos(met, ctx.comentarios),
        organico: p.org ? { relatorio: p.org, total_posts: ctx.postsTodos.length, videos: posts.filter(function (x) { return x.transcricao; }).map(function (x) { return { id: x.id, link: x.link, legenda: corta(x.legenda, 80), transcricao: x.transcricao }; }) } : null,
        anuncios: ads ? { relatorio: p.ads, tipo_resultado: ads.tipo, total: ads.lista.length, com_texto: ads.lista.filter(function (a) { return a.texto || a.transcricao; }).length, anuncios: ads.lista.filter(function (a) { return a.transcricao; }).map(function (a) { return { id: a.id, nome: a.nome, transcricao: a.transcricao }; }) } : null,
        ideias: ideias.lista.length ? Object.assign({ gerado_em: new Date().toISOString(), resumo: ideias.resumo, lista: ideias.lista, reserva: ideias.reserva }, antIdeias.levas_dia ? { levas_dia: antIdeias.levas_dia, levas: antIdeias.levas } : {}) : (antIdeias.lista ? antIdeias : null),
        publico: p.pub || dossieAnt.publico || null,
        publico_em: pubNovo ? new Date().toISOString() : (dossieAnt.publico_em || null),
        publico_admin_usado: pubNovo ? (ctx.loja.publico_admin || "") : (dossieAnt.publico_admin_usado || ""),
        publico_fonte: ctx.comentarios.length ? "comentarios" : "legendas",
        demografia: ctx.cacheMeta && ctx.cacheMeta.demografia ? ctx.demografia : "",
        meta: ctx.cacheMeta ? { em: ctx.cacheMeta.em, erro: ctx.cacheMeta.erro, comentarios: ctx.comentarios.length } : null
    };
    const memoria = memoriaNova(ctx, p, mapaMem, ideias.lista);
    await banco("contas_meta?user_id=eq." + encodeURIComponent(ctx.userId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { dossie: dossie, dossie_job: null, memoria: memoria, status: "Analisada", atualizado_em: dossie.gerado_em } });
    return dossie;
}

// ---------- andamento das etapas ----------
function marcar(userId, status) {
    return banco("contas_meta?user_id=eq." + encodeURIComponent(userId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { status: status, atualizado_em: new Date().toISOString() } });
}
function salvarJob(userId, job) {
    return banco("contas_meta?user_id=eq." + encodeURIComponent(userId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { dossie_job: job } });
}
async function pedidosDaEtapa(ctx, job) {
    if (job.etapa === 1) { const ped = await pedidosEtapa1(ctx); if (ctx.mapaMem) job.mapaMem = ctx.mapaMem; return ped; }
    if (job.etapa === 2) { job.mapa = mapaDeCodigos(ctx); return pedidosEtapa2(ctx, job.parciais); }
    return candidatas(job.parciais).length ? [pedidoCurador(ctx, job.parciais)] : [];
}
// roda na hora os pedidos que faltam (modo "agora", ou o que falhou no lote)
async function rodarAgora(ctx, pedidos, parciais) {
    function um(p, aoComecar) {
        return perguntar(ctx.userId, p, aoComecar).then(function (x) { return [p.chave, x]; }).catch(function (e) {
            // sem diretor ou sem os relatorios nao da para seguir; ideia de um especialista (ou a memoria) pode faltar
            if (/^esp_|^cur|^mem/.test(p.chave)) { console.error("[time] " + p.nome + ": " + (e && e.message)); return [p.chave, null]; }
            throw e;
        });
    }
    // os especialistas dividem o mesmo pacote de dados: o primeiro vai sozinho e grava o cache;
    // os outros saem quando ele comeca a responder e leem o cache (10% do preco dessa parte)
    const juntos = pedidos.filter(function (p) { return p.cache; });
    const tarefas = pedidos.filter(function (p) { return !p.cache; }).map(function (p) { return um(p); });
    if (juntos.length) {
        let libera;
        const comecou = new Promise(function (ok) { libera = ok; });
        const primeiro = um(juntos[0], libera);
        primeiro.then(libera, libera);
        tarefas.push(primeiro);
        tarefas.push(Promise.race([comecou, espera(20000)]).then(function () { return Promise.all(juntos.slice(1).map(function (p) { return um(p); })); }));
    }
    const r = [];
    (await Promise.all(tarefas)).forEach(function (x) { if (Array.isArray(x[0])) x.forEach(function (y) { r.push(y); }); else r.push(x); });
    r.forEach(function (x) { if (x[1]) parciais[x[0]] = x[1]; });
}

// Comeca uma analise. modo "lote" (madrugada) ou "agora".
async function iniciarAnalise(userId, modo, motivo) {
    const ctx = await preparar(await carregar(userId), true);
    const job = { modo: modo, etapa: 1, motivo: motivo || modo, criado_em: new Date().toISOString(), parciais: {} };
    if (modo === "agora") await marcar(userId, "Analisando");
    return avancarEtapa(ctx, job);
}
// Faz a etapa atual andar: no lote, cria ou confere o lote; na hora, roda a etapa.
async function avancarEtapa(ctx, job) {
    const userId = ctx.userId;
    if (job.modo === "lote" && job.lote) {
        const b = await lerLote(job.lote);
        const vencido = Date.now() - new Date(job.lote_em || job.criado_em).getTime() > LOTE_VENCIDO_MS;
        if (b.processing_status !== "ended" && !vencido) return { status: "aguardando_lote", etapa: job.etapa };
        if (b.processing_status === "ended" && b.results_url) {
            for (const linha of await resultadosDoLote(b.results_url)) {
                if (linha.result && linha.result.type === "succeeded") {
                    const msg = linha.result.message;
                    await registrarUso(userId, "lote: " + linha.custom_id, MODELO, msg.usage, true);
                    try { job.parciais[linha.custom_id] = lerResposta(linha.custom_id, msg); } catch (e) { console.error("[time] lote " + linha.custom_id + ": " + e.message); }
                }
            }
        }
        // o que nao voltou do lote roda na hora (preco normal), para a analise nao parar
        const faltam = (job.pedidos || []).filter(function (c) { return !job.parciais[c]; });
        if (faltam.length) {
            if (!ctx.posts) await preparar(ctx, false);
            const pedidos = (await pedidosDaEtapa(ctx, job)).filter(function (p) { return faltam.indexOf(p.chave) > -1; });
            await rodarAgora(ctx, pedidos, job.parciais);
        }
        job.etapa++; delete job.lote; delete job.pedidos;
    }
    // prepara a proxima etapa (ou a primeira)
    if (!ctx.posts) await preparar(ctx, false);
    if (job.etapa > 3) { await salvarDossie(ctx, job.parciais, job.motivo, job.mapa, job.mapaMem); return { status: "pronta" }; }
    const pedidos = await pedidosDaEtapa(ctx, job);
    if (!pedidos.length) { job.etapa++; return avancarEtapa(ctx, job); }
    if (job.modo === "lote") {
        job.lote = await criarLote(pedidos);
        job.lote_em = new Date().toISOString();
        job.pedidos = pedidos.map(function (p) { return p.chave; });
        await salvarJob(userId, job);
        return { status: "lote_criado", etapa: job.etapa };
    }
    job.rodando_ate = new Date(Date.now() + RODANDO_MS).toISOString();
    await salvarJob(userId, job);
    await rodarAgora(ctx, pedidos, job.parciais);
    job.etapa++; delete job.rodando_ate;
    await salvarJob(userId, job);
    return { status: "etapa_feita", etapa: job.etapa - 1 };
}

// Rodada automatica (api/atualizar.js): continua a analise em andamento, enquanto houver tempo
// temEmpo(): true se ainda da para rodar uma etapa na hora
async function continuarAnalise(userId, temTempo) {
    let ctx = await carregar(userId), job = ctx.job;
    if (!job) return { status: "sem_analise" };
    if (job.rodando_ate && new Date(job.rodando_ate).getTime() > Date.now()) return { status: "em_andamento" };
    // analise na hora parada ha muito tempo: recomeca do zero na proxima vez
    if (job.modo === "agora" && Date.now() - new Date(job.criado_em).getTime() > AGORA_VENCIDO_MS) {
        await salvarJob(userId, null); await marcar(userId, "Analisada");
        return { status: "recomecar" };
    }
    let r;
    try {
        do {
            r = await avancarEtapa(ctx, job);
            if (r.status !== "etapa_feita") break;
            ctx = await carregar(userId); job = ctx.job;
        } while (job && job.modo === "agora" && temTempo());
    } catch (e) {
        job.erros = (job.erros || 0) + 1; delete job.rodando_ate;
        // 3 falhas seguidas: desiste desta analise e volta a mostrar a anterior
        if (job.erros >= 3) { await salvarJob(userId, null); await marcar(userId, "Erro na analise: " + corta(e && e.message, 160)); }
        else await salvarJob(userId, job);
        throw e;
    }
    return r;
}

// Analise completa na hora (botao do admin e primeira analise): roda as 3 etapas em sequencia
async function analisarLoja(userId, motivo) {
    try {
        await iniciarAnalise(userId, "agora", motivo || "manual");
        const r = await continuarAnalise(userId, function () { return true; });
        const d = (await carregar(userId)).dossie;
        return {
            ok: r.status === "pronta", ideias: ((d.ideias && d.ideias.lista) || []).length, nicho: d.nicho,
            posts: (d.organico && d.organico.total_posts) || 0, anuncios: (d.anuncios && d.anuncios.total) || 0,
            falas: ((d.organico && d.organico.videos) || []).length + ((d.anuncios && d.anuncios.anuncios) || []).length,
            comentarios: (d.meta && d.meta.comentarios) || 0, meta_erro: d.meta ? d.meta.erro : null
        };
    } catch (e) {
        await marcar(userId, "Erro na analise: " + corta(e && e.message, 160)).catch(function () {});
        await salvarJob(userId, null).catch(function () {});
        throw e;
    }
}

// ---------- "Gerar mais ideias" pedido pela dona ----------
// Primeiro tira da reserva do curador (na hora e sem custo); sem reserva, os especialistas escrevem de novo.
const MAX_LEVAS_DIA = 3, POR_LEVA = { curto: 2, narrado: 2, provador: 2 };
class ErroIdeias extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function gerarMaisIdeias(userId) {
    const ctx = await carregar(userId), dossie = ctx.dossie;
    if (!ctx.met || !(dossie.organico || dossie.anuncios || dossie.publico)) throw new ErroIdeias(409, "O time de agentes ainda está estudando a sua conta. Assim que a análise terminar, você pode pedir mais ideias.");
    const hoje = diaSP(new Date()), ant = dossie.ideias || {};
    const levas = ant.levas_dia === hoje ? (ant.levas || 0) : 0;
    if (levas >= MAX_LEVAS_DIA) throw new ErroIdeias(429, "Você já pediu mais ideias " + MAX_LEVAS_DIA + " vezes hoje. Amanhã tem mais!");
    let reserva = (ant.reserva || []).slice(), novas = [];
    Object.keys(POR_LEVA).forEach(function (f) {
        reserva.filter(function (x) { return x.formato === f; }).slice(0, POR_LEVA[f]).forEach(function (x) { novas.push(x); });
    });
    reserva = reserva.filter(function (x) { return novas.indexOf(x) < 0; });
    if (novas.length < 3) {
        await preparar(ctx, false);
        const p = { org: dossie.organico && dossie.organico.relatorio, ads: dossie.anuncios && dossie.anuncios.relatorio, pub: dossie.publico };
        await rodarAgora(ctx, pedidosEspecialistas(ctx, p, titulosAnteriores(ctx)), p);
        if (!candidatas(p).length) throw new ErroIdeias(502, "Não consegui gerar ideias agora. Tente de novo em alguns minutos.");
        await rodarAgora(ctx, [pedidoCurador(ctx, p)], p);
        const feitas = montarIdeias(p, mapaDeCodigos(ctx));
        novas = feitas.lista; reserva = feitas.reserva;
    }
    const ideias = Object.assign({}, ant, {
        gerado_em: new Date().toISOString(),
        lista: novas.map(function (i) { return Object.assign({}, i, { nova: true }); }).concat((ant.lista || []).map(function (i) { const c = Object.assign({}, i); delete c.nova; return c; })).slice(0, 60),
        reserva: reserva, levas_dia: hoje, levas: levas + 1
    });
    await banco("contas_meta?user_id=eq." + encodeURIComponent(userId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { dossie: Object.assign({}, dossie, { ideias: ideias }), memoria: comSugeridas(ctx.memoria, novas) } });
    return { ok: true, novas: novas.length, total: ideias.lista.length, restam_hoje: MAX_LEVAS_DIA - levas - 1 };
}

// ---------- quando cada loja e analisada (usado por api/atualizar.js) ----------
// c: linha de contas_meta (status, atualizado_em, assinatura, dossie_versao, dossie_em, tem_job);
// acessoEm: ultima vez que a dona abriu o app; ativaDesde: quando a loja entrou (conexao no Reportei)
// novidade desde a ultima analise: post novo, anuncio novo ou produtos do momento atualizados
const NOVIDADE_MS = 44 * HORA_MS;        // com novidade: no maximo a cada 2 noites
const SEM_NOVIDADE_MS = 68 * HORA_MS;    // sem novidade: pelo menos a cada 3 noites
function depois(a, b) { return !!(a && b && new Date(a).getTime() > new Date(b).getTime()); }
function temNovidade(c) { return depois(c.ultimo_post, c.dossie_em) || !!(c.assinatura && c.dossie_assinatura && c.assinatura !== c.dossie_assinatura); }
function produtosNovos(c) { return depois(c.produtos_em, c.dossie_em); }
function situacao(c, agora, acessoEm, ativaDesde) {
    const acesso = acessoEm ? new Date(acessoEm).getTime() : 0, entrou = ativaDesde ? new Date(ativaDesde).getTime() : 0;
    const ativa = agora - Math.max(acesso, entrou) < ATIVA_MS;
    const idade = c && c.dossie_em ? agora - new Date(c.dossie_em).getTime() : Infinity;
    return { ativa: ativa, idade: idade, acessouAgora: acesso && agora - acesso < 30 * 60000 };
}
// precisa de analise NA HORA? (primeira analise, versao nova, loja que voltou depois de parada, ou o lote nao rodou)
function precisaAnalisarAgora(c, agora, acessoEm, ativaDesde) {
    if (!c || !c.assinatura || c.tem_job) return false;
    const desde = c.atualizado_em ? agora - new Date(c.atualizado_em).getTime() : Infinity;
    // deu erro: espera antes de tentar de novo (sem credito na Anthropic, tenta logo: nada e cobrado e volta assim que recarregar)
    if (/^Erro/.test(c.status || "") && desde < (/credit balance/i.test(c.status || "") ? 10 * 60000 : 2 * HORA_MS)) return false;
    if (String(c.dossie_versao) !== String(VERSAO) || !c.dossie_em) return true;
    const s = situacao(c, agora, acessoEm, ativaDesde);
    if (s.acessouAgora && s.idade >= SEM_NOVIDADE_MS + 4 * HORA_MS) return true;  // voltou depois de parada: atualiza enquanto ela usa
    return s.ativa && s.idade >= SEM_NOVIDADE_MS + 8 * HORA_MS;                    // ativa e o lote da madrugada nao rodou
}
// entra no lote da madrugada? loja ativa e: produtos novos (desde ontem), novidade (a cada 2 noites) ou 3 noites sem analise
function entraNoLote(c, agora, acessoEm, ativaDesde) {
    if (!c || !c.assinatura || c.tem_job || /^Analisando/.test(c.status || "")) return false;
    if (String(c.dossie_versao) !== String(VERSAO)) return false;
    const s = situacao(c, agora, acessoEm, ativaDesde);
    if (!s.ativa) return false;
    return s.idade >= SEM_NOVIDADE_MS || (s.idade >= NOVIDADE_MS && temNovidade(c)) || (s.idade >= 20 * HORA_MS && produtosNovos(c));
}

module.exports = {
    analisarLoja, iniciarAnalise, continuarAnalise, precisaAnalisarAgora, entraNoLote, gerarMaisIdeias, ErroIdeias, VERSAO,
    conversa: { textoDaLoja, espera, FORMATOS_TEXTO: function () { return Object.keys(ESPECIALISTAS).map(function (f) { return ESPECIALISTAS[f].texto; }).join("\n\n"); }, carregar, preparar, perguntar, contextoDasIdeias, regrasDasIdeias, textoMemoria, textoGosto, comSugeridas, mapaDeCodigos, titulosAnteriores, corta, objeto, textoPT, listaPT, ESQ_ESPECIALISTA, ESPECIALISTAS, METODOS_RESUMO, MODELO },
    _teste: { pedidoMemoria, memoriaNova },
    _interno: { vozEGanchos, primeiraFrase, postsDaLoja, linhaPost, anunciosDaLoja, linhaAnuncio, datasDoVarejo, montarIdeias, candidatas, ESQ_DIRETOR, ESQ_ESPECIALISTA, ESQ_CURADOR, SISTEMA_TIME }
};
