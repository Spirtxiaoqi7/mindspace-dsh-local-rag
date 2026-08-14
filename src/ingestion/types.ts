/** Stable, library-neutral contracts for local document ingestion. */

import type { SearchScope, SourceDocument } from '../contracts.ts'

export type LocalDocumentKind = 'pdf' | 'docx' | 'tsv' | 'txt' | 'md' | 'csv' | 'json' | 'html'

export interface IngestionInput {
  readonly bytes: Uint8Array
  readonly fileName: string
  readonly scope: Exclude<SearchScope, 'both'>
  readonly sessionId?: string
  readonly url?: string
  readonly source?: string
  readonly updatedAt?: number
  readonly documentId?: string
}

/** Provenance retained alongside chunks even when the current index only stores SourceDocument. */
export interface SourceAuthority {
  readonly kind: LocalDocumentKind
  readonly fileName: string
  readonly documentTitle: string
  readonly author?: string
  readonly url?: string
  readonly titlePage?: {
    readonly pageNumber: number
    readonly title?: string
    readonly text: string
  }
}

/** Exact point from which a chunk was produced, for future cited retrieval UI. */
export interface IngestionLocator {
  readonly pageNumber?: number
  readonly paragraphNumber?: number
  readonly rowNumber?: number
  readonly heading?: string
  readonly header?: readonly string[]
}

/** A deterministic semantic unit passed to a later chunker without losing source provenance. */
export interface IngestionChunkInput {
  readonly id: string
  readonly documentId: string
  readonly order: number
  readonly title: string
  readonly text: string
  readonly authority: SourceAuthority
  readonly locator: IngestionLocator
}

/** Unified output: compatible SourceDocument plus the richer chunking input. */
export interface IngestedLocalDocument {
  readonly kind: LocalDocumentKind
  readonly sourceDocument: SourceDocument
  readonly authority: SourceAuthority
  readonly chunks: readonly IngestionChunkInput[]
}

export interface PdfPageText {
  readonly pageNumber: number
  readonly text: string
}

export interface PdfExtraction {
  readonly title?: string
  readonly author?: string
  readonly pages: readonly PdfPageText[]
}

export interface DocxParagraph {
  readonly text: string
  readonly style?: string
}

export interface DocxExtraction {
  readonly title?: string
  readonly author?: string
  readonly paragraphs: readonly DocxParagraph[]
}

/** Adapters for pure-JS parsers such as pdfjs-dist and mammoth; dependencies stay outside this module. */
export interface LocalDocumentParserPorts {
  readonly pdf?: { extract(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfExtraction> }
  readonly docx?: { extract(bytes: Uint8Array, signal?: AbortSignal): Promise<DocxExtraction> }
}

export type IngestionErrorCode = 'unsupported-format' | 'missing-parser' | 'empty-document' | 'malformed-document' | 'invalid-input'

export class IngestionError extends Error {
  constructor(readonly code: IngestionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IngestionError'
  }
}
