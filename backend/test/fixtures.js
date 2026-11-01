// Made-up conversations for the signal engine tests. No real people, no real transcripts.
//
// Input shape matches SignalEngine.addSegment(who, text, start, end): the engine derives
// word count, question flag, laughter and response delay itself, so each turn lists only
// { who, text, start, end } (times in seconds on the audio timeline).
// `derived` (optional) lists what the engine should compute for that turn, to check the derivation.
// `expect` is the engagement result after the last turn.

module.exports = [
  {
    name: 'engaged: long replies, asks back, laughs',
    turns: [
      { who: 'me', text: 'So how did you end up getting into rock climbing?', start: 0, end: 3 },
      {
        who: 'them',
        text: 'Honestly a friend dragged me to a gym two years ago and I got hooked. Do you climb at all?',
        start: 3.6, end: 9,
        derived: { words: 20, hasQuestion: true, laughed: false, responseDelayMs: 600 },
      },
      { who: 'me', text: 'Only once, and I mostly hung there like a sad koala.', start: 9.5, end: 12.5 },
      {
        who: 'them',
        text: '(laughter) That is exactly how everyone starts, you should come with us sometime.',
        start: 12.8, end: 16.5,
        derived: { words: 12, hasQuestion: false, laughed: true, responseDelayMs: 300 },
      },
    ],
    // me 10 + 11 = 21 words, them 20 + 12 = 32 words -> 21 / 53
    expect: { state: 'engaged', talkRatio: 0.4, mode: 'reply', reasons: ['long replies', 'laughed'] },
  },
  {
    name: 'neutral: medium replies, no questions, no laughs',
    turns: [
      { who: 'me', text: 'Have you been to this coffee place before today?', start: 0, end: 2.5 },
      {
        who: 'them',
        text: 'Yeah, a few times, the cold brew is good.',
        start: 3.2, end: 5.5,
        derived: { words: 9, hasQuestion: false, laughed: false, responseDelayMs: 700 },
      },
      { who: 'me', text: 'Nice, I usually just get a flat white here.', start: 6, end: 8.5 },
      {
        who: 'them',
        text: 'That is fine too, it depends on the day.',
        start: 9.2, end: 11.5,
        derived: { words: 9, hasQuestion: false, laughed: false, responseDelayMs: 700 },
      },
    ],
    // me 9 + 9 = 18, them 9 + 9 = 18 -> 0.5
    expect: { state: 'neutral', talkRatio: 0.5, mode: 'reply', reasons: [] },
  },
  {
    name: 'cold: short replies, no questions back, slow responses',
    turns: [
      { who: 'me', text: 'What kind of music have you been listening to lately?', start: 0, end: 3 },
      {
        who: 'them',
        text: 'Not much really.',
        start: 5.8, end: 6.6,
        derived: { words: 3, hasQuestion: false, laughed: false, responseDelayMs: 2800 },
      },
      { who: 'me', text: 'Oh cool, I have been really into old jazz records lately.', start: 7, end: 10 },
      {
        who: 'them',
        text: 'Okay.',
        start: 12.6, end: 13,
        derived: { words: 1, hasQuestion: false, laughed: false, responseDelayMs: 2600 },
      },
    ],
    // me 10 + 11 = 21, them 3 + 1 = 4 -> 21 / 25
    expect: {
      state: 'cold', talkRatio: 0.84, mode: 'exit',
      reasons: ['2 short replies in a row', 'no questions back', 'slow responses'],
    },
  },
  {
    name: 'edge: only one turn so far (them)',
    turns: [
      {
        who: 'them',
        text: 'Hey, nice to meet you.',
        start: 0, end: 1.5,
        derived: { words: 5, hasQuestion: false, laughed: false, responseDelayMs: null },
      },
    ],
    expect: { state: 'neutral', talkRatio: 0, mode: 'reply', reasons: [] },
  },
  {
    name: 'edge: user talks over 70% of the words',
    turns: [
      {
        who: 'me',
        text: 'I just got back from Lisbon and it was amazing, the trams, the food, the views from every hill, I could talk about it forever honestly.',
        start: 0, end: 8,
      },
      {
        who: 'them',
        text: 'That sounds like a fun trip.',
        start: 8.5, end: 10,
        derived: { words: 6, hasQuestion: false, laughed: false, responseDelayMs: 500 },
      },
    ],
    // me 26, them 6 -> 26 / 32
    expect: { state: 'neutral', talkRatio: 0.81, mode: 'ask', reasons: [] },
  },

  // ---- Threshold review cases (fixed after review: fast brush-offs go cold, long-answer masking) ----
  {
    name: 'review: three fast short replies go cold',
    turns: [
      { who: 'me', text: 'Did you catch the game last night at all?', start: 0, end: 2.5 },
      { who: 'them', text: 'Nope.', start: 2.9, end: 3.2, derived: { words: 1, responseDelayMs: 400 } },
      { who: 'me', text: 'Ah, fair. Are you more into movies then?', start: 3.6, end: 6 },
      { who: 'them', text: 'Not really.', start: 6.4, end: 7, derived: { words: 2, responseDelayMs: 400 } },
      { who: 'me', text: 'Gotcha. Anything fun planned for the weekend?', start: 7.4, end: 9.5 },
      { who: 'them', text: 'Not sure.', start: 9.9, end: 10.4, derived: { words: 2, responseDelayMs: 400 } },
    ],
    // me 9 + 8 + 7 = 24, them 1 + 2 + 2 = 5 -> 24 / 29. Fast replies, so the slow rule doesn't
    // apply, but 3 short replies with no questions back is cold on its own.
    expect: {
      state: 'cold', talkRatio: 0.83, mode: 'exit',
      reasons: ['3 short replies in a row', 'no questions back'],
    },
  },
  {
    name: 'review: long early answer, then slow short replies (goes cold, works)',
    turns: [
      { who: 'me', text: 'How was the trip?', start: 0, end: 1.5 },
      {
        who: 'them',
        text: 'It was a long trip with a lot of driving and the hotel was fine but the weather was bad most days so we stayed in.',
        start: 2, end: 9,
        derived: { words: 26 },
      },
      { who: 'me', text: 'Oh no. What did you end up doing inside?', start: 9.5, end: 11.5 },
      { who: 'them', text: 'Not much.', start: 14, end: 14.5, derived: { words: 2, responseDelayMs: 2500 } },
      { who: 'me', text: 'Fair enough. Any trips planned next?', start: 15, end: 17 },
      { who: 'them', text: 'No.', start: 19.5, end: 19.8, derived: { words: 1, responseDelayMs: 2500 } },
    ],
    // Fine: the cold rule is checked first (2 short, no questions, slow).
    // me 4 + 9 + 6 = 19, them 26 + 2 + 1 = 29 -> 19 / 48
    expect: {
      state: 'cold', talkRatio: 0.4, mode: 'exit',
      reasons: ['2 short replies in a row', 'no questions back', 'slow responses'],
    },
  },
  {
    name: 'review: one long early answer no longer masks fast short replies',
    turns: [
      { who: 'me', text: 'How was the trip?', start: 0, end: 1.5 },
      {
        who: 'them',
        text: 'It was a long trip with a lot of driving and the hotel was fine but the weather was bad most days so we stayed in the whole week honestly.',
        start: 2, end: 9,
        derived: { words: 30 },
      },
      { who: 'me', text: 'Oh no. What did you end up doing inside?', start: 9.5, end: 11.5 },
      { who: 'them', text: 'Not much.', start: 12, end: 12.5 },
      { who: 'me', text: 'Fair enough. Any trips planned next?', start: 13, end: 15 },
      { who: 'them', text: 'No.', start: 15.4, end: 15.7 },
    ],
    // Same shape, fast replies. avg of last 3 = (30 + 2 + 1) / 3 = 11 >= 10, but the latest reply
    // is 1 word, so "long replies" no longer applies. Only 2 short replies (fast), so not cold yet.
    // me 4 + 9 + 6 = 19, them 30 + 2 + 1 = 33 -> 19 / 52
    expect: { state: 'neutral', talkRatio: 0.37, mode: 'reply', reasons: ['short reply'] },
  },
  {
    name: 'question detection: "Was fine." is not a question, so it can still go cold',
    turns: [
      { who: 'me', text: 'How was your weekend, anything fun going on?', start: 0, end: 2.5 },
      { who: 'them', text: 'Was fine.', start: 5, end: 5.6, derived: { words: 2, hasQuestion: false, responseDelayMs: 2500 } },
      { who: 'me', text: 'Nice, I went to a food market downtown.', start: 6, end: 8.5 },
      { who: 'them', text: 'Did okay.', start: 11, end: 11.6, derived: { words: 2, hasQuestion: false, responseDelayMs: 2500 } },
    ],
    // me 8 + 8 = 16, them 2 + 2 = 4 -> 16 / 20
    expect: {
      state: 'cold', talkRatio: 0.8, mode: 'exit',
      reasons: ['2 short replies in a row', 'no questions back', 'slow responses'],
    },
  },
];

// Direct checks for hasQuestion(): text -> expected.
module.exports.questionCases = [
  ['Was fine.', false],
  ['Did okay.', false],
  ['Have fun.', false],
  ['Is what it is.', false],
  ['Cool, how about you?', true],
  ['That is great. Where was it?', true],
  ['how was your day', true], // no punctuation: first-word fallback
  ['sounds good', false],
];
