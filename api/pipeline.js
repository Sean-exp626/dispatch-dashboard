const Anthropic = require('@anthropic-ai/sdk');

const S1_SYSTEM = `You are a Token-Efficiency Parser. Convert the user's raw query into a compact JSON object that strips all conversational filler.

Output ONLY valid JSON (no markdown fences):
{
  "intent": "<one-line action verb phrase>",
  "domain": "<technical domain>",
  "constraints": ["<hard requirement>"],
  "inputs": { "<var>": "<value or ?>" },
  "outputs": ["<expected deliverable>"],
  "edge_cases": ["<risk or ambiguity>"],
  "context_tokens_saved": 0
}`;

const S2_SYSTEM = `You are a Logic Architect. Receive a JSON task spec and design a complete solution plan.

Output ONLY valid JSON (no markdown fences):
{
  "architecture": "<1-2 sentence summary>",
  "execution_steps": [{ "step": 1, "action": "<what>", "why": "<why>" }],
  "edge_case_mitigations": [{ "risk": "<risk>", "mitigation": "<how>" }],
  "pseudocode": "<pseudocode>",
  "priority_order": ["<first>"],
  "estimated_complexity": "medium"
}`;

const S3_SYSTEM = `You are a High-Fidelity Execution Agent. Receive a technical roadmap and produce the final solution.

Output ONLY valid JSON (no markdown fences):
{
  "solution": "<complete solution>",
  "notes": ["<caveat>"],
  "confidence": "high",
  "follow_up_suggestions": ["<next step>"]
}`;

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, apiKey } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ error: 'apiKey is required' });

  const client = new Anthropic({ apiKey: key });
  const pipelineStart = Date.now();

  try {
    const s1Start = Date.now();
    const s1Res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 512,
      system: S1_SYSTEM, messages: [{ role: 'user', content: query }],
    });
    const s1Ms = Date.now() - s1Start;
    const s1Out = parseJson(s1Res.content[0].text);

    const s2Start = Date.now();
    const s2Res = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      system: S2_SYSTEM,
      messages: [{ role: 'user', content: `Task specification:\n${JSON.stringify(s1Out, null, 2)}` }],
    });
    const s2Ms = Date.now() - s2Start;
    const s2Out = parseJson(s2Res.content[0].text);

    const s3Start = Date.now();
    const s3Res = await client.messages.create({
      model: 'claude-opus-4-6', max_tokens: 4096,
      system: S3_SYSTEM,
      messages: [{ role: 'user', content: `Original request: ${query}\n\nTechnical roadmap:\n${JSON.stringify(s2Out, null, 2)}` }],
    });
    const s3Ms = Date.now() - s3Start;
    let s3Out;
    try   { s3Out = parseJson(s3Res.content[0].text); }
    catch { s3Out = { solution: s3Res.content[0].text, notes: [], confidence: 'high', follow_up_suggestions: [] }; }

    const totalMs  = Date.now() - pipelineStart;
    const totalIn  = (s1Res.usage?.input_tokens||0) + (s2Res.usage?.input_tokens||0) + (s3Res.usage?.input_tokens||0);
    const totalOut = (s1Res.usage?.output_tokens||0) + (s2Res.usage?.output_tokens||0) + (s3Res.usage?.output_tokens||0);
    const reduction = (((query.length - JSON.stringify(s1Out).length) / query.length) * 100).toFixed(1);

    res.json({
      query, tokenReductionRate: `${reduction}%`,
      totalLatencyMs: totalMs, totalInputTokens: totalIn, totalOutputTokens: totalOut,
      stages: {
        parser:    { metrics: { latencyMs: s1Ms, inputTokens: s1Res.usage?.input_tokens, outputTokens: s1Res.usage?.output_tokens }, output: s1Out },
        architect: { metrics: { latencyMs: s2Ms, inputTokens: s2Res.usage?.input_tokens, outputTokens: s2Res.usage?.output_tokens }, output: s2Out },
        execution: { metrics: { latencyMs: s3Ms, inputTokens: s3Res.usage?.input_tokens, outputTokens: s3Res.usage?.output_tokens }, output: s3Out },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
