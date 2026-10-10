import type {
  ChatApiRequest,
  ChatApiResponse,
  ChatCitation,
  ChatHistoryMessage,
} from '../models/chat.models';
import { logRoutingDecision, observeStage } from '../observability';
import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OpenAIEmbeddingClient,
  PineconeQueryMatch,
  PineconeRestClient,
  PineconeUploadError,
} from '../pinecone';
import { ConversationRouter } from '../routing';
import type { DeferredSafetyTopic, SafetyKind } from '../routing';
import type { MeditationSchedulingGateway } from '../scheduling';
import { ChatEvidence, GroundedAnswerGateway } from './openai-grounded-answer';

const DEFAULT_TOP_K = 5;
const MAX_EVIDENCE_PARENTS = 4;
const INSUFFICIENT_EVIDENCE_MESSAGE =
  "I couldn't find a passage in this edition of Meditations that supports a reliable answer to " +
  'that question. I would rather leave the gap visible than invent Marcus’s view.';
const SAFETY_RESOLVED_PREFIX = 'Thanks for answering directly. We can continue. ';

export interface MeditationsChatDependencies {
  readonly router: Pick<ConversationRouter, 'route'>;
  readonly embeddings: Pick<OpenAIEmbeddingClient, 'createEmbeddings'>;
  readonly pinecone: Pick<PineconeRestClient, 'queryByVector' | 'validateIndexConfiguration'>;
  readonly answers: GroundedAnswerGateway;
  readonly scheduling: MeditationSchedulingGateway;
  readonly namespace: string;
  readonly embeddingModel: string;
  readonly topK?: number;
}

export class MeditationsChatService {
  private readonly topK: number;

  constructor(private readonly dependencies: MeditationsChatDependencies) {
    this.topK = dependencies.topK ?? DEFAULT_TOP_K;
  }

  async initialize(): Promise<void> {
    const index = await this.dependencies.pinecone.validateIndexConfiguration();
    if (
      !index ||
      index.integratedEmbedding ||
      index.vectorType !== 'dense' ||
      index.dimension !== OPENAI_EMBEDDING_DIMENSIONS
    ) {
      throw new Error(
        `ChatConfigurationError: expected a standard dense ${OPENAI_EMBEDDING_DIMENSIONS}-dimensional Pinecone index`,
      );
    }
  }

