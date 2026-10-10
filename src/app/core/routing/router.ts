import {
  ModerationGateway,
  DeferredSafetyTopic,
  RouteRequest,
  RoutingDecision,
  SafetyFollowUpClassifier,
  SafetyKind,
  ScopeClassifier,
} from './types';
import {
  MAX_ROUTING_HISTORY_MESSAGES,
  MAX_ROUTING_INPUT_CHARACTERS,
  createDecision,
  createSafetyDecision,
  createSafetyFollowUpDecision,
  createSafetyReassessmentUnavailableDecision,
  createSafetyResolvedDecision,
  decisionFromClassification,
  isIntentSafetyKind,
  routeDeterministically,
  safetyKindFromModeration,
} from './policy';

export interface ConversationRouterDependencies {
  readonly moderation: ModerationGateway;
  readonly classifier: ScopeClassifier;
  readonly safetyFollowUp: SafetyFollowUpClassifier;
}

export class ConversationRouter {
  constructor(private readonly dependencies: ConversationRouterDependencies) {}

  /**
   * Plain-English pseudocode for the selector:
   * 1. Normalize the current message and a small window of conversation context.
   * 2. Apply deterministic input and urgent-safety rules first.
   * 3. Run moderation and use its result as a policy signal.
   * 4. If an intent-safety concern is open, assess whether it remains active, needs a direct answer,
   *    or is resolved; only a resolved exact continuation can return to normal routing.
   * 5. Otherwise, route moderated self-harm or violence directly to the safety response.
   * 6. Classify the remaining request into RAG, scheduling, reframing, out-of-scope, or clarification.
   * 7. If a remote decision service fails, fail closed without retrieval.
   */
  async route(request: RouteRequest): Promise<RoutingDecision> {
    const normalized = normalizeRequest(request);
    const pendingSafety = stickyPendingSafety(normalized);
    const deterministic = routeDeterministically(normalized);
    const negatedPendingSafetyMatch =
      pendingSafety.present &&
      deterministic?.route === 'SAFETY' &&
      containsExplicitSafetyNegation(normalized.message);
    if (
      (deterministic?.route === 'SAFETY' && !negatedPendingSafetyMatch) ||
      (!pendingSafety.present && deterministic)
    ) {
      return deterministic;
    }

    let moderation;
    try {
      moderation = await this.dependencies.moderation.moderate(normalized.message);
    } catch {
      if (pendingSafety.present) {
        return createSafetyReassessmentUnavailableDecision(
          pendingSafety.kind,
          pendingSafety.deferredSafetyTopic,
        );
      }
      return createDecision('NEEDS_CLARIFICATION', 'SAFETY_CHECK_UNAVAILABLE', 'fallback');
    }
    const moderatedSafetyKind = safetyKindFromModeration(normalized.message, moderation.categories);

    if (pendingSafety.present) {
      return this.routePendingSafety(normalized, pendingSafety, moderatedSafetyKind ?? null);
    }

    if (moderatedSafetyKind) {
      return createSafetyDecision(
        moderatedSafetyKind.startsWith('SELF_HARM')
          ? 'MODERATION_SELF_HARM'
          : 'MODERATION_VIOLENCE',
        moderatedSafetyKind,
        'moderation',
      );
    }

    try {
      return decisionFromClassification(await this.dependencies.classifier.classify(normalized));
    } catch {
      return createDecision('NEEDS_CLARIFICATION', 'ROUTER_UNAVAILABLE', 'fallback');
    }
  }

  private async routePendingSafety(
    request: RouteRequest,
    pendingSafety: {
      readonly kind: SafetyKind | null;
      readonly deferredSafetyTopic?: DeferredSafetyTopic;
    },
    moderatedSafetyKind: SafetyKind | null,
  ): Promise<RoutingDecision> {
    const priorSafetyKind = pendingSafety.kind;
    let assessment;
    try {
      assessment = await this.dependencies.safetyFollowUp.assessSafetyFollowUp({
        message: request.message,
        recentUserMessages: request.recentUserMessages ?? [],
        priorSafetyKind,
        moderatedSafetyKind,
      });
    } catch {
      return createSafetyReassessmentUnavailableDecision(
        priorSafetyKind,
        pendingSafety.deferredSafetyTopic,
      );
    }

    if (!isFollowUpSafetyKind(assessment.safetyKind)) {
      return createSafetyReassessmentUnavailableDecision(
        priorSafetyKind,
        pendingSafety.deferredSafetyTopic,
      );
    }
    const assessedSafetyKind =
      assessment.safetyKind === 'OTHER' && priorSafetyKind !== null
        ? priorSafetyKind
        : assessment.safetyKind;
    const safetyKind = preserveImminence(
      priorSafetyKind,
      preserveImminence(moderatedSafetyKind, assessedSafetyKind),
    );

    if (assessment.status === 'ACTIVE') {
      const deferredSafetyTopic =
        safetyKind === priorSafetyKind ? pendingSafety.deferredSafetyTopic : undefined;
      return {
        ...createSafetyDecision('SAFETY_CONCERN', safetyKind, 'classifier'),
        safetyFollowUpStatus: 'ACTIVE',
        ...(deferredSafetyTopic ? { deferredSafetyTopic } : {}),
      };
    }
    if (assessment.status === 'FOLLOW_UP_REQUIRED') {
      const preservedDeferredSafetyTopic =
        safetyKind === priorSafetyKind ? pendingSafety.deferredSafetyTopic : undefined;
      return createSafetyFollowUpDecision(
        safetyKind,
        assessment.deferredSafetyTopic ?? preservedDeferredSafetyTopic,
      );
    }

    const continuation = assessment.continuationMessage?.trim() || null;
    if (continuation !== null && !request.message.includes(continuation)) {
      return createSafetyReassessmentUnavailableDecision(
        priorSafetyKind,
        pendingSafety.deferredSafetyTopic,
      );
    }
    if (continuation === null) {
      return pendingSafety.deferredSafetyTopic
        ? this.routeDeferredMessage(pendingSafety.deferredSafetyTopic)
        : createSafetyResolvedDecision();
    }

    try {
      const decision = decisionFromClassification(
        await this.dependencies.classifier.classify({
          message: continuation,
          recentUserMessages: [],
        }),
      );
      if (decision.route === 'SAFETY') {
        return decision;
      }
      return {
        ...decision,
        effectiveMessage: continuation,
        safetyFollowUpStatus: 'RESOLVED',
      };
    } catch {
      return {
        ...createDecision('NEEDS_CLARIFICATION', 'ROUTER_UNAVAILABLE', 'fallback'),
        effectiveMessage: continuation,
        safetyFollowUpStatus: 'RESOLVED',
      };
    }
  }

