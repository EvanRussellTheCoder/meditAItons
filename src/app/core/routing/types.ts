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

export interface DeferredSafetyTopic {
  /** A short neutral display phrase, such as “your concerns about AI and job security”. */
  readonly label: string;
  /** An exact substring of the user message that introduced the postponed request. */
  readonly message: string;
}

export const SAFETY_FOLLOW_UP_STATUSES = ['ACTIVE', 'FOLLOW_UP_REQUIRED', 'RESOLVED'] as const;

export type SafetyFollowUpStatus = (typeof SAFETY_FOLLOW_UP_STATUSES)[number];

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
  'SAFETY_FOLLOW_UP_REQUIRED',
  'SAFETY_REASSESSMENT_UNAVAILABLE',
  'SAFETY_RESOLVED',
  'SAFETY_CHECK_UNAVAILABLE',
  'ROUTER_UNAVAILABLE',
] as const;

export type RoutingReason = (typeof ROUTING_REASONS)[number];

export type RoutingSource = 'deterministic' | 'moderation' | 'classifier' | 'fallback';

export interface RouteRequest {
  readonly message: string;
  /** Up to six earlier user messages. Assistant text is intentionally excluded. */
  readonly recentUserMessages?: readonly string[];
  /** Present only while the last routed assistant response left an intent-safety concern open. */
  readonly pendingSafety?: {
    /** Null supports conversations saved before safety-kind metadata was persisted. */
    readonly kind: SafetyKind | null;
    readonly deferredSafetyTopic?: DeferredSafetyTopic;
  };
}

export interface RoutingDecision {
  readonly route: ConversationRoute;
  readonly reason: RoutingReason;
  readonly retrieve: boolean;
  readonly source: RoutingSource;
  readonly userMessage: string;
  readonly safetyKind?: SafetyKind;
  readonly suggestedReflection?: string;
  /** The exact safe substring to use downstream after a resolved safety follow-up. */
  readonly effectiveMessage?: string;
  readonly safetyFollowUpStatus?: SafetyFollowUpStatus;
  /** Persisted only while an intent-safety check remains unresolved. */
  readonly deferredSafetyTopic?: DeferredSafetyTopic;
  /** Set only when a stored deferred topic is resumed after resolution. */
  readonly resumedDeferredSafetyTopic?: DeferredSafetyTopic;
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

export interface SafetyFollowUpRequest {
  readonly message: string;
  readonly recentUserMessages: readonly string[];
  readonly priorSafetyKind: SafetyKind | null;
  readonly moderatedSafetyKind: SafetyKind | null;
}

export interface SafetyFollowUpAssessment {
  readonly status: SafetyFollowUpStatus;
  readonly safetyKind: SafetyKind;
  readonly continuationMessage: string | null;
  readonly deferredSafetyTopic: DeferredSafetyTopic | null;
}

export interface SafetyFollowUpClassifier {
  assessSafetyFollowUp(request: SafetyFollowUpRequest): Promise<SafetyFollowUpAssessment>;
}