  /**
   * Plain-English pseudocode for one chat turn:
   * 1. Route the request before performing retrieval.
   * 2. Return a guardrail response, or build a scheduling proposal, when RAG is not selected.
   * 3. For RAG, embed the question and retrieve the nearest child chunks from Pinecone.
   * 4. Validate and deduplicate the evidence, then ask the answer model to use only those parents.
   * 5. Attach exact retrieved child text as quotations for the references the model selected.
   * 6. Abstain when the evidence is insufficient instead of inventing Marcus Aurelius's view.
   */
  async respond(request: ChatApiRequest, requestId?: string): Promise<ChatApiResponse> {
    const context = routingContext(request.history);
    const routing = await observeStage(
      'selector',
      requestId,
      () =>
        this.dependencies.router.route({
          message: request.message,
          recentUserMessages: context.recentUserMessages,
          ...(context.pendingSafety ? { pendingSafety: context.pendingSafety } : {}),
        }),
      {
        inputs: {
          safe: {
            messageCharacters: request.message.length,
            recentUserMessages: context.recentUserMessages.length,
            pendingSafetyKind: context.pendingSafety?.kind ?? null,
            deferredSafetyTopicPresent: Boolean(context.pendingSafety?.deferredSafetyTopic),
          },
          content: {
            message: request.message,
            recentUserMessages: context.recentUserMessages,
          },
        },
        outputs: (decision) => ({
          safe: {
            route: decision.route,
            reason: decision.reason,
            source: decision.source,
            retrieve: decision.retrieve,
            safetyKind: decision.safetyKind ?? null,
            safetyFollowUpStatus: decision.safetyFollowUpStatus ?? null,
            effectiveMessageCharacters: decision.effectiveMessage?.length ?? null,
            deferredSafetyTopicPresent: Boolean(decision.deferredSafetyTopic),
            deferredSafetyTopicLabelCharacters: decision.deferredSafetyTopic?.label.length ?? null,
            deferredSafetyMessageCharacters: decision.deferredSafetyTopic?.message.length ?? null,
            resumedDeferredSafetyTopic: Boolean(decision.resumedDeferredSafetyTopic),
          },
          content: {
            userMessage: decision.userMessage,
            suggestedReflection: decision.suggestedReflection ?? null,
          },
        }),
      },
    );
    logRoutingDecision({
      requestId,
      currentMessage: request.message,
      historyMessages: request.history.length,
      decision: routing,
    });
    const effectiveMessage = routing.effectiveMessage ?? request.message;
    if (!routing.retrieve) {
      if (routing.route === 'SCHEDULE') {
        const scheduling = await this.dependencies.scheduling.propose({
          message: effectiveMessage,
          history: context.downstreamHistory,
          timezone: request.timezone,
          ...(requestId ? { requestId } : {}),
        });
        return {
          route: routing.route,
          reason: routing.reason,
          safetyKind: null,
          deferredSafetyTopic: null,
          message: withSafetyResolutionAcknowledgement(scheduling.message, routing),
          citations: [],
          schedulingProposal: scheduling.proposal,
        };
      }
      return {
        route: routing.route,
        reason: routing.reason,
        safetyKind: routing.safetyKind ?? null,
        deferredSafetyTopic:
          routing.route === 'SAFETY' ? (routing.deferredSafetyTopic ?? null) : null,
        message: withSafetyResolutionAcknowledgement(routing.userMessage, routing),
        citations: [],
        schedulingProposal: null,
      };
    }

    const [queryVector] = await observeStage(
      'embedding',
      requestId,
      () => this.dependencies.embeddings.createEmbeddings([effectiveMessage]),
      {
        runType: 'embedding',
        inputs: {
          safe: {
            model: this.dependencies.embeddingModel,
            inputCount: 1,
            inputCharacters: effectiveMessage.length,
          },
          content: { texts: [effectiveMessage] },
        },
        outputs: (vectors) => ({
          safe: {
            vectorCount: vectors.length,
            dimensions: vectors[0]?.length ?? 0,
          },
        }),
      },
    );
    const matches = await observeStage(
      'pinecone',
      requestId,
      () =>
        this.dependencies.pinecone.queryByVector(
          this.dependencies.namespace,
          queryVector,
          this.topK,
        ),
      {
        runType: 'retriever',
        inputs: {
          safe: {
            namespace: this.dependencies.namespace,
            topK: this.topK,
            vectorDimensions: queryVector.length,
          },
        },
        outputs: (items) => ({
          safe: {
            matchCount: items.length,
            matches: items.map((item) => ({
              id: item.id,
              score: item.score,
              canonicalRef: item.metadata['canonical_ref'] ?? null,
            })),
          },
          content: {
            matches: items.map((item) => ({
              id: item.id,
              score: item.score,
              canonicalRef: item.metadata['canonical_ref'] ?? null,
              chunkText: item.metadata['chunk_text'] ?? null,
              parentText: item.metadata['parent_text'] ?? null,
              sourceUrl: item.metadata['source_url'] ?? null,
            })),
          },
        }),
      },
    );
    validateMatchEmbeddings(matches, this.dependencies.embeddingModel, OPENAI_EMBEDDING_DIMENSIONS);
    const evidence = createEvidence(matches);
    const answer = await observeStage(
      'grounded_answer',
      requestId,
      () =>
        this.dependencies.answers.generate({
          message: effectiveMessage,
          history: context.downstreamHistory,
          evidence,
        }),
      {
        inputs: {
          safe: {
            historyMessages: context.downstreamHistory.length,
            evidenceCount: evidence.length,
            evidenceReferences: evidence.map((item) => item.canonicalRef),
          },
          content: {
            message: effectiveMessage,
            history: context.downstreamHistory,
            evidence,
          },
        },
        outputs: (result) => ({
          safe: {
            sufficientEvidence: result.sufficientEvidence,
            citedReferences: result.citedReferences,
          },
          content: { answer: result.answer },
        }),
      },
    );
    if (!answer.sufficientEvidence) {
      return {
        route: routing.route,
        reason: routing.reason,
        safetyKind: null,
        deferredSafetyTopic: null,
        message: withSafetyResolutionAcknowledgement(INSUFFICIENT_EVIDENCE_MESSAGE, routing),
        citations: [],
        schedulingProposal: null,
      };
    }

    const citationsByReference = new Map(
      evidence.map((item): readonly [string, ChatCitation] => [
        item.canonicalRef,
        {
          canonicalRef: item.canonicalRef,
          quote: item.quoteText,
          sourceUrl: item.sourceUrl,
        },
      ]),
    );
    const citations = answer.citedReferences.map((reference) => {
      const citation = citationsByReference.get(reference);
      if (!citation) {
        throw new Error(`GroundedAnswerError: citation ${reference} has no retrieved source`);
      }
      return citation;
    });
    return {
      route: routing.route,
      reason: routing.reason,
      safetyKind: null,
      deferredSafetyTopic: null,
      message: withSafetyResolutionAcknowledgement(answer.answer, routing),
      citations,
      schedulingProposal: null,
    };
  }
}

interface RoutingContext {
  readonly recentUserMessages: readonly string[];
  readonly downstreamHistory: readonly ChatHistoryMessage[];
  readonly pendingSafety?: {
    readonly kind: SafetyKind | null;
    readonly deferredSafetyTopic?: DeferredSafetyTopic;
  };
}

