// ============================================================
// REVIVE CAFE JOBS - CV Analysis Function
// Netlify Function: /netlify/functions/analyze-cv
// Uses Claude API to analyse CV text
// ============================================================

const CLAUDE_API_KEY = process.env.CLAUDE_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { cvText, coverLetterText, jobTitle, jobDescription } = data;

  if (!cvText || !jobTitle) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'cvText and jobTitle are required' }) };
  }

  try {
    const analysis = await analyseCv({ cvText, coverLetterText, jobTitle, jobDescription });
    return { statusCode: 200, headers, body: JSON.stringify(analysis) };
  } catch (err) {
    console.error('CV analysis error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

async function analyseCv({ cvText, coverLetterText, jobTitle, jobDescription }) {
  const prompt = `You are an expert recruitment analyst for Revive Cafe, a healthy vegan cafe and food brand in Auckland, New Zealand.

ROLE BEING APPLIED FOR: ${jobTitle}
${jobDescription ? `JOB DESCRIPTION:\n${jobDescription.substring(0, 800)}\n` : ''}

CV / RESUME TEXT:
${cvText.substring(0, 3000)}

${coverLetterText ? `COVER LETTER:\n${coverLetterText.substring(0, 1500)}\n` : ''}

Please analyse this application and provide a JSON response with EXACTLY this structure (no extra text, just valid JSON):

{
  "suitability_score": <integer 1-10>,
  "ai_score": <integer 1-10>,
  "previous_employers": "<comma-separated list of previous employers extracted from CV>",
  "suitability_notes": "<2-3 sentences on why this score was given for suitability>",
  "ai_notes": "<1-2 sentences explaining the AI/human assessment>"
}

SCORING GUIDELINES:

suitability_score (1-10): How well does this candidate's background match the role?
- 9-10: Exceptional match — directly relevant experience, skills, and background
- 7-8: Good match — relevant experience with minor gaps
- 5-6: Moderate match — some relevant experience but notable gaps
- 3-4: Weak match — limited relevant experience
- 1-2: Poor match — little to no relevant experience

ai_score (1-10): How genuine/human-written does the application appear? (higher = more human)
- 9-10: Clearly written by a real person — personal, specific, natural voice, typos, informal phrasing
- 7-8: Mostly human — personal touches but some polish
- 5-6: Mixed — could be lightly AI-assisted
- 3-4: Likely AI-generated — generic, formal, overly structured
- 1-2: Almost certainly AI-generated — template language, buzzword-heavy, impersonal

previous_employers: Extract company names and roles from the CV. Format as "Company Name (Role), Company Name (Role)"
If no employers found, return "No previous employers listed"

Return ONLY valid JSON, no markdown, no explanation.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} — ${err}`);
  }

  const result = await response.json();
  const text = result.content[0].text.trim();

  // Extract JSON from response (handles cases where Claude adds extra text)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse JSON from Claude response');
  }

  const analysis = JSON.parse(jsonMatch[0]);

  // Validate and clamp scores
  return {
    suitability_score: Math.min(10, Math.max(1, parseInt(analysis.suitability_score) || 5)),
    ai_score: Math.min(10, Math.max(1, parseInt(analysis.ai_score) || 5)),
    previous_employers: analysis.previous_employers || 'No previous employers listed',
    suitability_notes: analysis.suitability_notes || '',
    ai_notes: analysis.ai_notes || ''
  };
}
