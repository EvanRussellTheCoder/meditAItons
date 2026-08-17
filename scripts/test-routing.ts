import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { ROUTING_EVALUATION_CASES } from '../src/app/core/routing/edge-cases';
import {
  ConversationRouter,
  DEFAULT_OPENAI_MODERATION_MODEL,
  DEFAULT_OPENAI_ROUTER_MODEL,
  OpenAIModerationClient,
  OpenAIScopeClassifier,
} from '../src/app/core/routing';

const ROUTING_CONCURRENCY = 4;

async function main(): Promise<void> {
  loadLocalEnvironment();
  const apiKey = requiredEnvironmentValue('OPENAI_API_KEY');
  const routerModel = process.env['OPENAI_ROUTER_MODEL']?.trim() || DEFAULT_OPENAI_ROUTER_MODEL;
  const moderationModel =
    process.env['OPENAI_MODERATION_MODEL']?.trim() || DEFAULT_OPENAI_MODERATION_MODEL;
  const shared = { apiKey, baseUrl: process.env['OPENAI_BASE_URL'] };
  const router = new ConversationRouter({
    moderation: new OpenAIModerationClient({ ...shared, model: moderationModel }),
    classifier: new OpenAIScopeClassifier({ ...shared, model: routerModel }),
  });

  const decisions = await mapWithConcurrency(
    ROUTING_EVALUATION_CASES,
    ROUTING_CONCURRENCY,
    async (testCase) => router.route({ message: testCase.prompt }),
  );

  let failures = 0;
  for (const [index, testCase] of ROUTING_EVALUATION_CASES.entries()) {
    const decision = decisions[index];
    const routeMatches = decision.route === testCase.expectedRoute;
    const sourceMatches =
      testCase.expectedSource === undefined || decision.source === testCase.expectedSource;
    const retrievalMatches = decision.retrieve === (testCase.expectedRoute === 'IN_SCOPE');
    const passed = routeMatches && sourceMatches && retrievalMatches;
    if (!passed) {
      failures += 1;
    }
    const prompt = testCase.prompt.replace(/\s+/gu, ' ').trim();
    console.log(
      `${passed ? 'PASS' : 'FAIL'} ${testCase.id}: expected ${testCase.expectedRoute}; ` +
        `received ${decision.route} (${decision.source}/${decision.reason}); ` +
        `retrieve=${decision.retrieve}; prompt=${JSON.stringify(truncate(prompt, 100))}`,
    );
  }

  console.log(
    `\n${ROUTING_EVALUATION_CASES.length - failures}/${ROUTING_EVALUATION_CASES.length} ` +
      `routing cases passed (router ${routerModel}; moderation ${moderationModel}).`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
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

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
