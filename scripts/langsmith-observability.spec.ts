import { describe, expect, it, vi } from 'vitest';

import type { PipelineTraceOperation } from '../src/app/core/observability';
import {
  createLangSmithObservability,
  LangSmithClientLike,
  LangSmithClientOptions,
  LangSmithRuntimeLoader,
  redactTraceRecord,
  TraceableAdapter,
  TraceableAdapterConfig,
} from './langsmith-observability';

describe('LangSmith observability adapter', () => {
  it('stays disabled without importing the runtime or requiring an API key', async () => {
    const loadRuntime = vi.fn<LangSmithRuntimeLoader>();

    await expect(createLangSmithObservability({}, loadRuntime)).resolves.toEqual({
      enabled: false,
      captureContent: false,
      project: 'meditaitons-local',
    });
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  it('rejects invalid or unsafe opt-in configuration', async () => {
    const loadRuntime = vi.fn<LangSmithRuntimeLoader>();

    await expect(
      createLangSmithObservability({ LANGSMITH_TRACING: 'sometimes' }, loadRuntime),
    ).rejects.toThrowError(/LANGSMITH_TRACING must be true or false/u);
    await expect(
      createLangSmithObservability({ MEDITATIONS_LANGSMITH_CAPTURE_CONTENT: 'true' }, loadRuntime),
    ).rejects.toThrowError(/requires LANGSMITH_TRACING=true/u);
    await expect(
      createLangSmithObservability({ LANGSMITH_TRACING: 'true' }, loadRuntime),
    ).rejects.toThrowError(/LANGSMITH_API_KEY must be set/u);
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  it('projects bounded structural data while content capture is disabled', async () => {
    const harness = runtimeHarness();
    const observability = await createLangSmithObservability(
      {
        LANGSMITH_TRACING: 'true',
        LANGSMITH_API_KEY: 'test-langsmith-key',
        LANGSMITH_PROJECT: 'meditaitons-test',
      },
      harness.loadRuntime,
    );
    const operation: PipelineTraceOperation<readonly (readonly number[])[]> = {
      name: 'embedding',
      requestId: 'request-123',
      runType: 'embedding',
      inputs: {
        safe: { inputCount: 1 },
        content: { texts: ['private synthetic prompt'] },
      },
      outputs: (vectors) => ({
        safe: { vectorCount: vectors.length, dimensions: vectors[0]?.length ?? 0 },
        content: { vectors },
      }),
    };

    const result = await observability.tracer?.trace(operation, async () => [[0.1, 0.2, 0.3]]);

    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(harness.config?.processInputs()).toEqual({ inputCount: 1 });
    expect(harness.config?.processOutputs({ value: result ?? [] })).toEqual({
      vectorCount: 1,
      dimensions: 3,
    });
    expect(JSON.stringify(harness.config)).not.toContain('test-langsmith-key');
  });

  it('allows synthetic content but redacts identity, secrets, and prohibited fields', async () => {
    const harness = runtimeHarness();
    const observability = await createLangSmithObservability(
      {
        LANGSMITH_TRACING: 'true',
        LANGSMITH_API_KEY: 'test-langsmith-key',
        MEDITATIONS_LANGSMITH_CAPTURE_CONTENT: 'true',
      },
      harness.loadRuntime,
    );
    const operation: PipelineTraceOperation<{ readonly message: string }> = {
      name: 'meditaitons.schedule_confirmation',
      requestId: 'request-123',
      inputs: {
        safe: {
          attendeeNameProvided: true,
          attendeeEmailProvided: true,
        },
        content: {
          note: 'Synthetic note for person@example.com using sk-secretvalue12345',
        },
      },
      outputs: () => ({
        safe: { bookingUidPresent: true },
        content: { bookingUid: 'booking-secret', attendeeEmail: 'person@example.com' },
      }),
    };

    await observability.tracer?.trace(operation, async () => ({ message: 'scheduled' }));

    const input = harness.config?.processInputs();
    const output = harness.config?.processOutputs({ value: { message: 'scheduled' } });
    expect(input).toMatchObject({
      attendeeNameProvided: true,
      attendeeEmailProvided: true,
      note: 'Synthetic note for [EMAIL REDACTED] using [SECRET REDACTED]',
    });
    expect(output).toEqual({
      bookingUidPresent: true,
      bookingUid: '[REDACTED]',
      attendeeEmail: '[REDACTED]',
    });
  });

  it('preserves original errors and fails open when instrumentation cannot start', async () => {
    const original = Object.assign(new Error('provider body with a secret'), {
      status: 503,
      code: 'provider_unavailable',
    });
    const normalHarness = runtimeHarness();
    const normal = await createLangSmithObservability(
      { LANGSMITH_TRACING: 'true', LANGSMITH_API_KEY: 'test-key' },
      normalHarness.loadRuntime,
    );

    await expect(
      normal.tracer?.trace(operation(), async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    const failingHarness = runtimeHarness(true);
    const failing = await createLangSmithObservability(
      { LANGSMITH_TRACING: 'true', LANGSMITH_API_KEY: 'test-key' },
      failingHarness.loadRuntime,
    );
    const work = vi.fn(async () => 'application-result');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(failing.tracer?.trace(operation(), work)).resolves.toBe('application-result');
    expect(work).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('applicationBehaviorPreserved'));
  });

  it('redacts nested sensitive values defensively', () => {
    expect(
      redactTraceRecord({
        authorization: 'Bearer raw-token',
        nested: { apiKey: 'secret', message: 'Email me at person@example.com' },
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', message: 'Email me at [EMAIL REDACTED]' },
    });
  });
});

function operation(): PipelineTraceOperation<string> {
  return { name: 'selector', requestId: 'request-123' };
}

function runtimeHarness(failBeforeWork = false): {
  readonly loadRuntime: LangSmithRuntimeLoader;
  config?: TraceableAdapterConfig<unknown>;
} {
  const harness: {
    loadRuntime: LangSmithRuntimeLoader;
    config?: TraceableAdapterConfig<unknown>;
  } = {
    loadRuntime: async (options: LangSmithClientOptions) => {
      const client: LangSmithClientLike = {
        awaitPendingTraceBatches: vi.fn(async () => undefined),
        cleanup: vi.fn(() => undefined),
      };
      const traceable: TraceableAdapter = <T>(
        work: (input: Readonly<Record<string, unknown>>) => Promise<{ readonly value: T }>,
        config: TraceableAdapterConfig<T>,
      ) => {
        harness.config = config as TraceableAdapterConfig<unknown>;
        return failBeforeWork
          ? async () => {
              throw new Error('trace transport failed');
            }
          : work;
      };
      options.anonymizer({ apiKey: options.apiKey });
      return { client, traceable };
    },
  };
  return harness;
}
