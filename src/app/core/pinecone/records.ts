import { ChildChunk } from '../chunking';
import { IngestedParentRecord } from '../ingestion';
import { PineconeTextRecord, PineconeUploadError, PineconeVectorRecord } from './types';

export const PINECONE_TEXT_BATCH_SIZE = 96;
export const PINECONE_METADATA_MAX_BYTES = 40 * 1_024;

/**
 * Plain-English pseudocode for retrieval metadata:
 * 1. Join each child to its canonical parent and reject broken references.
 * 2. Make the child's exact text the searchable field.
 * 3. Copy the full parent, citation identity, offsets, edition, and source provenance into metadata.
 * 4. Reject records that exceed the conservative Pinecone metadata-size limit.
 */
export function createPineconeRecords(
  parents: readonly IngestedParentRecord[],
  children: readonly ChildChunk[],
): readonly PineconeTextRecord[] {
  if (parents.length === 0 || children.length === 0) {
    throw invalidData('parent and child datasets must both be non-empty');
  }

  const parentsById = new Map<string, IngestedParentRecord>();
  for (const parent of parents) {
    if (parentsById.has(parent.id)) {
      throw invalidData(`duplicate parent ID ${parent.id}`);
    }
    parentsById.set(parent.id, parent);
  }

  const childIds = new Set<string>();
  return children.map((child) => {
    if (childIds.has(child.id)) {
      throw invalidData(`duplicate child ID ${child.id}`);
    }
    childIds.add(child.id);

    const parent = parentsById.get(child.parent_id);
    if (!parent) {
      throw invalidData(`child ${child.id} references unknown parent ${child.parent_id}`);
    }
    if (
      child.canonical_ref !== parent.canonical_ref ||
      parent.text_search.slice(child.start_char, child.end_char) !== child.text_search
    ) {
      throw invalidData(`child ${child.id} is not traceable to its canonical parent`);
    }
    if (!parent.source?.url || !parent.source.page_title) {
      throw invalidData(`parent ${parent.id} is missing source provenance`);
    }

    const record: PineconeTextRecord = {
      _id: child.id,
      chunk_text: child.text_search,
      record_type: 'child',
      parent_id: parent.id,
      parent_text: parent.text_search,
      parent_content_hash: parent.content_hash,
      canonical_ref: parent.canonical_ref,
      book: parent.book,
      section: parent.section,
      child_index: child.child_index,
      start_char: child.start_char,
      end_char: child.end_char,
      token_count: child.token_count,
      work: parent.work,
      edition_id: parent.edition.edition_id,
      translator: parent.edition.translator,
      translation_year: parent.edition.year,
      source_url: parent.source.url,
      source_page_title: parent.source.page_title,
      source_page_id: parent.source.page_id,
      source_revision_id: parent.source.revision_id,
    };

    const serializedBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (serializedBytes > PINECONE_METADATA_MAX_BYTES) {
      throw invalidData(
        `record ${record._id} is ${serializedBytes} bytes and exceeds the conservative Pinecone metadata limit`,
      );
    }
    return record;
  });
}

export function batchPineconeRecords<T>(
  records: readonly T[],
  batchSize = PINECONE_TEXT_BATCH_SIZE,
): readonly (readonly T[])[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw invalidData('batch size must be a positive integer');
  }

  const batches: T[][] = [];
  for (let start = 0; start < records.length; start += batchSize) {
    batches.push(records.slice(start, start + batchSize));
  }
  return batches;
}

export function createPineconeVectorRecords(
  records: readonly PineconeTextRecord[],
  embeddings: readonly (readonly number[])[],
  embeddingModel: string,
  embeddingDimensions: number,
): readonly PineconeVectorRecord[] {
  if (records.length !== embeddings.length) {
    throw invalidData(
      `embedding count ${embeddings.length} does not match record count ${records.length}`,
    );
  }
  if (!embeddingModel.trim()) {
    throw invalidData('embedding model must not be empty');
  }
  if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    throw invalidData('embedding dimensions must be a positive integer');
  }

  return records.map((record, index) => {
    const values = embeddings[index];
    if (
      values.length !== embeddingDimensions ||
      values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw invalidData(
        `embedding for ${record._id} must contain ${embeddingDimensions} finite numbers`,
      );
    }
    const { _id, ...recordMetadata } = record;
    return {
      id: _id,
      values,
      metadata: {
        ...recordMetadata,
        embedding_model: embeddingModel,
        embedding_dimensions: embeddingDimensions,
      },
    };
  });
}

function invalidData(reason: string): PineconeUploadError {
  return new PineconeUploadError('INVALID_LOCAL_DATA', reason);
}
