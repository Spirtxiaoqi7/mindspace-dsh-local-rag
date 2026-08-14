import { describe, expect, it } from 'vitest'
import { committedCompactionSummary, dedupeCompactionSummary, statementSimilarity } from '../src/summary/index.ts'

function fixture(error?: string) {
  const events = [
    { type: 'turn/start', seq: 0, time: 100, data: { turn: 3 } },
    { type: 'user/message', seq: 1, time: 110, data: { role: 'user', content: [{ type: 'text', text: '旧问题' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 120, data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '旧回答' }] } }, surfaceOp: 'append' },
    { type: 'compaction/start', seq: 3, time: 130, data: { compactionId: 'cmp-1', turn: 3 } },
    { type: 'compaction/summary', seq: 4, time: 140, data: { compactionId: 'cmp-1', summary: [{ type: 'text', text: '用户住在西安。\n用户喜欢本地RAG。' }], shadowedSeqs: [1, 2], provider: 'deepseek', model: 'v4' } },
    { type: 'user/message', seq: 5, time: 150, data: { role: 'user', content: [{ type: 'text', text: '<compacted-summary>...</compacted-summary>' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'cmp-1' } }, surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2, 3, 4] },
    { type: 'assistant/message', seq: 6, time: 160, data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: '最近未压缩内容' }] } }, surfaceOp: 'append' },
    { type: 'compaction/end', seq: 7, time: 170, data: { compactionId: 'cmp-1', turn: 3, ...(error ? { error } : {}) } },
  ]
  return { session: { id: 'session-a', events, surface: { nodes: [5, 6] } }, end: events[7]! }
}

describe('DSH compaction summary bridge', () => {
  it('accepts only a committed adjacent checkpoint and preserves time/turn/seq evidence', () => {
    const { session, end } = fixture()
    const result = committedCompactionSummary(session, end)
    expect(result).toMatchObject({
      documentId: 'dsh-compaction:session-a:cmp-1:4', sessionId: 'session-a', compactionId: 'cmp-1',
      text: '用户住在西安。\n用户喜欢本地RAG。', provider: 'deepseek', model: 'v4',
      startTime: 110, endTime: 120, startTurn: 3, endTurn: 3,
      startSeq: 3, summarySeq: 4, checkpointSeq: 5, endSeq: 7, shadowedSeqs: [1, 2],
      recentSurfaceText: ['最近未压缩内容'],
    })
  })

  it('rejects failed compactions and incomplete checkpoint provenance', () => {
    const failed = fixture('provider failed')
    expect(committedCompactionSummary(failed.session, failed.end)).toBeUndefined()
    const incomplete = fixture()
    incomplete.session.events[5]!.sourceEventSeqs = [1, 2, 4]
    expect(committedCompactionSummary(incomplete.session, incomplete.end)).toBeUndefined()
    const mismatched = fixture()
    ;(mismatched.session.events[5]!.data as { source: { compactionId: string } }).source.compactionId = 'cmp-other'
    expect(committedCompactionSummary(mismatched.session, mismatched.end)).toBeUndefined()
  })

  it('turns repeated summaries into a delta while keeping genuinely new statements', () => {
    const delta = dedupeCompactionSummary(
      '用户住在西安。\n用户喜欢本地 RAG。\n用户要求 PDF 保留页码。',
      ['用户居住在西安。\n用户喜欢本地RAG。'],
      ['用户刚刚要求 PDF 保留页码和来源。'],
      0.72,
    )
    expect(delta).not.toContain('本地 RAG')
    expect(delta).not.toContain('PDF 保留页码')
    expect(statementSimilarity('用户喜欢本地RAG', '用户喜欢本地 RAG')).toBe(1)
  })
})
