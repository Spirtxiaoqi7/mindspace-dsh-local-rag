export type SearchScope = 'conversation_summary' | 'knowledge' | 'both'

export type DocumentScope = Exclude<SearchScope, 'both'>
export type RetrievalLane = 'vector' | 'lexical'

/** One authority vocabulary shared by conversation summaries and imported files. */
export interface SourceAuthority {
  /** Stable producer kind, for example conversation_summary, pdf, csv, or md. */
  kind: string
  fileName?: string
  documentTitle?: string
  author?: string
  url?: string
  source?: string
  titlePage?: {
    pageNumber: number
    title?: string
    text: string
  }
}

/** Exact source coordinates retained from ingestion through every returned hit. */
export interface SourceLocator {
  pageNumber?: number
  pageEnd?: number
  paragraphNumber?: number
  paragraphEnd?: number
  rowNumber?: number
  rowEnd?: number
  lineStart?: number
  lineEnd?: number
  heading?: string
  header?: readonly string[]
  /** Conversation-summary time and event range. */
  summaryAt?: number
  turn?: number
  seqStart?: number
  seqEnd?: number
}

/** An ingestion-defined boundary that chunking must never join to another unit. */
export interface SourceDocumentUnit {
  id: string
  order: number
  text: string
  authority?: SourceAuthority
  locator: SourceLocator
}

export interface SourceDocument {
  id: string
  title: string
  text: string
  scope: DocumentScope
  sessionId?: string
  /** Stable opaque ID for a locally archived original file, when one exists. */
  sourceId?: string
  /** Safe plugin URI for the archived original; never an operating-system path. */
  sourceUri?: string
  source?: string
  authority?: SourceAuthority
  locator?: SourceLocator
  units?: readonly SourceDocumentUnit[]
  updatedAt: number
}

export interface IndexedParent {
  id: string
  documentId: string
  title: string
  text: string
  scope: DocumentScope
  sessionId?: string
  sourceId?: string
  sourceUri?: string
  source?: string
  authority: SourceAuthority
  locator: SourceLocator
  updatedAt: number
}

export interface IndexedChild {
  id: string
  parentId: string
  documentId: string
  text: string
  /** Empty means the lexical record is valid but no current-model vector exists. */
  embedding: number[]
}

export interface LaneEvidence {
  lane: RetrievalLane
  rank: number
  score: number
}

export interface LocalRagHit {
  parentId: string
  documentId: string
  title: string
  text: string
  matchedText: string
  scope: DocumentScope
  sourceId?: string
  sourceUri?: string
  source?: string
  authority: SourceAuthority
  locator: SourceLocator
  updatedAt: number
  rrfScore: number
  evidence: LaneEvidence[]
}

export interface SearchLocalMemoryRequest {
  query: string
  scope?: SearchScope
  sessionId?: string
  /** Hard-filter to one indexed document for evidence refinement. */
  documentId?: string
  /** Hard-filter to one archived source file for evidence refinement. */
  sourceId?: string
}

export type RetrievalLaneState = 'complete' | 'empty' | 'unavailable' | 'stale_model' | 'timeout' | 'error'

export interface RetrievalLaneStatus {
  lane: RetrievalLane
  state: RetrievalLaneState
  candidates: number
  detail?: string
}

export interface SearchLocalMemoryResult {
  query: string
  scope: SearchScope
  hits: readonly LocalRagHit[]
  vectorCandidates: number
  lexicalCandidates: number
  modelId: string
  laneStatus: Record<RetrievalLane, RetrievalLaneStatus>
  /** True when one lane could not complete but another lane still returned a valid answer. */
  partial: boolean
}

export interface EmbeddingProvider {
  readonly modelId: string
  readonly dimensions: number
  ready(): Promise<boolean>
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>
}

export interface RetrievalConfig {
  vectorCandidates: number
  lexicalCandidates: number
  resultLimit: number
  rrfK: number
  parentCharacters: number
  /** Soft child target. Chunking seeks the first sentence end at or after it. */
  childCharacters: number
  /** Hard Unicode-character ceiling for one child. */
  childMaxCharacters?: number
  /** Maximum consecutive children returned through one parent. */
  childrenPerParent?: number
  /** Deprecated compatibility field. Sentence-aware chunking never overlaps. */
  childOverlap: number
  vectorTimeoutMs?: number
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  vectorCandidates: 5,
  lexicalCandidates: 5,
  resultLimit: 5,
  rrfK: 60,
  parentCharacters: 600,
  childCharacters: 200,
  childMaxCharacters: 300,
  childrenPerParent: 3,
  childOverlap: 0,
  vectorTimeoutMs: 1_500,
}