function routingContext(history: readonly ChatHistoryMessage[]): RoutingContext {
  let latestSafetyIndex = -1;
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index];
    if (item.author === 'marcus' && item.route === 'SAFETY') {
      latestSafetyIndex = index;
    }
  }
  if (latestSafetyIndex < 0) {
    return contextFromHistory(history);
  }

  const resolvedBarrier = history.findIndex(
    (item, index) =>
      index > latestSafetyIndex &&
      item.author === 'marcus' &&
      item.route !== undefined &&
      item.route !== 'SAFETY',
  );
  if (resolvedBarrier >= 0) {
    return contextFromHistory(history.slice(resolvedBarrier + 1));
  }

  const safetyMarker = history[latestSafetyIndex];
  const downstreamHistory = stripRoutingMetadata(history.slice(latestSafetyIndex + 1));
  const recentUserMessages = history
    .filter((item) => item.author === 'user')
    .map((item) => item.content);
  if (isStickySafetyKind(safetyMarker.safetyKind)) {
    return {
      recentUserMessages,
      downstreamHistory,
      pendingSafety: {
        kind: safetyMarker.safetyKind ?? null,
        ...(safetyMarker.deferredSafetyTopic
          ? { deferredSafetyTopic: safetyMarker.deferredSafetyTopic }
          : {}),
      },
    };
  }
  return contextFromHistory(downstreamHistory);
}

function contextFromHistory(history: readonly ChatHistoryMessage[]): RoutingContext {
  return {
    recentUserMessages: history
      .filter((item) => item.author === 'user')
      .map((item) => item.content),
    downstreamHistory: stripRoutingMetadata(history),
  };
}

function stripRoutingMetadata(
  history: readonly ChatHistoryMessage[],
): readonly ChatHistoryMessage[] {
  return history.map(({ author, content }) => ({ author, content }));
}

function isStickySafetyKind(kind: SafetyKind | undefined): boolean {
  return (
    kind === undefined ||
    kind === 'SELF_HARM_AMBIGUOUS' ||
    kind === 'SELF_HARM_IMMINENT' ||
    kind === 'VIOLENCE_AMBIGUOUS' ||
    kind === 'VIOLENCE_IMMINENT'
  );
}

function withSafetyResolutionAcknowledgement(
  message: string,
  routing: {
    readonly effectiveMessage?: string;
    readonly safetyFollowUpStatus?: string;
    readonly resumedDeferredSafetyTopic?: DeferredSafetyTopic;
  },
): string {
  if (routing.safetyFollowUpStatus !== 'RESOLVED' || !routing.effectiveMessage) {
    return message;
  }
  const resumed = routing.resumedDeferredSafetyTopic;
  return resumed
    ? `Thanks for answering directly. We can continue with ${resumed.label}. ${message}`
    : `${SAFETY_RESOLVED_PREFIX}${message}`;
}

function createEvidence(matches: readonly PineconeQueryMatch[]): readonly ChatEvidence[] {
  const evidence: ChatEvidence[] = [];
  const parentIds = new Set<string>();
  for (const match of matches) {
    const parentId = metadataString(match, 'parent_id');
    if (parentIds.has(parentId)) {
      continue;
    }
    const sourceUrl = metadataString(match, 'source_url');
    if (!isTrustedWikisourceUrl(sourceUrl)) {
      throw new Error(`ChatEvidenceError: query match ${match.id} has an untrusted source URL`);
    }
    const parentText = metadataString(match, 'parent_text');
    const quoteText = metadataString(match, 'chunk_text');
    if (!parentText.includes(quoteText)) {
      throw new Error(
        `ChatEvidenceError: query match ${match.id} has child text outside its canonical parent`,
      );
    }
    parentIds.add(parentId);
    evidence.push({
      canonicalRef: metadataString(match, 'canonical_ref'),
      parentText,
      quoteText,
      sourceUrl,
    });
    if (evidence.length === MAX_EVIDENCE_PARENTS) {
      break;
    }
  }
  return evidence;
}

function validateMatchEmbeddings(
  matches: readonly PineconeQueryMatch[],
  expectedModel: string,
  expectedDimensions: number,
): void {
  if (matches.length === 0) {
    throw new PineconeUploadError('VERIFICATION_FAILED', 'chat query returned no matches');
  }
  for (const match of matches) {
    if (
      match.metadata['embedding_model'] !== expectedModel ||
      match.metadata['embedding_dimensions'] !== expectedDimensions
    ) {
      throw new PineconeUploadError(
        'VERIFICATION_FAILED',
        `chat query match ${match.id} was embedded with an unexpected model or dimension`,
      );
    }
  }
}

function metadataString(match: PineconeQueryMatch, field: string): string {
  const value = match.metadata[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`ChatEvidenceError: query match ${match.id} is missing ${field}`);
  }
  return value;
}

function isTrustedWikisourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'en.wikisource.org' &&
      url.pathname.startsWith('/wiki/') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
