import type {
  PipelineTraceOperation,
  PipelineTracePayload,
  PipelineTraceRecord,
  PipelineTracer,
} from '../src/app/core/observability';

const DEFAULT_LANGSMITH_PROJECT = 'meditaitons-local';
const MAX_TRACE_STRING_CHARACTERS = 12_000;
const MAX_TRACE_ARRAY_ITEMS = 50;
const MAX_TRACE_DEPTH = 8;
const SENSITIVE_FIELD_NAMES = new Set([
  'apikey',
  'authorization',
  'attendeeemail',
  'attendeename',
  'bookinguid',
]);

type Environment = Readonly<Record<string, string | undefined>>;

interface TraceResult<T> {
  readonly value: T;
}

export interface LangSmithClientLike {
  awaitPendingTraceBatches(): Promise<void>;
  cleanup(): void;
}

export interface LangSmithClientOptions {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly anonymizer: (values: Record<string, unknown>) => Record<string, unknown>;
}

export interface TraceableAdapterConfig<T> {
  readonly name: string;
  readonly run_type: string;
  readonly project_name: string;
  readonly tags: readonly string[];
  readonly metadata: PipelineTraceRecord;
  readonly tracingEnabled: boolean;
  readonly client: LangSmithClientLike;
  readonly processInputs: () => PipelineTraceRecord;
  readonly processOutputs: (outputs: Readonly<TraceResult<T>>) => PipelineTraceRecord;
}

export interface TraceableAdapter {
  <T>(
    work: (input: PipelineTraceRecord) => Promise<TraceResult<T>>,
    config: TraceableAdapterConfig<T>,
  ): (input: PipelineTraceRecord) => Promise<TraceResult<T>>;
}

export interface LangSmithRuntime {
  readonly client: LangSmithClientLike;
  readonly traceable: TraceableAdapter;
}

export type LangSmithRuntimeLoader = (options: LangSmithClientOptions) => Promise<LangSmithRuntime>;

export interface LangSmithObservability {
  readonly enabled: boolean;
  readonly captureContent: boolean;
  readonly project: string;
  readonly tracer?: PipelineTracer;
}

export async function createLangSmithObservability(
  environment: Environment = process.env,
  loadRuntime: LangSmithRuntimeLoader = loadLangSmithRuntime,
): Promise<LangSmithObservability> {
  const enabled = booleanEnvironmentValue(environment, 'LANGSMITH_TRACING', false);
  const captureContent = booleanEnvironmentValue(
    environment,
    'MEDITATIONS_LANGSMITH_CAPTURE_CONTENT',
    false,
  );
  const project = validateProjectName(
    environment['LANGSMITH_PROJECT']?.trim() || DEFAULT_LANGSMITH_PROJECT,
  );

  if (!enabled) {
    if (captureContent) {
      throw configurationError(
        'MEDITATIONS_LANGSMITH_CAPTURE_CONTENT requires LANGSMITH_TRACING=true',
      );
    }
    return { enabled: false, captureContent: false, project };
  }

  const apiKey = environment['LANGSMITH_API_KEY']?.trim();
  if (!apiKey || apiKey === 'replace-with-your-langsmith-api-key') {
    throw configurationError('LANGSMITH_API_KEY must be set when LANGSMITH_TRACING=true');
  }
  const apiUrl = optionalHttpsEndpoint(environment['LANGSMITH_ENDPOINT']);
  const runtime = await loadRuntime({
    apiKey,
    ...(apiUrl ? { apiUrl } : {}),
    anonymizer: redactTraceRecord,
  });
  return {
    enabled: true,
    captureContent,
    project,
    tracer: new LangSmithPipelineTracer(runtime, project, captureContent),
  };
}

class LangSmithPipelineTracer implements PipelineTracer {
  constructor(
    private readonly runtime: LangSmithRuntime,
    private readonly project: string,
    private readonly captureContent: boolean,
  ) {}

