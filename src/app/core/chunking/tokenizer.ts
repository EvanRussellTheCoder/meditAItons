import { TokenCounter } from './types';

/**
 * Deterministic provider-neutral default. It counts Unicode word-like runs and
 * individual non-whitespace punctuation marks. Production ingestion can inject
 * its embedding model's counter without changing the chunking algorithm.
 */
export class UnicodeWordTokenCounter implements TokenCounter {
  count(text: string): number {
    return text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*|[^\s]/gu)?.length ?? 0;
  }
}

export const DEFAULT_TOKEN_COUNTER: TokenCounter = Object.freeze(new UnicodeWordTokenCounter());
