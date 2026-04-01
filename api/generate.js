export default async function handler(req, res) {
  // Log inicial para confirmar que a função é invocada
  console.log("[generate] Iniciando handler, method:", req.method);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log("[generate] API key presente:", !!apiKey);

  if (!apiKey) {
    return res.status(500).json({ error: "Sem chave API" });
  }

  const messages = req.body?.messages;
  console.log("[generate] Messages recebidas:", !!messages, Array.isArray(messages) ? messages.length : "não é array");

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Messages obrigatorio e deve ser array" });
  }

  try {
    console.log("[generate] Chamando Anthropic API...");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        messages: messages,
      }),
    });

    console.log("[generate] Status Anthropic:", response.status);

    const data = await response.json();

    if (!response.ok) {
      console.error("[generate] Erro Anthropic:", JSON.stringify(data));
      return res.status(response.status).json({ 
        error: "Erro da API Anthropic", 
        details: data 
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error("[generate] EXCEPTION:", err.message, err.stack);
    return res.status(500).json({ 
      error: "Exceção interna", 
      message: err.message 
    });
  }
}
