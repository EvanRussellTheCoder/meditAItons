export interface MeditationsQueryCase {
  readonly id: string;
  readonly text: string;
}

export const MEDITATIONS_QUERY_SUITE: readonly MeditationsQueryCase[] = Object.freeze([
  { id: 'hunger', text: "I'm hungry." },
  { id: 'fight', text: 'I want to fight someone.' },
  { id: 'happy', text: "I'm happy." },
  { id: 'anger', text: "I'm angry at a coworker." },
  { id: 'anxiety', text: "I'm anxious about tomorrow." },
  { id: 'loneliness', text: 'I feel lonely.' },
  { id: 'mistake', text: "I can't stop thinking about a mistake." },
  { id: 'admiration', text: 'I want people to admire me.' },
  { id: 'death', text: "I'm afraid of dying." },
  { id: 'motivation', text: "I don't want to get out of bed." },
  { id: 'insult', text: 'Someone insulted me.' },
  { id: 'jealousy', text: "I'm jealous of my friend." },
  { id: 'overwork', text: 'I have too much work.' },
  { id: 'control', text: "I can't control what happens." },
  { id: 'gratitude', text: 'I feel ungrateful.' },
  { id: 'decision', text: 'I need to make a difficult decision.' },
  { id: 'procrastination', text: 'I keep procrastinating.' },
  { id: 'grief', text: 'I lost someone I love.' },
  { id: 'success', text: 'Everything is going well.' },
  { id: 'revenge', text: 'I want revenge.' },
]);
