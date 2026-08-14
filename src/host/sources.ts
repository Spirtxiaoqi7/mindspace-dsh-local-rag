/** Opaque, durable storage for originals uploaded into the local RAG library. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { LocalDocumentKind } from '../ingestion/types.ts'
import type {
  GetSourcePreviewRequest,
  GetSourcePreviewResult,
  LocalRagSourceReader,
  StoredLocalRagSource,
} from './types.ts'

const SOURCE_ID = /^source-sha256-[a-f0-9]{64}$/
const DEFAULT_PREVIEW_LIMIT = 12_000
export const MAX_SOURCE_PREVIEW_CHARS = 48_000

interface SourceMetadata extends StoredLocalRagSource {
  readonly createdAt: number
  readonly documentId?: string
  readonly title?: string
  readonly kind?: LocalDocumentKind
  readonly previewCharacters?: number
}

export interface ArchiveSourceInput {
  readonly sourceId: string
  readonly fileName: string
  readonly bytes: Uint8Array
}

export interface FinalizeSourceInput {
  readonly sourceId: string
  readonly documentId: string
  readonly title: string
  readonly kind: LocalDocumentKind
  readonly previewText: string
}

/** Stable across repeated selection of the same filename and exact bytes. */
export function stableSourceId(fileName: string, bytes: Uint8Array): string {
  const digest = createHash('sha256')
    .update('mindspace-local-rag/source/v1\0')
    .update(fileName.normalize('NFC'))
    .update('\0')
    .update(bytes)
    .digest('hex')
  return `source-sha256-${digest}`
}

/**
 * An archive intentionally owns no caller-provided filesystem path. Every
 * source ID is validated before it is mapped below `<dataRoot>/sources`.
 */
export class LocalRagSourceArchive implements LocalRagSourceReader {
  private readonly root: string

  constructor(dataRoot: string) {
    this.root = resolve(dataRoot, 'sources')
  }

  async store(input: ArchiveSourceInput): Promise<{ readonly source: StoredLocalRagSource; readonly created: boolean }> {
    assertSourceId(input.sourceId)
    const fileName = input.fileName.trim()
    if (!fileName || fileName === '.' || fileName === '..') throw new Error('source fileName must name one file')
    if (stableSourceId(fileName, input.bytes) !== input.sourceId) throw new Error('source id does not match original bytes')
    const directory = this.directory(input.sourceId)
    const original = this.originalPath(input.sourceId)
    await mkdir(directory, { recursive: true })

    let created = false
    try {
      const existing = await readFile(original)
      if (!existing.equals(input.bytes)) throw new Error('source id collision or corrupted original source')
    } catch (error: unknown) {
      if (!isMissing(error)) throw error
      await writeAtomic(original, input.bytes)
      created = true
    }
    const previous = await this.readMetadata(input.sourceId)
    const source: StoredLocalRagSource = {
      sourceId: input.sourceId,
      sourceUri: sourceUri(input.sourceId),
      fileName,
      byteLength: input.bytes.byteLength,
    }
    await this.writeMetadata({
      ...previous,
      ...source,
      createdAt: previous?.createdAt ?? Date.now(),
    })
    return { source, created }
  }

  async finalize(input: FinalizeSourceInput): Promise<StoredLocalRagSource> {
    assertSourceId(input.sourceId)
    const metadata = await this.readMetadata(input.sourceId)
    if (metadata === undefined) throw new Error('source original is unavailable')
    if (input.documentId !== input.sourceId) throw new Error('uploaded source documentId must equal sourceId')
    await writeAtomic(this.previewPath(input.sourceId), Buffer.from(input.previewText, 'utf8'))
    await this.writeMetadata({
      ...metadata,
      documentId: input.documentId,
      title: input.title.trim(),
      kind: input.kind,
      previewCharacters: [...input.previewText].length,
    })
    return metadata
  }

