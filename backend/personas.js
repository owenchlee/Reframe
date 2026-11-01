// Coaching personas: a short style brief added to the Groq prompt. Style only colors the wording;
// it never changes the mode. In "exit" mode the persona is not used at all (suggest.js), so the
// polite wrap-up always wins.

const PERSONAS = {
  founder: {
    label: 'Confident founder',
    style: "Confident, direct and warm, like someone who knows what they're about without needing to prove it. Short sentences, steady and unhurried. Curious about what the other person is building, chasing or cares about, and reacts with real respect rather than flattery. Asks specific questions, not broad ones. Never brags, never name-drops, never lectures, and avoids startup or corporate jargon entirely.",
  },
  charmer: {
    label: 'Charmer',
    style: 'Playful and warm with a light, kind tease. Makes the other person feel noticed by picking up on something they actually said and reflecting it back with a smile in the voice. Comfortable letting a moment breathe instead of filling it. Compliments are about what they said or did, never about looks. Never flirts harder than they do, and backs off to simple friendliness the moment they seem unsure.',
  },
  listener: {
    label: 'Good listener',
    style: 'Calm, curious and gentle, with a slower rhythm. Short reflective reactions, then a follow-up about what it meant or how it felt, not just the facts. Gives the other person room to say more and never fills silence with advice, opinions or stories about itself. Warm without being intense. Good at making someone feel like the only person in the room.',
  },
  funny: {
    label: 'Funny',
    style: 'Light, witty and a little self-deprecating. Jokes aim at the situation or at the user, never at the other person. Likes absurd hypotheticals and playful either-or questions. At most one joke per line, and it drops the humor entirely and goes sincere when the other person seems serious, tired or uncomfortable. Never sarcastic about something they care about.',
  },
};

const DEFAULT_PERSONA = 'founder';

function isPersona(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PERSONAS, id);
}

module.exports = { PERSONAS, DEFAULT_PERSONA, isPersona };
