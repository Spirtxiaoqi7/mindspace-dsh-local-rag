import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SourceDocument } from '../src/contracts.ts'
import { LocalRagUploadManager } from '../src/host/upload.ts'
import type { LocalRagIndexPort } from '../src/host/types.ts'

function indexPort() {
  const imported: SourceDocument[] = []
  const index: LocalRagIndexPort = {
    initialize: vi.fn(), status: vi.fn(), rebuild: vi.fn(), search: vi.fn(), listDocuments: vi.fn(async () => []), removeDocument: vi.fn(async () => true),
    importText: vi.fn(async (document: SourceDocument) => { imported.push(document); return document }),
  }
  return { index, imported }
}

describe('safe chunked local document uploads', () => {
  it('accepts only ordered exact-size chunks then ingests the completed file as knowledge', async () => {
    const root = await mkdtemp(join(process.cwd(), '.upload-'))
    try {
      const { index, imported } = indexPort()
      const subject = new LocalRagUploadManager(root, index, 128)
      const payload = Buffer.from('# Uploaded note\n\nOnly local indexing.', 'utf8')
      const begin = await subject.begin({ fileName: '../../note.md', size: payload.length, source: 'test upload' })
      await expect(subject.append({ uploadId: begin.uploadId, offset: 1, dataBase64: payload.subarray(0, 2).toString('base64') }))
        .rejects.toThrow('out of order')
      const first = payload.subarray(0, 8)
      await expect(subject.append({ uploadId: begin.uploadId, offset: 0, dataBase64: first.toString('base64') }))
        .resolves.toMatchObject({ receivedBytes: 8, complete: false })
      await expect(subject.append({ uploadId: begin.uploadId, offset: 8, dataBase64: payload.subarray(8).toString('base64') }))
        .resolves.toMatchObject({ receivedBytes: payload.length, complete: true })
      await expect(subject.complete(begin.uploadId)).resolves.toMatchObject({ title: 'Uploaded note', characters: expect.any(Number) })
      expect(imported).toHaveLength(1)
      expect(imported[0]).toMatchObject({ scope: 'knowledge', title: 'Uploaded note', source: 'test upload' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects noncanonical chunks, overflow, unsafe names, and invalidates cancelled uploads', async () => {
    const root = await mkdtemp(join(process.cwd(), '.upload-'))
    try {
      const { index } = indexPort()
      const subject = new LocalRagUploadManager(root, index, 4)
      await expect(subject.begin({ fileName: 'large.txt', size: 5 })).rejects.toThrow('between 1 and 4')
      await expect(subject.begin({ fileName: '..', size: 1 })).rejects.toThrow('fileName')
      const begin = await subject.begin({ fileName: 'small.txt', size: 1 })
      await expect(subject.append({ uploadId: begin.uploadId, offset: 0, dataBase64: 'YQ' })).rejects.toThrow('base64')
      await subject.cancel(begin.uploadId)
      await expect(subject.append({ uploadId: begin.uploadId, offset: 0, dataBase64: 'YQ==' })).rejects.toThrow('not found')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
