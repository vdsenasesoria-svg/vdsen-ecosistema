// Returns true when stop_reason is max_tokens AND there are no text blocks —
// i.e., adaptive thinking consumed the entire output budget.
function detectExhaustedByThinking(data) {
  if (data.stop_reason !== 'max_tokens') return false;
  const textBlocks = Array.isArray(data.content)
    ? data.content.filter(function(b) { return b.type === 'text'; })
    : [];
  return textBlocks.length === 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return res.status(400).json({ error: 'API key inválida o ausente' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    // ── Safe diagnostic logging (no keys / prompts / PII) ─────────────────
    const u = data.usage || {};
    const contentBlocks = Array.isArray(data.content) ? data.content : [];
    const textBlocks    = contentBlocks.filter(function(b) { return b.type === 'text'; });
    const textLength    = textBlocks.reduce(function(sum, b) { return sum + (b.text ? b.text.length : 0); }, 0);
    console.log('[generate-plan]', JSON.stringify({
      anthropic_status: response.status,
      stop_reason:      data.stop_reason,
      output_tokens:    u.output_tokens,
      thinking_tokens:  u.thinking_tokens,
      content_blocks:   contentBlocks.length,
      text_blocks:      textBlocks.length,
      text_length:      textLength
    }));

    // ── Detect thinking exhaustion before returning to frontend ───────────
    if (response.ok && detectExhaustedByThinking(data)) {
      return res.status(502).json({
        error:   'MODEL_OUTPUT_EXHAUSTED_BY_THINKING',
        message: 'El modelo agotó el presupuesto de salida durante thinking antes de producir texto.'
      });
    }

    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
