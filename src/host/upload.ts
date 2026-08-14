/** Bounded, ordered, path-contained local document upload staging. */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createDefaultDocumentParserPorts, ingestLocalDocument } from '../ingestion/index.ts'
import { LocalRagSourceArchive, stableSourceId } from './sources.ts'
import type {
  AppendUploadRequest,
  AppendUploadResult,
  BeginUploadRequest,
  BeginUploadResult,
  CompleteUploadResult,
  LocalRagIndexPort,
} from './types.ts'

export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024
export const MAX_UPLOAD_CHUNK_BYTES = 1 * 1024 * 1024

interface UploadState {
  readonly id: string
  readonly fileName: string
  readonly size: number
  readonly url?: string
  readonly source?: string
  readonly path: string
  receivedBytes: number
}

/** One-process upload coordinator. Files live only below <dataRoot>/uploads. */
export class LocalRagUploadManager {
  private readonly uploads = new Map<string, UploadState>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly root: string

  constructor(
    dataRoot: string,
    private readonly index: LocalRagIndexPort,
    private readonly maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
    private readonly sources = new LocalRagSourceArchive(dataRoot),
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('max upload bytes must be a positive safe integer')
    this.root = resolve(dataRoot, 'uploads')
  }

  async begin(request: BeginUploadRequest): Promise<BeginUploadResult> {
    const fileName = basename(request.fileName.trim())
    if (!fileName || fileName === '.' || fileName === '..') throw new Error('upload fileName must name one file')
    if (!Number.isSafeInteger(request.size) || request.size < 1 || request.size > this.maxBytes) {
      throw new Error(`upload size must be between 1 and ${String(this.maxBytes)} bytes`)
    }
    await mkdir(this.root, { recursive: true })
    const id = randomUUID()
    const path = containedPath(this.root, `${id}.part`)
    this.uploads.set(id, {
      id, fileName, size: request.size, path, receivedBytes: 0,
      ...optionalText(request.url, 'url'), ...optionalText(request.source, 'source'),
    })
    return { uploadId: id, maxChunkBytes: MAX_UPLOAD_CHUNK_BYTES }
  }

  append(request: AppendUploadRequest): Promise<AppendUploadResult> {
    return this.serial(request.uploadId, async () => {
      const upload = this.require(request.uploadId)
      if (!Number.isSafeInteger(request.offset) || request.offset !== upload.receivedBytes) throw new Error('upload chunk offset is out of order')
      const bytes = decodeCanonicalBase64(request.dataBase64)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_CHUNK_BYTES) throw new Error('upload chunk size is invalid')
      if (upload.receivedBytes + bytes.byteLength > upload.size) throw new Error('upload exceeds declared size')
      await appendFile(upload.path, bytes)
      upload.receivedBytes += bytes.byteLength
      return { receivedBytes: upload.receivedBytes, complete: upload.receivedBytes === upload.size }
    })
  }

  complete(uploadId: string, signal?: AbortSignal): Promise<CompleteUploadResult> {
    return this.serial(uploadId, async () => {
      const upload = this.require(uploadId)
      if (upload.receivedBytes !== upload.size) throw new Error('upload is incomplete')
      const bytes = await readFile(upload.path)
      if (bytes.byteLength !== upload.size) throw new Error('upload file size changed during completion')
      const sourceId = stableSourceId(upload.fileName, bytes)
      const ingested = await ingestLocalDocument({
        bytes, fileName: upload.fileName, scope: 'knowledge',
        documentId: sourceId,
        ...upload.url === undefined ? {} : { url: upload.url },
        ...upload.source === undefined ? {} : { source: upload.source },
      }, createDefaultDocumentParserPorts(), signal)
      const archived = await this.sources.store({ sourceId, fileName: upload.fileName, bytes })
      // Preserve parser-defined page/paragraph/table boundaries as hard
      // retrieval units instead of flattening the file before chunking.
      const document = {
        ...ingested.sourceDocument,
        sourceId,
        sourceUri: archived.source.sourceUri,
        authority: ingested.authority,
        units: ingested.chunks.map(unit => ({
          id: unit.id,
          order: unit.order,
          text: unit.text,
          authority: unit.authority,
          locator: unit.locator,
        })),
      }
      try {
        await this.sources.finalize({
          sourceId,
          documentId: document.id,
          title: document.title,
          kind: ingested.kind,
          previewText: document.text,
        })
        await this.index.importText(document, signal)
      } catch (error) {
        // A failed first-time index write must not leave a raw-source orphan.
        // Existing archives belong to a prior successful idempotent upload and
        // are deliberately preserved.
        if (archived.created) await this.sources.removeForDocument(sourceId)
        throw error
      }
      await rm(upload.path, { force: true })
      this.uploads.delete(uploadId)
      return {
        documentId: document.id,
        title: document.title,
        characters: [...document.text].length,
        sourceId,
        sourceUri: archived.source.sourceUri,
      }
    })
  }

  cancel(uploadId: string): Promise<void> {
    return this.serial(uploadId, async () => {
      const upload = this.require(uploadId)
      await rm(upload.path, { force: true })
      this.uploads.delete(uploadId)
    })
  }

  private require(uploadId: string): UploadState {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(uploadId)) throw new Error('invalid upload id')
    const upload = this.uploads.get(uploadId)
    if (upload === undefined) throw new Error('upload was not found or has expired')
    if (containedPath(this.root, `${upload.id}.part`) !== upload.path) throw new Error('upload path containment check failed')
    return upload
  }

  private async serial<Result>(uploadId: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.queues.get(uploadId) ?? Promise.resolve()
    let resolveResult!: (value: Result) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<Result>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const next = previous.catch(() => undefined).then(async () => {
      try { resolveResult(await task()) } catch (error: unknown) { rejectResult(error) }
    })
    this.queues.set(uploadId, next)
    void next.finally(() => { if (this.queues.get(uploadId) === next) this.queues.delete(uploadId) })
    return result
  }
}

function containedPath(root: string, name: string): string {
  const base = resolve(root)
  const target = resolve(base, name)
  if (target === base || !target.startsWith(`${base}${'/'}`) && !target.startsWith(`${base}\\`)) throw new Error('upload path escapes data root')
  return target
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('upload base64 data is invalid')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('upload base64 data must be canonical')
  return bytes
}

function optionalText<Key extends 'url' | 'source'>(value: string | undefined, key: Key): Partial<Record<Key, string>> {
  return value?.trim() ? { [key]: value.trim() } as Record<Key, string> : {}
}
