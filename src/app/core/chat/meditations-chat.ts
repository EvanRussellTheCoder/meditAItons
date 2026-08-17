import type { ChatApiRequest, ChatApiResponse, ChatCitation } from '../models/chat.models';
import { logRoutingDecision, observeStage } from '../observability';
import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OpenAIEmbeddingClient,
  PineconeQueryMatch,
  PineconeRestClient,
  PineconeUploadError,
} from '../pinecone';
import { ConversationRouter } from '../routing';
import type { MeditationSchedulingGateway } from '../scheduling';
import { ChatEvidence, GroundedAnswerGateway } from './openai-grounded-answer';

const DEFAULT_TOP_K = 5;
const MAX_EVIDENCE_PARENTS = 4;
const INSUFFICIENT_EVIDENCE_MESSAGE =
  "I couldn't find a passage in this edition of Meditations that supports a reliable answer to " +
  'that question. I would rather leave the gap visible than invent Marcus’s view.';

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
    const recentUserMessages = request.history
      .filter((item) => item.author === 'user')
      .map((item) => item.content);
    const routing = await observeStage('selector', requestId, () =>
      this.dependencies.router.route({
        message: request.message,
        recentUserMessages,
      }),
    );
    logRoutingDecision({
      requestId,
      currentMessage: request.message,
      historyMessages: request.history.length,
      decision: routing,
    });
    if (!routing.retrieve) {
      if (routing.route === 'SCHEDULE') {
        const scheduling = await this.dependencies.scheduling.propose({
          message: request.message,
          history: request.history,
          timezone: request.timezone,
          ...(requestId ? { requestId } : {}),
        });
        return {
          route: routing.route,
          reason: routing.reason,
          message: scheduling.message,
          citations: [],
          schedulingProposal: scheduling.proposal,
        };
      }
      return {
        route: routing.route,
        reason: routing.reason,
        message: routing.userMessage,
        citations: [],
        schedulingProposal: null,
      };
    }

    const [queryVector] = await observeStage('embedding', requestId, () =>
      this.dependencies.embeddings.createEmbeddings([request.message]),
    );
    const matches = await observeStage('pinecone', requestId, () =>
      this.dependencies.pinecone.queryByVector(this.dependencies.namespace, queryVector, this.topK),
    );
    validateMatchEmbeddings(matches, this.dependencies.embeddingModel, OPENAI_EMBEDDING_DIMENSIONS);
    const evidence = createEvidence(matches);
    const answer = await observeStage('grounded_answer', requestId, () =>
      this.dependencies.answers.generate({
        message: request.message,
        history: request.history,
        evidence,
      }),
    );
    if (!answer.sufficientEvidence) {
      return {
        route: routing.route,
        reason: routing.reason,
        message: INSUFFICIENT_EVIDENCE_MESSAGE,
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
      message: answer.answer,
      citations,
      schedulingProposal: null,
    };
  }
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
