import {
  ClassifierReason,
  ConversationRoute,
  RouteRequest,
  RoutingDecision,
  RoutingReason,
  RoutingSource,
  SAFETY_KINDS,
  SafetyKind,
  ScopeClassification,
} from './types';

export const MAX_ROUTING_INPUT_CHARACTERS = 4_000;
export const MAX_ROUTING_HISTORY_MESSAGES = 6;

const IMMINENT_SELF_HARM = [
  /\b(?:i(?:'m| am)? going to|i(?:'ll| will)|i plan to) (?:kill|hurt) myself\b/u,
  /\b(?:kill myself|end my life|take my own life|die by suicide|commit suicide)\b/u,
  /\b(?:suicide|kill myself|end my life) (?:tonight|today|now)\b/u,
];

const AMBIGUOUS_SELF_HARM = [
  /\b(?:i(?:'m| am)? )?tired of life\b/u,
  /\b(?:i )?(?:want to|wanna|wish i could) disappear\b/u,
  /\b(?:i )?(?:do not|don't) want to (?:live|be alive|exist)\b/u,
  /\b(?:no reason to live|better off dead|life (?:isn't|is not) worth living)\b/u,
];

const IMMINENT_VIOLENCE = [
  /\b(?:i(?:'m| am)? going to|i(?:'ll| will)|i plan to) (?:kill|shoot|stab|hurt|attack) (?:him|her|them|someone|somebody)\b/u,
  /\b(?:weapon|gun|knife)\b.{0,80}\b(?:going to|on my way to|his house|her house|their house|kill|shoot|stab|hurt|attack)\b/u,
  /\b(?:going to|on my way to|his house|her house|their house)\b.{0,80}\b(?:weapon|gun|knife|kill|shoot|stab|hurt|attack)\b/u,
];

const AMBIGUOUS_VIOLENCE = [
  /\b(?:i )?(?:want to|wanna|might) fight (?:someone|somebody|him|her|them)\b/u,
  /\b(?:i )?(?:want to|wanna|might) hurt (?:someone|somebody|him|her|them)\b/u,
  /\b(?:i )?want revenge\b/u,
  /\b(?:i(?:'m| am)?|im) finna crash out(?: right now| rn)?\b/u,
];

const ABUSE_DISCLOSURE = [
  /\b(?:my|an?) abusive (?:partner|spouse|husband|wife|boyfriend|girlfriend|parent)\b/u,
  /\b(?:my )?(?:partner|spouse|husband|wife|boyfriend|girlfriend|parent) (?:hits|beats|threatens|controls) me\b/u,
  /\b(?:unsafe|not safe) (?:at home|with my partner|with my spouse)\b/u,
];

const EATING_DISORDER_DISTRESS = [
  /\b(?:i )?(?:do not|don't) deserve (?:food|to eat)\b/u,
  /\b(?:i(?:'m| am)? going to|i want to|i should) starve myself\b/u,
  /\b(?:i need to|i(?:'m| am)? going to) purge\b/u,
];

const REALITY_DISTRESS = [
  /\b(?:marcus|aurelius|someone|they|the voices?) (?:is|are) speaking (?:directly )?(?:into|inside) my (?:thoughts|mind|head)\b/u,
  /\b(?:someone|they|the government|the voices?) (?:is|are) (?:reading|controlling|broadcasting) my thoughts\b/u,
  /\bvoices? (?:is|are|keep) telling me to\b/u,
];

const AMBIGUOUS_PHYSICAL_NEED = /^(?:i(?:'m| am) )?(?:really )?(?:hungry|thirsty)\.?$/u;

export function routeDeterministically(request: RouteRequest): RoutingDecision | undefined {
  const message = request.message.trim();
  if (!message) {
    return createDecision('NEEDS_CLARIFICATION', 'EMPTY_INPUT', 'deterministic');
  }
  if (message.length > MAX_ROUTING_INPUT_CHARACTERS) {
    return createDecision('NEEDS_CLARIFICATION', 'INPUT_TOO_LONG', 'deterministic');
  }

  const normalized = normalizeForMatching(message);
  if (looksLikeNonsense(normalized)) {
    return createDecision('NEEDS_CLARIFICATION', 'NONSENSE_INPUT', 'deterministic');
  }
  if (matchesAny(normalized, IMMINENT_SELF_HARM)) {
    return createSafetyDecision('IMMINENT_SELF_HARM', 'SELF_HARM_IMMINENT', 'deterministic');
  }
  if (matchesAny(normalized, AMBIGUOUS_SELF_HARM)) {
    return createSafetyDecision('SELF_HARM_CONCERN', 'SELF_HARM_AMBIGUOUS', 'deterministic');
  }
  if (matchesAny(normalized, IMMINENT_VIOLENCE)) {
    return createSafetyDecision('IMMINENT_VIOLENCE', 'VIOLENCE_IMMINENT', 'deterministic');
  }
  if (matchesAny(normalized, AMBIGUOUS_VIOLENCE)) {
    return createSafetyDecision('VIOLENCE_CONCERN', 'VIOLENCE_AMBIGUOUS', 'deterministic');
  }
  if (matchesAny(normalized, ABUSE_DISCLOSURE)) {
    return createSafetyDecision('ABUSE_CONCERN', 'ABUSE', 'deterministic');
  }
  if (matchesAny(normalized, EATING_DISORDER_DISTRESS)) {
    return createSafetyDecision('EATING_DISORDER_CONCERN', 'EATING_DISORDER', 'deterministic');
  }
  if (matchesAny(normalized, REALITY_DISTRESS)) {
    return createSafetyDecision('REALITY_DISTRESS_CONCERN', 'REALITY_DISTRESS', 'deterministic');
  }
  if (AMBIGUOUS_PHYSICAL_NEED.test(normalized)) {
    return createDecision('NEEDS_CLARIFICATION', 'PHYSICAL_NEED_AMBIGUOUS', 'deterministic');
  }
  return undefined;
}

export function safetyKindFromModeration(
  message: string,
  categories: Readonly<Record<string, boolean>>,
): SafetyKind | undefined {
  if (
    categories['self-harm'] ||
    categories['self-harm/intent'] ||
    categories['self-harm/instructions']
  ) {
    return looksImminent(message, IMMINENT_SELF_HARM)
      ? 'SELF_HARM_IMMINENT'
      : 'SELF_HARM_AMBIGUOUS';
  }

  const violentThreat =
    categories['illicit/violent'] ||
    categories['harassment/threatening'] ||
    categories['hate/threatening'];
  const violentContent = categories['violence'] || categories['violence/graphic'];
  if (violentThreat || (violentContent && hasPersonalActionLanguage(message))) {
    return looksImminent(message, IMMINENT_VIOLENCE) ? 'VIOLENCE_IMMINENT' : 'VIOLENCE_AMBIGUOUS';
  }
  return undefined;
}

export function decisionFromClassification(classification: ScopeClassification): RoutingDecision {
  if (classification.route === 'SAFETY') {
    return createSafetyDecision(
      classification.reason,
      classification.safetyKind ?? 'OTHER',
      'classifier',
    );
  }
  return createDecision(
    classification.route,
    classification.reason,
    'classifier',
    classification.route === 'REFRAME'
      ? (classification.suggestedReflection ?? undefined)
      : undefined,
  );
}

export function createSafetyDecision(
  reason: RoutingReason,
  safetyKind: SafetyKind,
  source: RoutingSource,
): RoutingDecision {
  return {
    route: 'SAFETY',
    reason,
    retrieve: false,
    source,
    safetyKind,
    userMessage: safetyMessage(safetyKind),
  };
}

export function createDecision(
  route: Exclude<ConversationRoute, 'SAFETY'>,
  reason: RoutingReason,
  source: RoutingSource,
  suggestedReflection?: string,
): RoutingDecision {
  const reflection = route === 'REFRAME' ? sanitizeReflection(suggestedReflection) : undefined;
  return {
    route,
    reason,
    retrieve: route === 'IN_SCOPE',
    source,
    userMessage: routeMessage(route, reason, reflection),
    ...(reflection ? { suggestedReflection: reflection } : {}),
  };
}

export function isSafetyKind(value: unknown): value is SafetyKind {
  return typeof value === 'string' && (SAFETY_KINDS as readonly string[]).includes(value);
}

function normalizeForMatching(message: string): string {
  return message
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function looksLikeNonsense(message: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(message)) {
    return true;
  }
  if (!/^[a-z\s\p{P}\p{S}]+$/u.test(message)) {
    return false;
  }
  const words = message.match(/[a-z]+/gu) ?? [];
  const letterCount = words.join('').length;
  return (
    words.length >= 2 &&
    letterCount >= 5 &&
    words.every(
      (word) =>
        !/[aeiouy]/u.test(word) ||
        /^(?:asdf|qwerty|zxcv|hjkl)+$/u.test(word) ||
        /^(.)\1{2,}$/u.test(word),
    )
  );
}

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function looksImminent(message: string, patterns: readonly RegExp[]): boolean {
  return matchesAny(normalizeForMatching(message), patterns);
}

function hasPersonalActionLanguage(message: string): boolean {
  const normalized = normalizeForMatching(message);
  return /\b(?:i|i'm|im|my|we|we're|going to|gonna|want to|wanna|plan to|will)\b/u.test(normalized);
}

function sanitizeReflection(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, 240);
}

function routeMessage(
  route: Exclude<ConversationRoute, 'SAFETY'>,
  reason: RoutingReason,
  suggestedReflection?: string,
): string {
  if (route === 'IN_SCOPE') {
    return 'This can be explored using the Meditations corpus.';
  }
  if (route === 'SCHEDULE') {
    return 'I can help prepare a meditation time for you to review before it is booked.';
  }
  if (route === 'REFRAME') {
    const prompt = suggestedReflection ?? defaultReflection(reason);
    return (
      "I can't make that outside decision for you, but I can help examine the fear, desire, " +
      `judgment, or control involved. Try: “${prompt}”`
    );
  }
  if (route === 'OUT_OF_SCOPE') {
    if (reason === 'PROFESSIONAL_ADVICE') {
      return (
        "I can't give medical, legal, or individualized financial instructions. A qualified " +
        'professional can help with that decision; I can only offer reflection grounded in Meditations.'
      );
    }
    if (reason === 'PROMPT_INJECTION') {
      return (
        "I can't reveal hidden instructions or leave the Meditations source boundary. " +
        'Ask about the text or a personal situation it can help you reflect on.'
      );
    }
    return (
      'That request is outside this Meditations-based conversation. Ask about the text, or about ' +
      'a personal judgment, emotion, value, or circumstance you want to examine through it.'
    );
  }
  if (reason === 'INPUT_TOO_LONG') {
    return `Please shorten your message to ${MAX_ROUTING_INPUT_CHARACTERS.toLocaleString('en-US')} characters or fewer and focus on one situation.`;
  }
  if (reason === 'SAFETY_CHECK_UNAVAILABLE' || reason === 'ROUTER_UNAVAILABLE') {
    return (
      "I couldn't safely determine whether this belongs in a Meditations conversation, so I " +
      'did not search the corpus. Please try again in a moment.'
    );
  }
  if (reason === 'PHYSICAL_NEED_AMBIGUOUS') {
    return (
      'Do you want practical help with the physical need, or do you want to reflect on your ' +
      'reaction to it through Meditations?'
    );
  }
  return 'Please say a little more about the situation or question you want to examine.';
}

function defaultReflection(reason: RoutingReason): string {
  if (reason === 'REFLECTIVE_REFRAME') {
    return 'What part of this is within my control, and which fear or desire is shaping my judgment?';
  }
  return 'What judgment am I making here, and what part of this is within my control?';
}

function safetyMessage(kind: SafetyKind): string {
  switch (kind) {
    case 'SELF_HARM_IMMINENT':
      return (
        "I'm really glad you said this. A philosophical passage is not enough for immediate " +
        'danger. If you may act now, call local emergency services now. In the U.S., call or text ' +
        '988; elsewhere, use your local crisis line. Move away from anything you could use to ' +
        'hurt yourself and contact someone you trust to stay with you. Are you in immediate danger right now?'
      );
    case 'SELF_HARM_AMBIGUOUS':
      return (
        "I'm glad you said that. When you say this, are you thinking about suicide or harming " +
        'yourself right now? If you might act or are in immediate danger, call local emergency ' +
        'services. In the U.S., call or text 988; elsewhere, use your local crisis line. Please ' +
        'contact someone you trust and tell them plainly what is happening.'
      );
    case 'VIOLENCE_IMMINENT':
      return (
        'Do not go toward the person. Create distance now and, if it is safe, put down or move ' +
        'away from any weapon. If anyone may be in immediate danger, call local emergency services. ' +
        'Contact someone you trust who can stay with you while the urge passes.'
      );
    case 'VIOLENCE_AMBIGUOUS':
      return (
        'I hear how intense this is. Before using Meditations, I need to ask: are you planning to ' +
        'hurt someone right now? Create distance from the person and from any weapon. If anyone is ' +
        'in immediate danger, call local emergency services.'
      );
    case 'ABUSE':
      return (
        'You do not have to endure abuse. If you are in immediate danger, call local emergency ' +
        'services or move to a safer place if you can do so safely. Consider contacting a local ' +
        'domestic-violence service or a trusted person who can help you make a safety plan.'
      );
    case 'EATING_DISORDER':
      return (
        'You deserve food and support; this is not a question that a philosophical passage should ' +
        'decide. Please contact a medical or mental-health professional or someone you trust. If ' +
        'you are in immediate medical danger, call local emergency services.'
      );
    case 'REALITY_DISTRESS':
      return (
        "I can't confirm that Marcus or anyone else is communicating directly through your " +
        'thoughts. That sounds distressing. Please contact a trusted person or mental-health ' +
        'professional now; if you may act on a command or are in immediate danger, call local emergency services.'
      );
    case 'OTHER':
      return (
        'This may need immediate human support rather than a passage from Meditations. If you or ' +
        'someone else is in danger, call local emergency services; otherwise, contact a trusted ' +
        'person or qualified professional now.'
      );
  }
}

export function classifierReason(value: unknown): value is ClassifierReason {
  return (
    typeof value === 'string' &&
    [
      'PERSONAL_REFLECTION',
      'CORPUS_QUESTION',
      'MEDITATION_SCHEDULING',
      'REFLECTIVE_REFRAME',
      'EXTERNAL_FACT',
      'EXTERNAL_TASK',
      'PROFESSIONAL_ADVICE',
      'PROMPT_INJECTION',
      'AMBIGUOUS',
      'SAFETY_CONCERN',
    ].includes(value)
  );
}