  async trace<T>(operation: PipelineTraceOperation<T>, work: () => T | Promise<T>): Promise<T> {
    let workPromise: Promise<T> | undefined;
    let applicationFailed = false;
    let applicationError: unknown;
    const runWorkOnce = (): Promise<T> => {
      workPromise ??= Promise.resolve().then(work);
      return workPromise;
    };
    const traced = this.runtime.traceable(
      async () => {
        try {
          return { value: await runWorkOnce() };
        } catch (error) {
          applicationFailed = true;
          applicationError = error;
          throw safeTraceError(operation.name, error);
        }
      },
      {
        name: operation.name,
        run_type: operation.runType ?? 'chain',
        project_name: this.project,
        tags: ['meditaitons', 'runtime-api', 'synthetic-development', ...(operation.tags ?? [])],
        metadata: redactTraceRecord({
          requestId: operation.requestId,
          captureContent: this.captureContent,
          ...operation.metadata,
        }),
        tracingEnabled: true,
        client: this.runtime.client,
        processInputs: () =>
          redactTraceRecord(selectPayload(operation.inputs, this.captureContent)),
        processOutputs: ({ value }) =>
          redactTraceRecord(selectPayload(operation.outputs?.(value), this.captureContent)),
      },
    );

    try {
      const result = await traced({});
      return result.value;
    } catch (error) {
      if (applicationFailed) {
        throw applicationError;
      }
      warnTracingFailure(operation.name);
      return runWorkOnce();
    }
  }

  async flush(): Promise<void> {
    try {
      await this.runtime.client.awaitPendingTraceBatches();
    } catch {
      warnTracingFailure('shutdown.flush');
    }
  }

  cleanup(): void {
    this.runtime.client.cleanup();
  }
}

function selectPayload(
  payload: PipelineTracePayload | undefined,
  captureContent: boolean,
): Record<string, unknown> {
  return {
    ...(payload?.safe ?? {}),
    ...(captureContent ? (payload?.content ?? {}) : {}),
  };
}

export function redactTraceRecord(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, redactTraceValue(value, key, 0)]),
  );
}

function redactTraceValue(value: unknown, key: string, depth: number): unknown {
  if (SENSITIVE_FIELD_NAMES.has(key.replace(/[^A-Z0-9]/giu, '').toLowerCase())) {
    return '[REDACTED]';
  }
  if (depth >= MAX_TRACE_DEPTH) {
    return '[MAX DEPTH]';
  }
  if (typeof value === 'string') {
    const redacted = value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[EMAIL REDACTED]')
      .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [SECRET REDACTED]')
      .replace(/\b(?:sk-|lsv2_[a-z]+_|pcsk_|cal_)[A-Z0-9_-]{8,}/giu, '[SECRET REDACTED]');
    return redacted.length <= MAX_TRACE_STRING_CHARACTERS
      ? redacted
      : `${redacted.slice(0, MAX_TRACE_STRING_CHARACTERS - 1)}…`;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_TRACE_ARRAY_ITEMS)
      .map((item) => redactTraceValue(item, '', depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        redactTraceValue(nestedValue, nestedKey, depth + 1),
      ]),
    );
  }
  return value;
}

function booleanEnvironmentValue(
  environment: Environment,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = environment[name]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw configurationError(`${name} must be true or false`);
}

function validateProjectName(value: string): string {
  if (value.length > 128 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw configurationError(
      'LANGSMITH_PROJECT must be 1-128 characters without control characters',
    );
  }
  return value;
}

function optionalHttpsEndpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw configurationError('LANGSMITH_ENDPOINT must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw configurationError(
      'LANGSMITH_ENDPOINT must be an HTTPS URL without credentials or query',
    );
  }
  return url.toString().replace(/\/+$/u, '');
}

function safeTraceError(operationName: string, error: unknown): Error {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
      ? error.name
      : 'UnknownError';
  const status = safeErrorNumber(error, 'status');
  const code = safeErrorString(error, 'code');
  return new Error(
    `Observed operation failed: name=${operationName}; errorName=${name}; status=${status}; code=${code}`,
  );
}

function safeErrorNumber(error: unknown, field: string): number {
  if (typeof error === 'object' && error !== null && field in error) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }
  }
  return 500;
}

function safeErrorString(error: unknown, field: string): string {
  if (typeof error === 'object' && error !== null && field in error) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(value)) {
      return value;
    }
  }
  return 'unknown';
}

function warnTracingFailure(operation: string): void {
  console.warn(
    `[langsmith] ${JSON.stringify({
      event: 'trace.delivery.warning',
      operation,
      applicationBehaviorPreserved: true,
    })}`,
  );
}

function configurationError(reason: string): Error {
  return new Error(`LangSmithConfigurationError: reason=${reason}`);
}

async function loadLangSmithRuntime(options: LangSmithClientOptions): Promise<LangSmithRuntime> {
  const [{ Client }, { traceable }] = await Promise.all([
    import('langsmith'),
    import('langsmith/traceable'),
  ]);
  return {
    client: new Client(options),
    traceable: traceable as unknown as TraceableAdapter,
  };
}
