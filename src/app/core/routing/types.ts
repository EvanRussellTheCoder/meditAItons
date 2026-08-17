export const CONVERSATION_ROUTES = [
  'IN_SCOPE',
  'SCHEDULE',
  'REFRAME',
  'OUT_OF_SCOPE',
  'NEEDS_CLARIFICATION',
  'SAFETY',
] as const;

export type ConversationRoute = (typeof CONVERSATION_ROUTES)[number];

export const SAFETY_KINDS = [
  'SELF_HARM_AMBIGUOUS',
  'SELF_HARM_IMMINENT',
  'VIOLENCE_AMBIGUOUS',
  'VIOLENCE_IMMINENT',
  'ABUSE',
  'EATING_DISORDER',
  'REALITY_DISTRESS',
  'OTHER',
] as const;

export type SafetyKind = (typeof SAFETY_KINDS)[number];

export const CLASSIFIER_REASONS = [
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
] as const;

export type ClassifierReason = (typeof CLASSIFIER_REASONS)[number];

export const ROUTING_REASONS = [
  ...CLASSIFIER_REASONS,
  'EMPTY_INPUT',
  'INPUT_TOO_LONG',
  'NONSENSE_INPUT',
  'PHYSICAL_NEED_AMBIGUOUS',
  'SELF_HARM_CONCERN',
  'IMMINENT_SELF_HARM',
  'VIOLENCE_CONCERN',
  'IMMINENT_VIOLENCE',
  'ABUSE_CONCERN',
  'EATING_DISORDER_CONCERN',
  'REALITY_DISTRESS_CONCERN',
  'MODERATION_SELF_HARM',
  'MODERATION_VIOLENCE',
  'SAFETY_CHECK_UNAVAILABLE',
  'ROUTER_UNAVAILABLE',
] as const;

export type RoutingReason = (typeof ROUTING_REASONS)[number];

export type RoutingSource = 'deterministic' | 'moderation' | 'classifier' | 'fallback';

export interface RouteRequest {
  readonly message: string;
  /** Up to six earlier user messages. Assistant text is intentionally excluded. */
  readonly recentUserMessages?: readonly string[];
}

export interface RoutingDecision {
  readonly route: ConversationRoute;
  readonly reason: RoutingReason;
  readonly retrieve: boolean;
  readonly source: RoutingSource;
  readonly userMessage: string;
  readonly safetyKind?: SafetyKind;
  readonly suggestedReflection?: string;
}

export interface ModerationResult {
  readonly flagged: boolean;
  readonly categories: Readonly<Record<string, boolean>>;
}

export interface ScopeClassification {
  readonly route: ConversationRoute;
  readonly reason: ClassifierReason;
  readonly safetyKind: SafetyKind | null;
  readonly suggestedReflection: string | null;
}

export interface ModerationGateway {
  moderate(message: string): Promise<ModerationResult>;
}

export interface ScopeClassifier {
  classify(request: RouteRequest): Promise<ScopeClassification>;
}
