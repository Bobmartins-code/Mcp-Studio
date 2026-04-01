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

    // Sanitizar o texto da resposta para garantir JSON valido
    if (d.content && Array.isArray(d.content)) {
      d.content = d.content.map(function(block) {
        if (block.type === "text" && block.text) {
          var text = block.text;
          // Extrair apenas o JSON da resposta
          var start = text.indexOf("{");
          var end = text.lastIndexOf("}");
          if (start !== -1 && end !== -1) {
            text = text.substring(start, end + 1);
          }
          // Substituir aspas tipograficas
          text = text
            .replace(/\u201c/g, "\\\"")
            .replace(/\u201d/g, "\\\"")
            .replace(/\u2018/g, "'")
            .replace(/\u2019/g, "'");
          // Tentar parsear e re-serializar para garantir JSON valido
          try {
            var parsed = JSON.parse(text);
            block.text = JSON.stringify(parsed);
          } catch(e) {
            block.text = text;
          }
        }
        return block;
      });
    }

    return res.status(r.ok ? 200 : r.status).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