  async getPreview(request: GetSourcePreviewRequest, signal?: AbortSignal): Promise<GetSourcePreviewResult> {
    throwIfAborted(signal)
    if (!SOURCE_ID.test(request.documentId)) return unavailable(request.documentId)
    const metadata = await this.readMetadata(request.documentId)
    if (metadata === undefined || metadata.documentId !== request.documentId || metadata.previewCharacters === undefined) {
      return unavailable(request.documentId)
    }
    const cursor = request.cursor ?? 0
    const limit = request.limit ?? DEFAULT_PREVIEW_LIMIT
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('source preview cursor must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SOURCE_PREVIEW_CHARS) {
      throw new Error(`source preview limit must be between 1 and ${String(MAX_SOURCE_PREVIEW_CHARS)}`)
    }
    let previewText: string
    try { previewText = await readFile(this.previewPath(metadata.sourceId), 'utf8') } catch (error: unknown) {
      if (isMissing(error)) return unavailable(request.documentId)
      throw error
    }
    const characters = [...previewText]
    const end = Math.min(characters.length, cursor + limit)
    const textPage = cursor >= characters.length ? '' : characters.slice(cursor, end).join('')
    return {
      documentId: metadata.documentId,
      sourceId: metadata.sourceId,
      sourceUri: metadata.sourceUri,
      kind: metadata.kind,
      title: metadata.title,
      sourceAddress: metadata.sourceUri,
      textPage,
      offset: cursor,
      ...(end < characters.length ? { nextCursor: end } : {}),
      canPreview: true,
    }
  }

  async replacePreview(documentId: string, text: string): Promise<void> {
    if (!SOURCE_ID.test(documentId)) return
    const metadata = await this.readMetadata(documentId)
    if (metadata === undefined || metadata.documentId !== documentId) return
    await writeAtomic(this.previewPath(documentId), Buffer.from(text, 'utf8'))
    await this.writeMetadata({ ...metadata, previewCharacters: [...text].length })
  }

  /** Remove only a source directory identified by its opaque source/document ID. */
  async removeForDocument(documentId: string): Promise<boolean> {
    if (!SOURCE_ID.test(documentId)) return false
    const metadata = await this.readMetadata(documentId)
    if (metadata === undefined || metadata.documentId !== documentId) return false
    await rm(this.directory(documentId), { recursive: true, force: true })
    return true
  }

  private directory(sourceId: string): string { return contained(this.root, sourceId) }
  private originalPath(sourceId: string): string { return contained(this.directory(sourceId), 'original') }
  private previewPath(sourceId: string): string { return contained(this.directory(sourceId), 'preview.txt') }
  private metadataPath(sourceId: string): string { return contained(this.directory(sourceId), 'metadata.json') }

  private async readMetadata(sourceId: string): Promise<SourceMetadata | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.metadataPath(sourceId), 'utf8'))
      if (!isMetadata(value, sourceId)) throw new Error('source metadata is invalid')
      const original = await stat(this.originalPath(sourceId))
      if (!original.isFile() || original.size !== value.byteLength) throw new Error('source original is missing or corrupted')
      return value
    } catch (error: unknown) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  private async writeMetadata(metadata: SourceMetadata): Promise<void> {
    assertSourceId(metadata.sourceId)
    await writeAtomic(this.metadataPath(metadata.sourceId), Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8'))
  }
}

function unavailable(documentId: string): GetSourcePreviewResult {
  return { documentId, sourceAddress: 'unavailable', canPreview: false }
}

function sourceUri(sourceId: string): string { return `local-rag://source/${sourceId}` }

function assertSourceId(value: string): void {
  if (!SOURCE_ID.test(value)) throw new Error('source id is invalid')
}

function contained(root: string, child: string): string {
  const base = resolve(root)
  const target = resolve(base, child)
  const inside = relative(base, target)
  if (!inside || inside.startsWith('..') || /^(?:[\\/]|[A-Za-z]:)/.test(inside)) throw new Error('source path escapes archive root')
  return target
}

async function writeAtomic(target: string, content: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.partial`
  await writeFile(temporary, content)
  try { await rename(temporary, target) } catch (error) { await rm(temporary, { force: true }); throw error }
}

function isMetadata(value: unknown, sourceId: string): value is SourceMetadata {
  if (typeof value !== 'object' || value === null) return false
  const metadata = value as Partial<SourceMetadata>
  return metadata.sourceId === sourceId
    && metadata.sourceUri === sourceUri(sourceId)
    && typeof metadata.fileName === 'string'
    && typeof metadata.byteLength === 'number'
    && Number.isSafeInteger(metadata.byteLength)
    && metadata.byteLength >= 0
    && Number.isFinite(metadata.createdAt)
    && (metadata.documentId === undefined || metadata.documentId === sourceId)
    && (metadata.previewCharacters === undefined || (Number.isSafeInteger(metadata.previewCharacters) && metadata.previewCharacters >= 0))
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : new DOMException('Source preview cancelled', 'AbortError'))
}
