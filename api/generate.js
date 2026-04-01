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

    // Tentar reparar o JSON da resposta antes de retornar
    if (d.content && Array.isArray(d.content)) {
      d.content = d.content.map(function(block) {
        if (block.type === "text" && block.text) {
          // Substituir aspas tipograficas por aspas simples dentro de strings JSON
          block.text = block.text
            .replace(/\u201c/g, "'")  // aspas duplas esquerdas
            .replace(/\u201d/g, "'")  // aspas duplas direitas
            .replace(/\u2018/g, "'")  // aspas simples esquerdas
            .replace(/\u2019/g, "'"); // aspas simples direitas
        }
        return block;
      });
    }

    return res.status(r.ok ? 200 : r.status).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
