// Phase 13 — input safety helpers.
//
// Two concerns:
//   1. sanitizeUserMessage — strip control characters and collapse exotic
//      whitespace before the message hits Groq. Cheap, no false positives.
//   2. isLikelyPromptInjection — pattern-match a few of the most common
//      obvious jailbreak openers. This is intentionally narrow; we err on
//      the side of false-negatives (let the system prompt absorb the rest)
//      rather than block legitimate user phrasing.

// Drop control characters except CR (\x0D), LF (\x0A), and TAB (\x09).
// Matches the C0 range (\x00-\x08, \x0B, \x0C, \x0E-\x1F), the DEL char
// (\x7F), and the C1 range (\x80-\x9F).
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function sanitizeUserMessage(text) {
  if (typeof text !== 'string') return '';
  // Drop control chars, collapse runs of horizontal whitespace, and clamp
  // long runs of newlines. maxLength enforcement happens at the caller.
  return text
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const INJECTION_PATTERNS = [
  /\bignore (?:the |all |any )?(?:previous|prior|preceding|above|earlier) (?:instructions?|prompts?|rules?|directives?)\b/i,
  /\bdisregard (?:the |all |any )?(?:previous|prior|preceding|above|earlier) (?:instructions?|prompts?|rules?|directives?)\b/i,
  /\bforget (?:the |all |any |everything )?(?:previous|prior|preceding|above|earlier)? ?(?:instructions?|prompts?|rules?|directives?|context)\b/i,
  /\b(?:reveal|print|show|expose|output|leak) (?:your |the )?(?:system|initial|original|hidden) (?:prompt|instructions?|message)\b/i,
  /\byou are (?:no longer|now) (?:a |an )?[^.,;\n]{0,40}\b(?:dan|developer mode|jailbroken|unrestricted)\b/i,
];

export function isLikelyPromptInjection(text) {
  if (typeof text !== 'string' || !text) return false;
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// Spoken aloud by the avatar when the guard trips. Plain conversational
// English; no system-prompt leakage.
export const INJECTION_DEFLECTION =
  "I'd rather not change my role. Is there something else I can help with?";

// Phase 13 — canned reply when the upstream LLM is unavailable. The plan
// calls for the avatar to still talk; we route this through the normal
// sentence/done pipeline so TTS + lipsync handle it the same as any reply.
export const LLM_DOWN_REPLY =
  "I'm having a bit of trouble thinking right now. Could you try again in a moment?";
