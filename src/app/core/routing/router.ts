import { ModerationGateway, RouteRequest, RoutingDecision, ScopeClassifier } from './types';
import {
  MAX_ROUTING_HISTORY_MESSAGES,
  MAX_ROUTING_INPUT_CHARACTERS,
  createDecision,
  createSafetyDecision,
  decisionFromClassification,
  routeDeterministically,
  safetyKindFromModeration,
} from './policy';

export interface ConversationRouterDependencies {
  readonly moderation: ModerationGateway;
  readonly classifier: ScopeClassifier;
}

export class ConversationRouter {
  constructor(private readonly dependencies: ConversationRouterDependencies) {}

  /**
   * Plain-English pseudocode for the selector:
   * 1. Normalize the current message and a small window of conversation context.
   * 2. Apply deterministic input and urgent-safety rules first.
   * 3. Run moderation; route self-harm or violence to the safety response.
   * 4. Classify the remaining request into RAG, scheduling, reframing, out-of-scope, or clarification.
   * 5. If a remote decision service fails, fail closed with a clarification instead of retrieving.
   */
  async route(request: RouteRequest): Promise<RoutingDecision> {
    const normalized = normalizeRequest(request);
    const deterministic = routeDeterministically(normalized);
    if (deterministic) {
      return deterministic;
    }

    let moderation;
    try {
      moderation = await this.dependencies.moderation.moderate(normalized.message);
    } catch {
      return createDecision('NEEDS_CLARIFICATION', 'SAFETY_CHECK_UNAVAILABLE', 'fallback');
    }
    const moderatedSafetyKind = safetyKindFromModeration(normalized.message, moderation.categories);
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
}

function normalizeRequest(request: RouteRequest): RouteRequest {
  return {
    message: request.message.trim(),
    recentUserMessages: (request.recentUserMessages ?? [])
      .slice(-MAX_ROUTING_HISTORY_MESSAGES)
      .map((message) => message.trim().slice(0, MAX_ROUTING_INPUT_CHARACTERS))
      .filter(Boolean),
  };
}
