// Vercel serverless function — DeepSeek V4-Pro con prompt caching automático.
// El compendio + system + schemas van PRIMERO para que DeepSeek aproveche el cache
// por prefijo. Los datos del cliente van al final, en el mensaje user.

const SYSTEM_PROMPT = `Eres el motor VDSEN de generación de planes de coaching de culturismo científico.

Aplicas estrictamente la metodología VDSEN basada en el compendio adjunto:
- Volumen por grupo muscular según MEV/MRV (19 grupos).
- Progresión RIR por semana del mesociclo (S1: RIR 3, S2: RIR 2, S3: RIR 2, S4: RIR 1, S5: RIR 1, S6: deload RIR 4).
- Selección de ejercicios por motorPattern, resistanceCurve, fatigueCost y muscleType del catálogo del coach.
- Para nutrición: TMB Mifflin-St Jeor + factor de actividad + objetivo (déficit/superávit/recomp).
- Macros: proteína 2.0-2.4 g/kg, grasas 0.8-1.0 g/kg, resto carbohidratos.

REGLAS DE SALIDA:
- Responde SIEMPRE con UN solo objeto JSON válido. Sin markdown, sin texto extra, sin backticks.
- Solo incluye las claves solicitadas en "generate" del usuario.
- Usa exactamente los nombres de ejercicios del CATÁLOGO proporcionado.`;

const SCHEMA = `{
  "plan": {
    "weeks": number,                     // ej: 6
    "daysPerWeek": number,               // 3-6
    "days": [{
      "dayIndex": number,                // 0-based
      "label": string,                   // ej: "Día 1 - Empuje Horizontal"
      "exercises": [{
        "exerciseName": string,          // EXACTO del catálogo
        "alternatives": [string],        // 1-2 alternativas del catálogo
        "sets": [{
          "setIndex": number,            // 0-based
          "repsTarget": number,          // 5-15
          "rirTarget": number,           // 1-4
          "load": 0,                     // siempre 0 — el cliente registra
          "restSeconds": number          // 60-180
        }]
      }]
    }]
  },
  "nutrition": {
    "calorias": number,                  // kcal totales
    "proteina": number,                  // g
    "carbos": number,                    // g
    "grasas": number,                    // g
    "texto": string                      // distribución de comidas (Comida 1: ... \\n Comida 2: ...)
  },
  "supplements": {
    "texto": string                      // protocolo de suplementación según objetivo y compendio
  }
}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY no configurada en Vercel' });
  }

  const {
    compendio = '',
    catalogo = [],
    cliente = {},
    parametros = {},
    generate = ['plan'],
    model = 'deepseek-chat'
  } = req.body || {};

  const generateSet = new Set(generate);
  const wants = {
    plan: generateSet.has('plan'),
    nutrition: generateSet.has('nutrition'),
    supplements: generateSet.has('supplements')
  };
  if (!wants.plan && !wants.nutrition && !wants.supplements) {
    return res.status(400).json({ error: 'Selecciona al menos uno: plan, nutrition, supplements' });
  }

  // ORDEN CRÍTICO PARA CACHE: contenido estable primero, variable al final.
  const systemBlock =
    SYSTEM_PROMPT +
    '\n\n=== SCHEMA DE SALIDA ===\n' + SCHEMA +
    '\n\n=== COMPENDIO VDSEN ===\n' + (compendio || '(vacío — usa conocimiento general de hipertrofia)') +
    '\n\n=== CATÁLOGO DE EJERCICIOS DEL COACH ===\n' + JSON.stringify(catalogo);

  const userBlock = `Genera SOLO las siguientes claves: ${[...generateSet].join(', ')}.

CLIENTE:
${JSON.stringify(cliente, null, 2)}

PARÁMETROS:
${JSON.stringify(parametros, null, 2)}

Devuelve un único objeto JSON con esas claves. No incluyas claves no solicitadas.`;

  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model, // "deepseek-chat" → V4-Pro cuando esté GA. Override desde frontend si quieres flash.
        messages: [
          { role: 'system', content: systemBlock },
          { role: 'user', content: userBlock }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 16000
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || 'DeepSeek API error', raw: data });
    }

    let parsed;
    try {
      parsed = JSON.parse(data.choices[0].message.content);
    } catch (e) {
      return res.status(502).json({ error: 'DeepSeek devolvió JSON inválido', raw: data.choices[0].message.content });
    }

    res.status(200).json({
      result: parsed,
      usage: data.usage || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
