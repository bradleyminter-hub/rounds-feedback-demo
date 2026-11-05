// Netlify Function: sends one dictation to Claude and returns a structured feedback note.
// Settings needed in Netlify (Site configuration > Environment variables):
//   ANTHROPIC_API_KEY  your key from console.anthropic.com
//   DEMO_PASSCODE      any passcode you choose; the page asks for it once per device

const MODEL = "claude-haiku-5-5"; // fast and inexpensive; use "claude-sonnet-5-5" for higher quality

const PROMPT = `You clean up an attending physician's dictated feedback about a resident physician for the resident's training file.
Rules:
- Remove ALL patient-identifying information: patient names, initials, MRNs, room or bed numbers, dates of birth, exact dates of service, phone numbers, addresses, and any other HIPAA identifier. Replace with neutral wording such as "a patient with GI bleeding". Keep clinical context that is not identifying.
- Fix speech-recognition errors and medical terms. Keep the attending's meaning; do not invent praise, concerns, or facts.
- Refer to first-year residents as PGY-1, never "intern".
- Write in third person about the resident, concise and specific.
- Tag relevant ACGME competency domains using only: PC, MK, SBP, PBLI, PROF, ICS.
Reply with only JSON in this shape:
{"summary": "1-2 sentences", "strengths": ["..."], "improve": ["..."], "actions": ["..."], "tags": ["PC"], "phi_removed": ["kinds of identifiers removed, never the values themselves"]}
Use empty arrays where the dictation has nothing for a section.`;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const passcode = process.env.DEMO_PASSCODE;
  if (!passcode || req.headers.get("x-demo-passcode") !== passcode) {
    return json(401, { error: "Wrong or missing passcode." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: "The site is missing its API key. Add ANTHROPIC_API_KEY in Netlify and redeploy." });
  }

  let input;
  try { input = await req.json(); } catch { return json(400, { error: "Request body wasn't valid JSON." }); }
  const dictation = String(input.dictation || "").slice(0, 8000).trim();
  if (dictation.length < 8) return json(400, { error: "Dictate a little more before cleaning up." });

  const context = `Resident: ${input.resident}, ${input.program} PGY-${input.pgy}. Rotation: ${input.rotation}. Setting: ${input.setting}.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: PROMPT,
      messages: [{ role: "user", content: `${context}\n\nDictation:\n"""\n${dictation}\n"""` }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("Anthropic API error", res.status, detail);
    const msg = res.status === 401 ? "The API key was rejected. Check ANTHROPIC_API_KEY in Netlify."
      : res.status === 429 ? "Rate limit reached. Wait a minute and try again."
      : res.status === 400 && /credit/i.test(detail) ? "Your Anthropic account is out of credit. Add credit in the Anthropic Console."
      : "The AI service returned an error. Try again.";
    return json(502, { error: msg });
  }

  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  try {
    return json(200, JSON.parse(text.slice(start, end + 1)));
  } catch {
    return json(502, { error: "The AI reply couldn't be read. Try again." });
  }
};
