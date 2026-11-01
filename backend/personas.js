// Coaching personas: a short style brief added to the Groq prompt. Style only colors the wording;
// it never changes the mode. In "exit" mode the persona is not used at all (suggest.js), so the
// polite wrap-up always wins.

const PERSONAS = {
  founder: {
    label: 'Confident founder',
    style: 'Confident, direct and warm. Short declarative phrasing, genuine interest, no hedging.',
  },
  charmer: {
    label: 'Charmer',
    style: 'Playful and warm, a light compliment or tease at most. Never pushy, never flirty-aggressive.',
  },
  listener: {
    label: 'Good listener',
    style: 'Calm and curious. Prefer a thoughtful follow-up question about a specific detail they mentioned.',
  },
  funny: {
    label: 'Funny',
    style: 'Light, witty and self-aware. A small joke or playful observation, never at their expense.',
  },
};

const DEFAULT_PERSONA = 'founder';

function isPersona(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PERSONAS, id);
}

module.exports = { PERSONAS, DEFAULT_PERSONA, isPersona };
