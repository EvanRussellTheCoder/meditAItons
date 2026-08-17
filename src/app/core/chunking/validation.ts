import { ChildChunk, ChunkingConfig, ChunkingError, ChunkingResult, ParentRecord } from './types';
import { CountTokens } from './segmentation';

export function validateParent(parent: ParentRecord): void {
  const parentId = typeof parent?.id === 'string' ? parent.id : undefined;
  if (!parentId?.trim()) {
    throw new ChunkingError('INVALID_PARENT', parentId, 'missing parent ID');
  }
  if (parent.type !== 'parent') {
    throw new ChunkingError('INVALID_PARENT', parentId, 'type must be "parent"');
  }
  if (!parent.canonical_ref?.trim()) {
    throw new ChunkingError('INVALID_PARENT', parentId, 'missing canonical reference');
  }
  if (!Number.isInteger(parent.book) || parent.book <= 0) {
    throw new ChunkingError('INVALID_PARENT', parentId, 'book must be a positive integer');
  }
  if (!Number.isInteger(parent.section) || parent.section <= 0) {
    throw new ChunkingError('INVALID_PARENT', parentId, 'section must be a positive integer');
  }
  if (typeof parent.text_search !== 'string' || !parent.text_search.trim()) {
    throw new ChunkingError('EMPTY_PARENT', parentId, 'text_search must not be empty');
  }
}

export function validateChunkingResult(
  parent: ParentRecord,
  result: ChunkingResult,
  config: Readonly<ChunkingConfig>,
  countTokens: CountTokens,
): void {
  const children = result.children;
  if (children.length === 0) {
    throw validationFailure(parent, 'at least one child is required');
  }
  if (result.parentId !== parent.id) {
    throw validationFailure(parent, 'result parentId does not match its parent');
  }

  const expectedParentTokens = countTokens(parent.text_search);
  if (result.parentTokenCount !== expectedParentTokens) {
    throw validationFailure(parent, 'stored parentTokenCount is inaccurate');
  }
  if (expectedParentTokens <= config.shortParentMaxTokens && children.length !== 1) {
    throw validationFailure(parent, 'a short parent must produce exactly one child');
  }

  const ids = new Set<string>();
  let previous: ChildChunk | undefined;

  for (const [zeroBasedIndex, child] of children.entries()) {
    const childIndex = zeroBasedIndex + 1;
    const expectedId = `${parent.id}-c${String(childIndex).padStart(2, '0')}`;
    if (ids.has(child.id)) {
      throw validationFailure(parent, `duplicate child ID ${child.id}`);
    }
    ids.add(child.id);

    if (
      child.id !== expectedId ||
      child.type !== 'child' ||
      child.parent_id !== parent.id ||
      child.canonical_ref !== parent.canonical_ref ||
      child.child_index !== childIndex
    ) {
      throw validationFailure(parent, `invalid identity metadata for child ${childIndex}`);
    }

    if (
      !Number.isInteger(child.start_char) ||
      !Number.isInteger(child.end_char) ||
      child.start_char < 0 ||
      child.start_char >= child.end_char ||
      child.end_char > parent.text_search.length
    ) {
      throw validationFailure(parent, `invalid offsets for child ${childIndex}`);
    }

    const sourceSlice = parent.text_search.slice(child.start_char, child.end_char);
    if (sourceSlice !== child.text_search) {
      throw validationFailure(parent, `child ${childIndex} is not an exact parent source slice`);
    }

    const actualTokens = countTokens(child.text_search);
    if (actualTokens !== child.token_count) {
      throw validationFailure(parent, `stored token count is inaccurate for child ${childIndex}`);
    }
    if (actualTokens > config.hardMaxTokens) {
      throw new ChunkingError(
        'HARD_MAX_EXCEEDED',
        parent.id,
        `child ${childIndex} has ${actualTokens} tokens`,
      );
    }

    if (!previous) {
      if (child.start_char !== 0) {
        throw validationFailure(parent, 'the first child must start at offset 0');
      }
    } else {
      if (
        child.start_char < previous.start_char ||
        child.start_char > previous.end_char ||
        child.end_char <= previous.end_char
      ) {
        throw validationFailure(
          parent,
          `child ${childIndex} is out of order, leaves a gap, or adds no new content`,
        );
      }

      const overlapTokens = countTokens(
        parent.text_search.slice(child.start_char, previous.end_char),
      );
      if (config.overlapStrategy === 'none' && overlapTokens > 0) {
        throw validationFailure(parent, `child ${childIndex} has unconfigured overlap`);
      }
      if (
        overlapTokens > config.maxOverlapTokens ||
        (overlapTokens > 0 && overlapTokens / child.token_count > config.maxOverlapRatio)
      ) {
        throw validationFailure(parent, `child ${childIndex} has excessive overlap`);
      }
    }

    previous = child;
  }

  if (children[children.length - 1].end_char !== parent.text_search.length) {
    throw validationFailure(parent, 'children do not cover the end of the parent');
  }
}

function validationFailure(parent: ParentRecord, reason: string): ChunkingError {
  return new ChunkingError('VALIDATION_FAILURE', parent.id, reason);
}
