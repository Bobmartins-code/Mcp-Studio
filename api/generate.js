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

    if (d.content && Array.isArray(d.content)) {
      d.content = d.content.map(function(block) {
        if (block.type === "text" && block.text) {
          var text = block.text;

          // Extrair apenas o bloco JSON
          var start = text.indexOf("{");
          var end = text.lastIndexOf("}");
          if (start !== -1 && end !== -1) {
            text = text.substring(start, end + 1);
          }

          // Sanitizar caracteres problematicos dentro de valores de string JSON
          // Substituir aspas duplas dentro de strings por aspas simples
          // Estrategia: percorrer caracter a caracter
          var result = "";
          var inString = false;
          var escape = false;
          for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (escape) {
              result += c;
              escape = false;
              continue;
            }
            if (c === "\\") {
              escape = true;
              result += c;
              continue;
            }
            if (c === '"') {
              if (!inString) {
                inString = true;
                result += c;
              } else {
                // Verificar se esta aspa fecha a string ou e uma aspa dentro
                // Olhar o proximo caracter nao-espaco
                var next = "";
                for (var j = i + 1; j < text.length; j++) {
                  if (text[j] !== " " && text[j] !== "\n" && text[j] !== "\r" && text[j] !== "\t") {
                    next = text[j];
                    break;
                  }
                }
                // Se o proximo char relevante e : , } ] entao esta aspa fecha a string
                if (next === ":" || next === "," || next === "}" || next === "]" || next === "") {
                  inString = false;
                  result += c;
                } else {
                  // Aspa dentro de string - substituir por aspas simples
                  result += "'";
                }
              }
            } else if (c === "\n" || c === "\r") {
              // Quebras de linha dentro de strings viram espaco
              if (inString) {
                result += " ";
              } else {
                result += c;
              }
            } else {
              result += c;
            }
          }

          block.text = result;
        }
        return block;
      });
    }

    return res.status(r.ok ? 200 : r.status).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
