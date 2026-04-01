export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    return res.status(500).json({ error: "Sem chave API" });
  }

  const messages = req.body && req.body.messages;
  
  if (!messages) {
    return res.status(400).json({ error: "Messages obrigatorio" });
  }

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

  const data = await response.json();
  return res.status(200).json(data);
}
```

Commit e acessa de novo:
```
https://mcp-studio-zeta.vercel.app/api/generate
