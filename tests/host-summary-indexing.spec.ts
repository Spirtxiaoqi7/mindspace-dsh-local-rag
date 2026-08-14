import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SourceDocument } from '../src/contracts.ts'
import { CompactionSummaryIndexer } from '../src/host/summary-indexing.ts'
import type { LocalRagIndexPort } from '../src/host/types.ts'

function compaction(id: string, offset: number, text: string) {
  return [
    { type: 'turn/start', seq: offset, time: offset, data: { turn: 1 } },
    { type: 'user/message', seq: offset + 1, time: offset + 1, data: { content: [{ type: 'text', text: 'old question' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: offset + 2, time: offset + 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old answer' }] } } },
    { type: 'compaction/start', seq: offset + 3, time: offset + 3, data: { compactionId: id, turn: 1 } },
    { type: 'compaction/summary', seq: offset + 4, time: offset + 4, data: { compactionId: id, summary: [{ type: 'text', text }], shadowedSeqs: [offset + 1, offset + 2], provider: 'test', model: 'test-model' } },
    { type: 'user/message', seq: offset + 5, time: offset + 5, data: { content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact', compactionId: id } }, sourceEventSeqs: [offset + 1, offset + 2, offset + 3, offset + 4] },
    { type: 'compaction/end', seq: offset + 6, time: offset + 6, data: { compactionId: id, turn: 1 } },
  ]
}

function ports(existing = [{ id: 'dsh-turn:legacy:1' }]) {
  const imported: SourceDocument[] = []
  const index: LocalRagIndexPort = {
    initialize: vi.fn(), status: vi.fn(), rebuild: vi.fn(), search: vi.fn(), close: vi.fn(),
    importText: vi.fn(async (document: SourceDocument) => { imported.push(document); return document }),
    removeDocument: vi.fn(async () => true),
    listDocuments: vi.fn(async () => existing.map(document => ({
      title: document.id, scope: 'conversation_summary' as const, updatedAt: 0, characters: 0, ...document,
    }))),
  }
  return { index, imported }
}

describe('compaction-only summary indexing', () => {
  it('recovers committed summaries at startup, atomically records them, and removes legacy raw turns', async () => {
    const root = await mkdtemp(join(process.cwd(), '.summary-index-'))
    try {
      const { index, imported } = ports()
      const events = compaction('cmp-1', 0, 'User requires local-only memory.')
      const session = { id: 'session-1', events, surface: { nodes: [] } }
      const subject = new CompactionSummaryIndexer(index, root)
      await subject.initialize([session])
      expect(imported).toHaveLength(1)
      expect(imported[0]).toMatchObject({
        id: 'dsh-compaction:session-1:cmp-1:4', scope: 'conversation_summary', sessionId: 'session-1',
        text: 'User requires local-only memory.',
      })
      expect(index.removeDocument).toHaveBeenCalledWith('dsh-turn:legacy:1')
      const ledger = JSON.parse(await readFile(join(root, 'summary-index', 'processed-ledger.json'), 'utf8'))
      expect(ledger.processed['dsh-compaction:session-1:cmp-1:4'].state).toBe('indexed')

      const resumed = new CompactionSummaryIndexer(index, root)
      await resumed.initialize([session])
      expect(imported).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes each compacted summary with its owning DSH session id', async () => {
    const root = await mkdtemp(join(process.cwd(), '.summary-index-'))
    try {
      const { index, imported } = ports([])
      const sessionA = { id: 'conversation-a', events: compaction('cmp-a', 0, 'Only A knows the coral roadmap.'), surface: { nodes: [] } }
      const sessionB = { id: 'conversation-b', events: compaction('cmp-b', 20, 'Only B knows the lighthouse budget.'), surface: { nodes: [] } }
      const subject = new CompactionSummaryIndexer(index, root)
      await subject.initialize([sessionA, sessionB])

      expect(imported.map(document => ({ id: document.id, sessionId: document.sessionId, scope: document.scope }))).toEqual([
        { id: 'dsh-compaction:conversation-a:cmp-a:4', sessionId: 'conversation-a', scope: 'conversation_summary' },
        { id: 'dsh-compaction:conversation-b:cmp-b:24', sessionId: 'conversation-b', scope: 'conversation_summary' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records a deduplicated empty summary as skipped instead of retrying it forever', async () => {
    const root = await mkdtemp(join(process.cwd(), '.summary-index-'))
    try {
      const { index, imported } = ports([])
      const events = [...compaction('cmp-1', 0, 'User prefers TSV citations.'), ...compaction('cmp-2', 10, 'User prefers TSV citations.')]
      const session = { id: 'session-2', events, surface: { nodes: [] } }
      const subject = new CompactionSummaryIndexer(index, root)
      await subject.initialize([session])
      expect(imported).toHaveLength(1)
      const ledger = JSON.parse(await readFile(join(root, 'summary-index', 'processed-ledger.json'), 'utf8'))
      expect(ledger.processed['dsh-compaction:session-2:cmp-2:14'].state).toBe('skipped')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('contains live observer failures and makes the last error observable', async () => {
    const root = await mkdtemp(join(process.cwd(), '.summary-index-'))
    try {
      const { index } = ports([])
      index.importText = vi.fn(async () => { throw new Error('index unavailable') })
      const events = compaction('cmp-1', 0, 'A new durable fact.')
      const session = { id: 'session-3', events, surface: { nodes: [] } }
      const subject = new CompactionSummaryIndexer(index, root)
      await subject.initialize([])
      subject.observe(session, events.at(-1)!)
      await (subject as unknown as { serial: Promise<void> }).serial
      expect(subject.view().lastError).toBe('index unavailable')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
