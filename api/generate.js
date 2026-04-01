export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{role: "user", content: "diga oi"}]
      })
    });
    const data = await response.json();
    return res.status(200).json({status: response.status, data: data});
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
```

Depois acessa no navegador:
```
https://mcp-studio-zeta.vercel.app/api/generate
