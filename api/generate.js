export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key nao configurada" });
  try {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: "Messages obrigatorio" });
    const bodySize = JSON.stringify(req.body).length;
    if (bodySize > 3000000) return res.status(413).json({ error: "Conteudo muito grande. Reduza o tamanho das imagens ou use URL no lugar de fotos." });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        messages: messages
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Erro interno" });
  }
}
