import { ChildChunk } from '../chunking';
import { IngestedParentRecord } from '../ingestion';

export interface PineconeTextRecord {
  readonly _id: string;
  readonly chunk_text: string;
  readonly record_type: 'child';
  readonly parent_id: string;
  readonly parent_text: string;
  readonly parent_content_hash: string;
  readonly canonical_ref: string;
  readonly book: number;
  readonly section: number;
  readonly child_index: number;
  readonly start_char: number;
  readonly end_char: number;
  readonly token_count: number;
  readonly work: string;
  readonly edition_id: string;
  readonly translator: string;
  readonly translation_year: number;
  readonly source_url: string;
  readonly source_page_title: string;
  readonly source_page_id: number;
  readonly source_revision_id: number;
}

export type PineconeRecordMetadata = Omit<PineconeTextRecord, '_id'> & {
  readonly embedding_model: string;
  readonly embedding_dimensions: number;
};

export interface PineconeVectorRecord {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata: PineconeRecordMetadata;
}

export interface PineconeDataset {
  readonly parents: readonly IngestedParentRecord[];
  readonly children: readonly ChildChunk[];
}

export interface PineconeClientConfig {
  readonly apiKey: string;
  readonly indexHost: string;
  readonly indexName?: string;
  readonly apiVersion?: string;
  readonly fetchImplementation?: typeof fetch;
}

export interface PineconeIndexDescription {
  readonly name: string;
  readonly host: string;
  readonly ready: boolean;
  readonly vectorType: string;
  readonly dimension: number;
  readonly metric: string;
  readonly integratedEmbedding: boolean;
  readonly embeddingModel?: string;
  readonly textField?: string;
}

export interface PineconeNamespaceDescription {
  readonly name: string;
  readonly recordCount: number;
}

export interface PineconeFetchedRecord {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PineconeQueryMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type PineconeUploadErrorCode =
  | 'INVALID_LOCAL_DATA'
  | 'INVALID_CONFIGURATION'
  | 'INDEX_NOT_READY'
  | 'INDEX_MISMATCH'
  | 'EMBEDDING_REQUEST_FAILED'
  | 'REMOTE_REQUEST_FAILED'
  | 'VERIFICATION_FAILED';

export class PineconeUploadError extends Error {
  constructor(
    readonly code: PineconeUploadErrorCode,
    reason: string,
    readonly httpStatus?: number,
  ) {
    super(`PineconeUploadError: reason=${reason}`);
    this.name = 'PineconeUploadError';
  }
}
