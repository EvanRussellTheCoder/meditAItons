import { existsSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import process from 'node:process';

import {
  DEFAULT_OPENAI_CHAT_MODEL,
  MeditationsChatService,
  OpenAIGroundedAnswerClient,
} from '../src/app/core/chat';
import type {
  ChatApiRequest,
  ChatHistoryMessage,
  MeditationScheduleConfirmation,
} from '../src/app/core/models/chat.models';
import {
  logRequestCompleted,
  logRequestStarted,
  observeStage,
  requestIdFromHeader,
} from '../src/app/core/observability';
import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  OPENAI_EMBEDDING_DIMENSIONS,
  OpenAIEmbeddingClient,
  PineconeRestClient,
} from '../src/app/core/pinecone';
import {
  ConversationRouter,
  DEFAULT_OPENAI_MODERATION_MODEL,
  DEFAULT_OPENAI_ROUTER_MODEL,
  OpenAIModerationClient,
  OpenAIScopeClassifier,
} from '../src/app/core/routing';
import {
  CalComClient,
  MeditationScheduler,
  OpenAISchedulingExtractor,
  SchedulingOperationError,
  validTimezone,
} from '../src/app/core/scheduling';

const DEFAULT_API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 3_000;
const DEFAULT_NAMESPACE = 'long-1862';
const MAX_BODY_BYTES = 32 * 1_024;
const MAX_MESSAGE_CHARACTERS = 600;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARACTERS = 2_400;
const MAX_CONCURRENT_REQUESTS = 6;
const ALLOWED_ORIGINS = new Set(['http://localhost:4200', 'http://127.0.0.1:4200']);

