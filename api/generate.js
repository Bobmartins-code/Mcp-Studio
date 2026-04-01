module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Sem chave API" });
  const messages = req.body && req.body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Messages obrigatorio" });
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: messages
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);

    // Processar e sanitizar a resposta
    if (d.content && Array.isArray(d.content)) {
      d.content = d.content.map(function(block) {
        if (block.type !== "text" || !block.text) return block;

        var text = block.text;

        // Extrair JSON do texto
        var start = text.indexOf("{");
        var end = text.lastIndexOf("}");
        if (start === -1 || end === -1) return block;
        text = text.substring(start, end + 1);

        // Sanitizar caracter a caracter
        var out = "";
        var inStr = false;
        var esc = false;
        for (var i = 0; i < text.length; i++) {
          var ch = text[i];
          if (esc) { out += ch; esc = false; continue; }
          if (ch === "\\") { esc = true; out += ch; continue; }
          if (ch === '"') {
            if (!inStr) { inStr = true; out += ch; continue; }
            var nx = "";
            for (var j = i + 1; j < text.length; j++) {
              if (!" \t\n\r".includes(text[j])) { nx = text[j]; break; }
            }
            if (":,}]".includes(nx) || nx === "") { inStr = false; out += ch; }
            else { out += "'"; }
            continue;
          }
          if (inStr && (ch === "\n" || ch === "\r")) { out += " "; continue; }
          out += ch;
        }

        // Fazer JSON.parse e JSON.stringify para garantir JSON valido
        try {
          var parsed = JSON.parse(out);
          block.text = JSON.stringify(parsed);
        } catch(e) {
          // Se ainda falhar, retornar texto sanitizado
          block.text = out;
        }
        return block;
      });
    }

    return res.status(200).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