  private async routeDeferredMessage(
    deferredSafetyTopic: DeferredSafetyTopic,
  ): Promise<RoutingDecision> {
    const request = { message: deferredSafetyTopic.message, recentUserMessages: [] } as const;
    const deterministic = routeDeterministically(request);
    if (deterministic?.route === 'SAFETY') {
      return deterministic;
    }

    let moderatedSafetyKind: SafetyKind | undefined;
    try {
      const moderation = await this.dependencies.moderation.moderate(request.message);
      moderatedSafetyKind = safetyKindFromModeration(request.message, moderation.categories);
    } catch {
      return decorateResumedDecision(
        createDecision('NEEDS_CLARIFICATION', 'SAFETY_CHECK_UNAVAILABLE', 'fallback'),
        deferredSafetyTopic,
      );
    }
    if (moderatedSafetyKind) {
      return createSafetyDecision(
        moderatedSafetyKind.startsWith('SELF_HARM')
          ? 'MODERATION_SELF_HARM'
          : 'MODERATION_VIOLENCE',
        moderatedSafetyKind,
        'moderation',
      );
    }
    if (deterministic) {
      return decorateResumedDecision(deterministic, deferredSafetyTopic);
    }

    try {
      const decision = decisionFromClassification(
        await this.dependencies.classifier.classify(request),
      );
      return decision.route === 'SAFETY'
        ? decision
        : decorateResumedDecision(decision, deferredSafetyTopic);
    } catch {
      return decorateResumedDecision(
        createDecision('NEEDS_CLARIFICATION', 'ROUTER_UNAVAILABLE', 'fallback'),
        deferredSafetyTopic,
      );
    }
  }
}

function normalizeRequest(request: RouteRequest): RouteRequest {
  return {
    message: request.message.trim(),
    recentUserMessages: (request.recentUserMessages ?? [])
      .slice(-MAX_ROUTING_HISTORY_MESSAGES)
      .map((message) => message.trim().slice(0, MAX_ROUTING_INPUT_CHARACTERS))
      .filter(Boolean),
    ...(request.pendingSafety ? { pendingSafety: request.pendingSafety } : {}),
  };
}

function stickyPendingSafety(request: RouteRequest):
  | { readonly present: false }
  | {
      readonly present: true;
      readonly kind: SafetyKind | null;
      readonly deferredSafetyTopic?: DeferredSafetyTopic;
    } {
  if (!request.pendingSafety) {
    return { present: false };
  }
  const kind = request.pendingSafety.kind;
  return kind === null || isIntentSafetyKind(kind)
    ? {
        present: true,
        kind,
        ...(request.pendingSafety.deferredSafetyTopic
          ? { deferredSafetyTopic: request.pendingSafety.deferredSafetyTopic }
          : {}),
      }
    : { present: false };
}

function isFollowUpSafetyKind(kind: SafetyKind): boolean {
  return isIntentSafetyKind(kind) || kind === 'OTHER';
}

function preserveImminence(previous: SafetyKind | null, next: SafetyKind): SafetyKind {
  if (previous === 'SELF_HARM_IMMINENT' && next === 'SELF_HARM_AMBIGUOUS') {
    return previous;
  }
  if (previous === 'VIOLENCE_IMMINENT' && next === 'VIOLENCE_AMBIGUOUS') {
    return previous;
  }
  return next;
}

function containsExplicitSafetyNegation(message: string): boolean {
  const normalized = message
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
  return /\b(?:i(?:'m| am) not|im not|i (?:will not|won't)|not going to|no longer (?:plan|intend))\b.{0,100}\b(?:hurt|kill|attack|fight)\b/u.test(
    normalized,
  );
}

function decorateResumedDecision(
  decision: RoutingDecision,
  deferredSafetyTopic: DeferredSafetyTopic,
): RoutingDecision {
  return {
    ...decision,
    effectiveMessage: deferredSafetyTopic.message,
    safetyFollowUpStatus: 'RESOLVED',
    resumedDeferredSafetyTopic: deferredSafetyTopic,
  };
}
