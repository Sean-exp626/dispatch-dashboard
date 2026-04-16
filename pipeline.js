/**
 * Team Coconut — 3-Stage Multi-Agent Pipeline
 *
 * Stage 1 (Haiku):   Token-Efficiency Parser    → structured JSON
 * Stage 2 (Sonnet):  Logic Architect            → technical roadmap + pseudocode
 * Stage 3 (Opus):    High-Fidelity Execution    → production-ready solution
 */

const Anthropic = require('@anthropic-ai/sdk');

// ─── Stage system prompts ────────────────────────────────────────────────────

const STAGE1_SYSTEM = `You are a Token-Efficiency Parser. Your only job is to convert a raw user query into a compact, machine-readable JSON object that strips all conversational filler and captures only what downstream models need.

Output ONLY valid JSON with this shape (no markdown fences, no prose):
{
  "intent": "<one-line action verb phrase>",
  "domain": "<technical domain, e.g. 'API design', 'data pipeline', 'UI component'>",
  "constraints": ["<hard requirement 1>", "..."],
  "inputs": { "<var>": "<value or ?>" },
  "outputs": ["<expected deliverable>"],
  "edge_cases": ["<risk or ambiguity>"],
  "context_tokens_saved": <integer estimate of tokens stripped>
}

Be ruthlessly concise. Every key must have a value; use "?" if unknown.`;

const STAGE2_SYSTEM = `You are a Logic Architect. You receive a structured JSON task spec from a parser model and must design a complete technical solution plan.

Output a JSON object only (no markdown fences, no prose) with this shape:
{
  "architecture": "<1–2 sentence system design summary>",
  "execution_steps": [
    { "step": 1, "action": "<what to do>", "why": "<rationale>" }
  ],
  "edge_case_mitigations": [
    { "risk": "<edge case>", "mitigation": "<how to handle it>" }
  ],
  "pseudocode": "<concise pseudocode as a single string with \\n line breaks>",
  "priority_order": ["<step or concern ranked first>", "..."],
  "estimated_complexity": "<low | medium | high>"
}`;

const STAGE3_SYSTEM = `You are a High-Fidelity Execution Agent. You receive a technical roadmap and pseudocode blueprint and must produce a final, production-ready solution.

Focus 100% on execution quality. Deliver:
- Working, complete code (if code is required)
- Clear, precise answers (if explanation is required)
- Actionable output the user can use immediately

Format your response as JSON only (no markdown fences):
{
  "solution": "<full solution text — code, explanation, or both>",
  "notes": ["<important caveat or assumption>"],
  "confidence": "<high | medium | low>",
  "follow_up_suggestions": ["<optional next step>"]
}`;

// ─── Metrics helper ──────────────────────────────────────────────────────────

function stageMetrics(label, startMs, response) {
  const latencyMs = Date.now() - startMs;
  const usage = response.usage || {};
  return {
    stage: label,
    latencyMs,
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function parseJsonResponse(text) {
  // Strip markdown fences if the model added them anyway
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

async function runPipeline(apiKey, userQuery) {
  const client = new Anthropic({ apiKey });
  const pipeline_start = Date.now();

  // ── Stage 1: Token-Efficiency Parser (Haiku) ─────────────────────────────
  const s1Start = Date.now();
  const s1Response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: STAGE1_SYSTEM,
    messages: [{ role: 'user', content: userQuery }],
  });
  const s1Metrics = stageMetrics('Stage 1 — Parser (Haiku)', s1Start, s1Response);
  const s1Raw = s1Response.content[0].text;
  let s1Output;
  try {
    s1Output = parseJsonResponse(s1Raw);
  } catch {
    throw new Error(`Stage 1 returned non-JSON: ${s1Raw.substring(0, 200)}`);
  }

  // Token reduction rate: compare original query char count to Stage 1 output char count
  const originalChars = userQuery.length;
  const s1Chars = s1Raw.length;
  const tokenReductionRate = (((originalChars - s1Chars) / originalChars) * 100).toFixed(1);

  // ── Stage 2: Logic Architect (Sonnet) ────────────────────────────────────
  const s2Start = Date.now();
  const s2Response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: STAGE2_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Task specification from parser:\n${JSON.stringify(s1Output, null, 2)}`,
      },
    ],
  });
  const s2Metrics = stageMetrics('Stage 2 — Architect (Sonnet)', s2Start, s2Response);
  const s2Raw = s2Response.content[0].text;
  let s2Output;
  try {
    s2Output = parseJsonResponse(s2Raw);
  } catch {
    throw new Error(`Stage 2 returned non-JSON: ${s2Raw.substring(0, 200)}`);
  }

  // ── Stage 3: High-Fidelity Execution (Opus) ──────────────────────────────
  const s3Start = Date.now();
  const s3Response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: STAGE3_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Original request: ${userQuery}\n\nTechnical roadmap:\n${JSON.stringify(s2Output, null, 2)}`,
      },
    ],
  });
  const s3Metrics = stageMetrics('Stage 3 — Execution (Opus)', s3Start, s3Response);
  const s3Raw = s3Response.content[0].text;
  let s3Output;
  try {
    s3Output = parseJsonResponse(s3Raw);
  } catch {
    // If Opus breaks format, return as plain text rather than crashing
    s3Output = { solution: s3Raw, notes: ['Response was not JSON-formatted'], confidence: 'high', follow_up_suggestions: [] };
  }

  // ── Aggregate results ────────────────────────────────────────────────────
  const totalLatencyMs = Date.now() - pipeline_start;
  const totalInputTokens = [s1Metrics, s2Metrics, s3Metrics].reduce((a, m) => a + (m.inputTokens || 0), 0);
  const totalOutputTokens = [s1Metrics, s2Metrics, s3Metrics].reduce((a, m) => a + (m.outputTokens || 0), 0);

  return {
    query: userQuery,
    tokenReductionRate: `${tokenReductionRate}%`,
    totalLatencyMs,
    totalInputTokens,
    totalOutputTokens,
    stages: {
      parser:    { metrics: s1Metrics, output: s1Output },
      architect: { metrics: s2Metrics, output: s2Output },
      execution: { metrics: s3Metrics, output: s3Output },
    },
  };
}

module.exports = { runPipeline };
