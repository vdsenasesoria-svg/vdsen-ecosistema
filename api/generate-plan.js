export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'] || '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!apiKey || !apiKey.startsWith('sk-')) {
    return res.status(400).json({ error: 'API key inválida o ausente' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    // ── Safe diagnostic logging (no keys / prompts / PII) ─────────────────
    const u = data.usage || {};
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const textLength = (choice && choice.message && choice.message.content) ? choice.message.content.length : 0;
    console.log('[generate-plan]', JSON.stringify({
      openai_status:   response.status,
      finish_reason:   choice ? choice.finish_reason : null,
      prompt_tokens:   u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      text_length:     textLength
    }));

    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
