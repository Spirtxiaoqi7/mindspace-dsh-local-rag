import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SourceDocument } from '../src/contracts.ts'
import { LocalRagService } from '../src/host/service.ts'
import { LocalRagSourceArchive, MAX_SOURCE_PREVIEW_CHARS } from '../src/host/sources.ts'
import { LocalRagUploadManager } from '../src/host/upload.ts'
import type { LocalRagHostDependencies, LocalRagIndexPort } from '../src/host/types.ts'

function indexPort(fail = false): LocalRagIndexPort {
  return {
    initialize: vi.fn(), status: vi.fn(), rebuild: vi.fn(), search: vi.fn(), listDocuments: vi.fn(async () => []), removeDocument: vi.fn(async () => true),
    importText: vi.fn(async (document: SourceDocument) => {
      if (fail) throw new Error('index unavailable')
      return document
    }),
  }
}

function dependencies(index: LocalRagIndexPort): LocalRagHostDependencies {
  const status = async () => ({ modelId: 'test', ready: false, dimensions: null, state: 'missing' as const })
  return {
    index,
    models: {
      status: vi.fn(status), catalog: vi.fn(async () => []), select: vi.fn(status), download: vi.fn(status), cancelDownload: vi.fn(status),
      start: vi.fn(status), stop: vi.fn(status), setAutoStart: vi.fn(status), acknowledgeIndexRebuilt: vi.fn(status),
    },
  }
}

async function upload(manager: LocalRagUploadManager, fileName: string, payload: Buffer) {
  const started = await manager.begin({ fileName, size: payload.length })
  await manager.append({ uploadId: started.uploadId, offset: 0, dataBase64: payload.toString('base64') })
  return manager.complete(started.uploadId)
}

describe('durable archived local sources', () => {
  it('persists a stable opaque source id, previews extracted text by page, and reuses an identical upload', async () => {
    const root = await mkdtemp(join(process.cwd(), '.source-archive-'))
    try {
      const archive = new LocalRagSourceArchive(root)
      const manager = new LocalRagUploadManager(root, indexPort(), 1024 * 1024, archive)
      const payload = Buffer.from(`# Note\n\n${'鲸鱼资料。'.repeat(8_000)}`, 'utf8')
      const first = await upload(manager, 'note.md', payload)
      const second = await upload(manager, 'note.md', payload)
      expect(second).toMatchObject({ documentId: first.documentId, sourceId: first.sourceId, sourceUri: first.sourceUri })
      expect(first.sourceUri).toBe(`local-rag://source/${first.sourceId}`)
      expect(first.sourceUri).not.toMatch(/^file:/i)

      const page = await archive.getPreview({ documentId: first.documentId, limit: 100 })
      expect(page).toMatchObject({ canPreview: true, sourceId: first.sourceId, sourceAddress: first.sourceUri, offset: 0 })
      expect(page.textPage).toContain('鲸鱼资料')
      expect(page.nextCursor).toBeGreaterThan(0)
      const next = await archive.getPreview({ documentId: first.documentId, cursor: page.nextCursor!, limit: 100 })
      expect(next.offset).toBe(page.nextCursor)
      await expect(archive.getPreview({ documentId: first.documentId, limit: MAX_SOURCE_PREVIEW_CHARS + 1 })).rejects.toThrow('limit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never resolves arbitrary paths, caps pages, and reports legacy documents as unavailable', async () => {
    const root = await mkdtemp(join(process.cwd(), '.source-archive-'))
    try {
      const archive = new LocalRagSourceArchive(root)
      await expect(archive.getPreview({ documentId: '../../Windows/System32', limit: 1 })).resolves.toEqual({
        documentId: '../../Windows/System32', sourceAddress: 'unavailable', canPreview: false,
      })
      await expect(archive.getPreview({ documentId: 'source-sha256-0000000000000000000000000000000000000000000000000000000000000000', limit: MAX_SOURCE_PREVIEW_CHARS + 1 }))
        .resolves.toEqual({
          documentId: 'source-sha256-0000000000000000000000000000000000000000000000000000000000000000', sourceAddress: 'unavailable', canPreview: false,
        })
      expect(await archive.removeForDocument('../../Windows/System32')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes a newly archived source when index insertion fails, so no orphan becomes previewable', async () => {
    const root = await mkdtemp(join(process.cwd(), '.source-archive-'))
    try {
      const archive = new LocalRagSourceArchive(root)
      const manager = new LocalRagUploadManager(root, indexPort(true), 1024 * 1024, archive)
      const payload = Buffer.from('# Failing source\nOnly temporary.', 'utf8')
      const started = await manager.begin({ fileName: 'failing.md', size: payload.length })
      await manager.append({ uploadId: started.uploadId, offset: 0, dataBase64: payload.toString('base64') })
      await expect(manager.complete(started.uploadId)).rejects.toThrow('index unavailable')
      // The source ID is opaque, so enumerate only through the deterministic
      // value returned from an equivalent successful upload attempt.
      const sourceId = (await import('../src/host/sources.ts')).stableSourceId('failing.md', payload)
      await expect(archive.getPreview({ documentId: sourceId })).resolves.toMatchObject({ canPreview: false, sourceAddress: 'unavailable' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes the archived source only after its indexed document is successfully removed', async () => {
    const root = await mkdtemp(join(process.cwd(), '.source-archive-'))
    try {
      const archive = new LocalRagSourceArchive(root)
      const bytes = Buffer.from('# Delete me\nLocal source.', 'utf8')
      const sourceId = (await import('../src/host/sources.ts')).stableSourceId('delete.md', bytes)
      await archive.store({ sourceId, fileName: 'delete.md', bytes })
      await archive.finalize({ sourceId, documentId: sourceId, title: 'Delete me', kind: 'md', previewText: '# Delete me\nLocal source.' })
      const index = indexPort()
      const service = new LocalRagService(new Context(), { enabled: false, dataRoot: root }, dependencies(index))

      await expect(service.removeDocument(sourceId, new AbortController().signal)).resolves.toEqual({ removed: true })
      expect(index.removeDocument).toHaveBeenCalledWith(sourceId, expect.any(AbortSignal))
      await expect(archive.getPreview({ documentId: sourceId })).resolves.toMatchObject({ canPreview: false, sourceAddress: 'unavailable' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
