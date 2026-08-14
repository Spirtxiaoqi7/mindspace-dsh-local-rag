import { describe, expect, it } from 'vitest'

import type { SourceDocument } from '../src/contracts.ts'
import { chunkDocument, sentenceAwareChildren } from '../src/retrieval/chunking.ts'

const options = {
  parentCharacters: 600,
  childCharacters: 200,
  childMaxCharacters: 300,
  childrenPerParent: 3,
  childOverlap: 0,
}

function document(text: string, overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: 'doc', title: 'Document', text, scope: 'knowledge', updatedAt: 1, ...overrides,
  }
}

describe('sentence-aware child and parent chunking', () => {
  it('turns an exact 600-character ordinary document into 3 children and 1 parent', () => {
    const text = `${'甲'.repeat(199)}。${'乙'.repeat(199)}！${'丙'.repeat(199)}？`
    expect([...text]).toHaveLength(600)

    const result = chunkDocument(document(text), options)

    expect(result.children.map(child => [...child.text].length)).toEqual([200, 200, 200])
    expect(result.parents).toHaveLength(1)
    expect(result.children).toHaveLength(3)
    expect(result.children.every(child => child.parentId === result.parents[0]?.id)).toBe(true)
  })

  it('extends from the target to the first sentence end but never exceeds 300 Unicode characters', () => {
    const text = `${'甲'.repeat(219)}。${'乙'.repeat(309)}。尾声`
    const chunks = sentenceAwareChildren(text, 200, 300)

    expect([...chunks[0]!]).toHaveLength(220)
    expect(chunks.every(chunk => [...chunk].length <= 300)).toBe(true)
  })

  it('still honors a sentence end near 200 when the whole remainder is below 300', () => {
    const text = `${'甲'.repeat(199)}。${'乙'.repeat(50)}`
    expect(sentenceAwareChildren(text, 200, 300).map(chunk => [...chunk].length)).toEqual([200, 50])
  })

  it('hard-splits at 300 without punctuation and never overlaps text', () => {
    const text = '鲸'.repeat(650)
    const chunks = sentenceAwareChildren(text, 200, 300)

    expect(chunks.map(chunk => [...chunk].length)).toEqual([300, 300, 50])
    expect(chunks.join('')).toBe(text)
  })

  it('keeps the 300-character hard ceiling even when a caller asks for a larger target', () => {
    const result = chunkDocument(document('鲸'.repeat(650)), { ...options, childCharacters: 500 })
    expect(result.children.map(child => [...child.text].length)).toEqual([300, 300, 50])
  })

  it('caps every parent at 3 consecutive children', () => {
    const text = Array.from({ length: 7 }, (_, index) => `${String(index)}`.repeat(199) + '。').join('')
    const result = chunkDocument(document(text), options)
    const counts = result.parents.map(parent => result.children.filter(child => child.parentId === parent.id).length)

    expect(result.children).toHaveLength(7)
    expect(result.parents).toHaveLength(3)
    expect(counts).toEqual([3, 3, 1])
  })
})

describe('unit provenance', () => {
  const pdf = { kind: 'pdf', fileName: 'manual.pdf', documentTitle: 'Manual' }

  it('merges compatible short units and expands their line range', () => {
    const result = chunkDocument(document('first\nsecond', {
      authority: pdf,
      units: [
        { id: 'a', order: 0, text: 'first', locator: { pageNumber: 1, lineStart: 1, lineEnd: 2 } },
        { id: 'b', order: 1, text: 'second', locator: { pageNumber: 1, lineStart: 3, lineEnd: 4 } },
      ],
    }), options)

    expect(result.parents).toHaveLength(1)
    expect(result.parents[0]).toMatchObject({
      text: 'first\nsecond',
      authority: { kind: 'pdf', fileName: 'manual.pdf' },
      locator: { pageNumber: 1, lineStart: 1, lineEnd: 4 },
    })
  })

  it('merges short PDF pages, TSV rows, and DOCX paragraphs into truthful ranges', () => {
    const cases: SourceDocument[] = [
      document('page one\npage two', {
        id: 'pdf', authority: pdf, units: [
          { id: 'p1', order: 0, text: 'page one', locator: { pageNumber: 1 } },
          { id: 'p2', order: 1, text: 'page two', locator: { pageNumber: 2 } },
        ],
      }),
      document('row two\nrow three', {
        id: 'tsv', authority: { kind: 'tsv', fileName: 'table.tsv' }, units: [
          { id: 'r2', order: 0, text: 'row two', locator: { rowNumber: 2, header: ['name'] } },
          { id: 'r3', order: 1, text: 'row three', locator: { rowNumber: 3, header: ['name'] } },
        ],
      }),
      document('paragraph one\nparagraph two', {
        id: 'docx', authority: { kind: 'docx', fileName: 'notes.docx' }, units: [
          { id: 'd1', order: 0, text: 'paragraph one', locator: { paragraphNumber: 1 } },
          { id: 'd2', order: 1, text: 'paragraph two', locator: { paragraphNumber: 2 } },
        ],
      }),
    ]

    for (const source of cases) {
      const result = chunkDocument(source, options)
      expect(result.parents, source.id).toHaveLength(1)
      expect(result.children, source.id).toHaveLength(1)
    }
    expect(chunkDocument(cases[0]!, options).parents[0]?.locator).toMatchObject({ pageNumber: 1, pageEnd: 2 })
    expect(chunkDocument(cases[1]!, options).parents[0]?.locator).toMatchObject({ rowNumber: 2, rowEnd: 3 })
    expect(chunkDocument(cases[2]!, options).parents[0]?.locator).toMatchObject({ paragraphNumber: 1, paragraphEnd: 2 })
  })

  it('turns twenty short table rows into about 200-character children and one parent of three', () => {
    const units = Array.from({ length: 20 }, (_, index) => ({
      id: `r${String(index + 1)}`, order: index, text: '鲸'.repeat(29),
      locator: { rowNumber: index + 1, header: ['value'] },
    }))
    const result = chunkDocument(document(units.map(unit => unit.text).join('\n'), {
      id: 'short-rows', authority: { kind: 'tsv', fileName: 'rows.tsv' }, units,
    }), options)
    expect(result.children).toHaveLength(3)
    expect(result.parents).toHaveLength(1)
    expect(result.children.every(child => [...child.text].length <= 300)).toBe(true)
    expect(result.parents[0]?.locator).toMatchObject({ rowNumber: 1, rowEnd: 20 })
  })

  it('keeps each multi-parent table citation limited to the rows that parent covers', () => {
    const units = Array.from({ length: 40 }, (_, index) => ({
      id: `r${String(index + 1)}`, order: index, text: '鲸'.repeat(29),
      locator: { rowNumber: index + 1, header: ['value'] },
    }))
    const result = chunkDocument(document(units.map(unit => unit.text).join('\n'), {
      id: 'long-rows', authority: { kind: 'tsv', fileName: 'long.tsv' }, units,
    }), options)
    expect(result.children).toHaveLength(6)
    expect(result.parents).toHaveLength(2)
    expect(result.parents[0]!.locator.rowEnd).toBeLessThan(result.parents[1]!.locator.rowNumber!)
    expect(result.parents[1]!.locator.rowEnd).toBe(40)
  })
})