async function main(): Promise<void> {
  loadLocalEnvironment();
  const apiKey = requiredEnvironmentValue('OPENAI_API_KEY');
  const baseUrl = process.env['OPENAI_BASE_URL'];
  const embeddingModel =
    process.env['OPENAI_EMBEDDING_MODEL']?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;
  const routerModel = process.env['OPENAI_ROUTER_MODEL']?.trim() || DEFAULT_OPENAI_ROUTER_MODEL;
  const calendar = new CalComClient({
    apiKey: requiredEnvironmentValue('CAL_API_KEY'),
    eventTypeId: requiredPositiveIntegerEnvironmentValue('CAL_EVENT_TYPE_ID'),
  });
  await observeStage('cal.com.preflight', 'startup', () => calendar.initialize());
  const scheduling = new MeditationScheduler({
    extraction: new OpenAISchedulingExtractor({ apiKey, baseUrl, model: routerModel }),
    calendar,
  });
  const service = new MeditationsChatService({
    router: new ConversationRouter({
      moderation: new OpenAIModerationClient({
        apiKey,
        baseUrl,
        model: process.env['OPENAI_MODERATION_MODEL']?.trim() || DEFAULT_OPENAI_MODERATION_MODEL,
      }),
      classifier: new OpenAIScopeClassifier({
        apiKey,
        baseUrl,
        model: routerModel,
      }),
    }),
    embeddings: new OpenAIEmbeddingClient({
      apiKey,
      baseUrl,
      model: embeddingModel,
      dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    }),
    pinecone: new PineconeRestClient({
      apiKey: requiredEnvironmentValue('PINECONE_API_KEY'),
      indexHost: requiredEnvironmentValue('PINECONE_INDEX_HOST'),
      indexName: requiredEnvironmentValue('PINECONE_INDEX'),
    }),
    answers: new OpenAIGroundedAnswerClient({
      apiKey,
      baseUrl,
      model: process.env['OPENAI_CHAT_MODEL']?.trim() || DEFAULT_OPENAI_CHAT_MODEL,
    }),
    scheduling,
    namespace: process.env['PINECONE_NAMESPACE']?.trim() || DEFAULT_NAMESPACE,
    embeddingModel,
  });
  await observeStage('pinecone.preflight', 'startup', () => service.initialize());

  const host = process.env['MEDITATIONS_API_HOST']?.trim() || DEFAULT_API_HOST;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('MEDITATIONS_API_HOST must remain loopback-only (127.0.0.1 or localhost)');
  }
  const port = parsePort(process.env['MEDITATIONS_API_PORT']);
  let inFlight = 0;
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    const requestId = requestIdFromHeader(request.headers['x-request-id']);
    response.setHeader('X-Request-Id', requestId);
    const startedAt = Date.now();
    let path = request.url ?? '/';
    let trackedRequest = false;
    let completionErrorCode: string | undefined;
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      path = url.pathname;
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      const isChatRequest = request.method === 'POST' && url.pathname === '/api/chat';
      const isScheduleRequest = request.method === 'POST' && url.pathname === '/api/schedule';
      trackedRequest = isChatRequest || isScheduleRequest;
      if (trackedRequest) {
        logRequestStarted({
          requestId,
          method: request.method ?? 'UNKNOWN',
          path,
        });
      }
      if (!isChatRequest && !isScheduleRequest) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      if (!originAllowed(request)) {
        sendJson(response, 403, { error: 'Origin is not allowed.' });
        return;
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        sendJson(response, 415, { error: 'Content-Type must be application/json.' });
        return;
      }
      if (inFlight >= MAX_CONCURRENT_REQUESTS) {
        response.setHeader('Retry-After', '2');
        sendJson(response, 429, { error: 'The local chat service is busy. Try again shortly.' });
        return;
      }

      inFlight += 1;
      try {
        const requestBody = await readJsonBody(request);
        if (isChatRequest) {
          sendJson(
            response,
            200,
            await service.respond(validateChatRequest(requestBody), requestId),
          );
        } else {
          sendJson(
            response,
            200,
            await scheduling.confirm(validateScheduleRequest(requestBody), requestId),
          );
        }
      } finally {
        inFlight -= 1;
      }
    } catch (error) {
      const clientError = error instanceof ClientRequestError;
      const schedulingError = error instanceof SchedulingOperationError;
      completionErrorCode = schedulingError
        ? error.code
        : clientError
          ? 'invalid_request'
          : 'internal_error';
      if (!clientError && !schedulingError) {
        console.error(
          `[request-error] ${JSON.stringify({
            requestId,
            errorName: error instanceof Error ? error.name : typeof error,
          })}`,
        );
      }
      sendJson(
        response,
        clientError ? error.status : schedulingError ? error.status : 500,
        clientError
          ? { error: error.message }
          : schedulingError
            ? {
                success: false,
                code: error.code,
                error: error.message,
                retryable: error.retryable,
              }
            : { error: 'The private Meditations service could not complete the request.' },
      );
    } finally {
      if (trackedRequest) {
        logRequestCompleted({
          requestId,
          method: request.method ?? 'UNKNOWN',
          path,
          status: response.statusCode,
          durationMs: Date.now() - startedAt,
          ...(completionErrorCode ? { errorCode: completionErrorCode } : {}),
        });
      }
    }
  });

  server.listen(port, host, () => {
    console.log(`Meditations API ready at http://${host}:${port}`);
    console.info(
      `[startup] ${JSON.stringify(
        {
          apiUrl: `http://${host}:${port}`,
          namespace: process.env['PINECONE_NAMESPACE']?.trim() || DEFAULT_NAMESPACE,
          embeddingModel,
          routerModel,
          answerModel: process.env['OPENAI_CHAT_MODEL']?.trim() || DEFAULT_OPENAI_CHAT_MODEL,
          moderationModel:
            process.env['OPENAI_MODERATION_MODEL']?.trim() || DEFAULT_OPENAI_MODERATION_MODEL,
          schedulingEnabled: true,
          meditationDurationMinutes: calendar.durationMinutes,
          calendarWriteRequiresConfirmation: true,
        },
        null,
        2,
      )}`,
    );
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function validateChatRequest(value: unknown): ChatApiRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClientRequestError(400, 'Request body must be an object.');
  }
  const record = value as Record<string, unknown>;
  const message = record['message'];
  const history = record['history'];
  if (
    typeof message !== 'string' ||
    !message.trim() ||
    message.trim().length > MAX_MESSAGE_CHARACTERS
  ) {
    throw new ClientRequestError(
      400,
      `message must contain 1-${MAX_MESSAGE_CHARACTERS} characters.`,
    );
  }
  if (!Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES) {
    throw new ClientRequestError(
      400,
      `history must contain at most ${MAX_HISTORY_MESSAGES} messages.`,
    );
  }
  return {
    message: message.trim(),
    history: history.map(validateHistoryMessage),
    timezone: validateTimezone(record['timezone']),
  };
}

function validateScheduleRequest(value: unknown): MeditationScheduleConfirmation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClientRequestError(400, 'Scheduling request body must be an object.');
  }
  const record = value as Record<string, unknown>;
  const fields = [
    'proposalId',
    'date',
    'time',
    'timezone',
    'attendeeName',
    'attendeeEmail',
  ] as const;
  for (const field of fields) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      throw new ClientRequestError(400, `Scheduling ${field} must be a non-empty string.`);
    }
  }
  return {
    proposalId: (record['proposalId'] as string).trim(),
    date: (record['date'] as string).trim(),
    time: (record['time'] as string).trim(),
    timezone: (record['timezone'] as string).trim(),
    attendeeName: (record['attendeeName'] as string).trim(),
    attendeeEmail: (record['attendeeEmail'] as string).trim(),
  };
}

function validateTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !validTimezone(value)) {
    throw new ClientRequestError(400, 'timezone must be a valid IANA timezone.');
  }
  return value;
}

function validateHistoryMessage(value: unknown): ChatHistoryMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClientRequestError(400, 'Each history item must be an object.');
  }
  const record = value as Record<string, unknown>;
  const author = record['author'];
  const content = record['content'];
  if (
    (author !== 'user' && author !== 'marcus') ||
    typeof content !== 'string' ||
    !content.trim() ||
    content.trim().length > MAX_HISTORY_MESSAGE_CHARACTERS
  ) {
    throw new ClientRequestError(400, 'History contains an invalid message.');
  }
  return { author, content: content.trim() };
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejectBody(new ClientRequestError(413, 'Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        rejectBody(new ClientRequestError(400, 'Request body must be valid JSON.'));
      }
    });
    request.on('error', rejectBody);
  });
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return origin === undefined || ALLOWED_ORIGINS.has(origin);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function loadLocalEnvironment(): void {
  const environmentPath = resolve('.env');
  if (existsSync(environmentPath)) {
    process.loadEnvFile(environmentPath);
  }
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set in .env or the process environment`);
  }
  return value;
}

function requiredPositiveIntegerEnvironmentValue(name: string): number {
  const value = Number(requiredEnvironmentValue(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  const port = value?.trim() ? Number(value) : DEFAULT_API_PORT;
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('MEDITATIONS_API_PORT must be an integer from 1024 to 65535');
  }
  return port;
}

class ClientRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ClientRequestError';
  }
}

void main().catch((error: unknown) => {
  console.error(
    `[startup-error] ${JSON.stringify({
      errorName: error instanceof Error ? error.name : typeof error,
    })}`,
  );
  process.exitCode = 1;
});
