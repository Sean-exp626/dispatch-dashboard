const Anthropic = require('@anthropic-ai/sdk');

const S1_SYSTEM = `You are a Token-Efficiency Parser. Convert the user query into compact JSON.

RULES:
- Output ONLY a single JSON object, no markdown fences, no prose before or after
- All string values must be properly escaped (no raw newlines, no unescaped quotes inside strings)
- Keep all string values short and on one line

Output shape:
{"intent":"<verb phrase>","domain":"<domain>","constraints":["<req>"],"inputs":{"key":"value"},"outputs":["<deliverable>"],"edge_cases":["<risk>"],"context_tokens_saved":0}`;

const S2_SYSTEM = `You are a Logic Architect. Design a solution plan from the JSON task spec.

RULES:
- Output ONLY a single JSON object, no markdown fences, no prose before or after
- All string values must be properly escaped — NO raw newlines inside strings, use \\n instead
- Keep string values concise

Output shape:
{"architecture":"<summary>","execution_steps":[{"step":1,"action":"<what>","why":"<why>"}],"edge_case_mitigations":[{"risk":"<risk>","mitigation":"<fix>"}],"pseudocode":"<use \\n for line breaks>","priority_order":["<first>"],"estimated_complexity":"medium"}`;

const S3_SYSTEM = `You are a High-Fidelity Execution Agent. Produce the final solution from the roadmap.

RULES:
- Output ONLY a single JSON object, no markdown fences, no prose before or after
- All string values must be properly escaped — NO raw newlines inside strings, use \\n instead
- The "solution" field must be written in formal, professional Korean
- Do NOT use any emoji, emoticons, or decorative symbols anywhere in the output
- Do NOT use markdown symbols such as *, **, #, -, > inside string values
- Use plain text with \\n line breaks only

Output shape:
{"solution":"<full solution with \\n line breaks>","notes":["<caveat>"],"confidence":"high","follow_up_suggestions":["<next step>"]}`;

function extractJson(text) {
  // Strip markdown fences
  let s = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  // Extract outermost { ... }
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    // Last-resort: replace literal newlines inside strings with \n
    const fixed = s.replace(/("(?:[^"\\]|\\.)*")|(\n)/g, (m, str, nl) => str ? str : '\\n');
    return JSON.parse(fixed);
  }
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { query, apiKey } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key)  return res.status(400).json({ error: 'apiKey is required' });

  // Switch to SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client = new Anthropic({ apiKey: key });
  const pipelineStart = Date.now();

  const stages = [
    { id: 1, label: 'Parser',    model: 'claude-haiku-4-5-20251001', system: S1_SYSTEM, maxTokens: 600,  userMsg: () => query },
    { id: 2, label: 'Architect', model: 'claude-sonnet-4-6',         system: S2_SYSTEM, maxTokens: 1200, userMsg: (prev) => `Task spec:\n${JSON.stringify(prev)}` },
    { id: 3, label: 'Execution', model: 'claude-opus-4-6',           system: S3_SYSTEM, maxTokens: 4096, userMsg: (prev, outputs) => `Original request: ${query}\n\nRoadmap:\n${JSON.stringify(outputs[1])}` },
  ];

  const outputs     = {};
  const stageTokens = {};

  try {
    for (const stage of stages) {
      sendEvent(res, 'stage_start', { stage: stage.id, label: stage.label, model: stage.model });

      const userMsg = stage.id === 1 ? stage.userMsg()
                    : stage.id === 2 ? stage.userMsg(outputs[1])
                    : stage.userMsg(null, outputs);

      const stageStart = Date.now();
      let fullText = '';
      let inputTokens = 0;
      let outputTokens = 0;

      const stream = await client.messages.stream({
        model: stage.model,
        max_tokens: stage.maxTokens,
        system: stage.system,
        messages: [{ role: 'user', content: userMsg }],
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const chunk = event.delta.text;
          fullText += chunk;
          sendEvent(res, 'token', { stage: stage.id, text: chunk });
        }
        if (event.type === 'message_start') {
          inputTokens = event.message?.usage?.input_tokens || 0;
        }
        if (event.type === 'message_delta') {
          outputTokens = event.usage?.output_tokens || 0;
        }
      }

      let parsed;
      try   { parsed = extractJson(fullText); }
      catch { parsed = { raw: fullText }; }

      outputs[stage.id] = parsed;
      const latencyMs = Date.now() - stageStart;

      sendEvent(res, 'stage_end', {
        stage: stage.id,
        metrics: { latencyMs, inputTokens, outputTokens },
        output: parsed,
      });

      // accumulate per-stage metrics for savings calc
      if (!stageTokens[stage.id]) stageTokens[stage.id] = {};
      stageTokens[stage.id] = { inputTokens, outputTokens };
    }

    const totalMs = Date.now() - pipelineStart;

    const reduction = (() => {
      try {
        const orig = query.length;
        const comp = JSON.stringify(outputs[1]).length;
        return (((orig - comp) / orig) * 100).toFixed(1);
      } catch { return '0.0'; }
    })();

    // ── Token savings analysis ──────────────────────────────────────────────
    // Pricing per 1M tokens (USD)
    const PRICE = {
      haiku:  { in: 0.80,  out: 4.00  },
      sonnet: { in: 3.00,  out: 15.00 },
      opus:   { in: 15.00, out: 75.00 },
    };

    const s1 = stageTokens[1] || { inputTokens: 0, outputTokens: 0 };
    const s2 = stageTokens[2] || { inputTokens: 0, outputTokens: 0 };
    const s3 = stageTokens[3] || { inputTokens: 0, outputTokens: 0 };

    // Actual pipeline cost (all 3 stages)
    const pipelineCost =
      (s1.inputTokens * PRICE.haiku.in  + s1.outputTokens * PRICE.haiku.out)  / 1e6 +
      (s2.inputTokens * PRICE.sonnet.in + s2.outputTokens * PRICE.sonnet.out) / 1e6 +
      (s3.inputTokens * PRICE.opus.in   + s3.outputTokens * PRICE.opus.out)   / 1e6;

    // Hypothetical: raw query sent directly to Opus
    // Input  = same raw token count as Stage 1 received (the uncompressed query)
    // Output = estimated 1.8x more (Opus would need to plan + execute without a roadmap)
    const directOpusInput  = s1.inputTokens;
    const directOpusOutput = Math.round(s3.outputTokens * 1.8);
    const directCost       = (directOpusInput * PRICE.opus.in + directOpusOutput * PRICE.opus.out) / 1e6;

    const savedCost        = directCost - pipelineCost;
    const savedOpusInput   = directOpusInput - s3.inputTokens;
    const savedOpusOutput  = directOpusOutput - s3.outputTokens;

    sendEvent(res, 'done', {
      totalLatencyMs: totalMs,
      tokenReductionRate: `${reduction}%`,
      savings: {
        directOpusInput,
        directOpusOutput,
        directCostUSD:   parseFloat(directCost.toFixed(6)),
        pipelineCostUSD: parseFloat(pipelineCost.toFixed(6)),
        savedCostUSD:    parseFloat(savedCost.toFixed(6)),
        savedOpusInput,
        savedOpusOutput,
        savedPct: directCost > 0 ? ((savedCost / directCost) * 100).toFixed(1) : '0.0',
      },
    });

  } catch (err) {
    sendEvent(res, 'error', { message: err.message });
  }

  res.end();
};
