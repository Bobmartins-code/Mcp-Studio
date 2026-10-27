// Texto que vai para a IA: emoji partido ao meio (metade de um par UTF-16) faz a Anthropic recusar o pedido
// inteiro ("no low surrogate in string"). Aconteceu na Lilu em 22/10/2026: uma legenda cortada no meio de um emoji.

// tira metades de emoji soltas (sem o par)
function semMeioEmoji(s) {
    return String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1");
}

// JSON do pedido com todo texto limpo
function jsonParaIA(obj) {
    return JSON.stringify(obj, function (k, v) { return typeof v === "string" ? semMeioEmoji(v) : v; });
}

module.exports = { semMeioEmoji, jsonParaIA };
