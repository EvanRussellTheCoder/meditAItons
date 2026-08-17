import { ChunkingConfig, ChunkingError } from './types';

/** Increment this when default boundary-generating behavior changes. */
export const CHUNKING_VERSION = 'parent-child-v1';

/** All size and overlap policy values live here so callers can replace them. */
export const CHUNKING_CONFIG: Readonly<ChunkingConfig> = Object.freeze({
  shortParentMaxTokens: 180,
  mediumParentMaxTokens: 400,
  mediumTargetMinTokens: 120,
  mediumTargetMaxTokens: 180,
  longTargetMinTokens: 150,
  longTargetMaxTokens: 220,
  hardMaxTokens: 260,
  minimumDesirableChildTokens: 60,
  overlapStrategy: 'previous_sentence',
  maxOverlapTokens: 80,
  maxOverlapRatio: 0.4,
  sentenceLocale: 'en',
});

export function resolveChunkingConfig(
  overrides: Partial<ChunkingConfig> | undefined,
  parentId?: string,
): Readonly<ChunkingConfig> {
  const config: ChunkingConfig = { ...CHUNKING_CONFIG, ...overrides };
  validateConfig(config, parentId);
  return Object.freeze(config);
}

function validateConfig(config: ChunkingConfig, parentId?: string): void {
  const positiveIntegers: ReadonlyArray<keyof ChunkingConfig> = [
    'shortParentMaxTokens',
    'mediumParentMaxTokens',
    'mediumTargetMinTokens',
    'mediumTargetMaxTokens',
    'longTargetMinTokens',
    'longTargetMaxTokens',
    'hardMaxTokens',
    'minimumDesirableChildTokens',
  ];

  for (const key of positiveIntegers) {
    const value = config[key];
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new ChunkingError('INVALID_CONFIG', parentId, `${key} must be a positive integer`);
    }
  }

  if (config.mediumParentMaxTokens <= config.shortParentMaxTokens) {
    throw new ChunkingError(
      'INVALID_CONFIG',
      parentId,
      'mediumParentMaxTokens must exceed shortParentMaxTokens',
    );
  }

  if (
    config.mediumTargetMinTokens > config.mediumTargetMaxTokens ||
    config.longTargetMinTokens > config.longTargetMaxTokens
  ) {
    throw new ChunkingError(
      'INVALID_CONFIG',
      parentId,
      'each target minimum must be less than or equal to its target maximum',
    );
  }

  if (
    config.mediumTargetMaxTokens > config.hardMaxTokens ||
    config.longTargetMaxTokens > config.hardMaxTokens ||
    config.minimumDesirableChildTokens > config.hardMaxTokens
  ) {
    throw new ChunkingError(
      'INVALID_CONFIG',
      parentId,
      'target and minimum desirable sizes must not exceed hardMaxTokens',
    );
  }

  if (!Number.isInteger(config.maxOverlapTokens) || config.maxOverlapTokens < 0) {
    throw new ChunkingError(
      'INVALID_CONFIG',
      parentId,
      'maxOverlapTokens must be a non-negative integer',
    );
  }

  if (config.maxOverlapTokens > config.hardMaxTokens) {
    throw new ChunkingError(
      'INVALID_CONFIG',
      parentId,
      'maxOverlapTokens must not exceed hardMaxTokens',
    );
  }

  if (!(config.maxOverlapRatio >= 0 && config.maxOverlapRatio < 0.5)) {
    throw new ChunkingError(
      'INVALID_CONFIG',
      parentId,
      'maxOverlapRatio must be at least 0 and less than 0.5',
    );
  }

  if (!['none', 'previous_sentence'].includes(config.overlapStrategy)) {
    throw new ChunkingError(
      'INVALID_CONFIG',
      parentId,
      `unsupported overlap strategy: ${String(config.overlapStrategy)}`,
    );
  }

  if (!config.sentenceLocale.trim()) {
    throw new ChunkingError('INVALID_CONFIG', parentId, 'sentenceLocale must not be empty');
  }
}
