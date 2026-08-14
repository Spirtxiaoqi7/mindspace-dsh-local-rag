import { describe, expect, it } from 'vitest'
import { ingestLocalDocument, parseDelimited, stableDocumentId } from '../src/ingestion/index.ts'
import { IngestionError } from '../src/ingestion/types.ts'

const bytes = (value: string) => new TextEncoder().encode(value)

describe('local document ingestion', () => {
  it('keeps PDF filename, metadata, title-page information, and page locators', async () => {
    const document = await ingestLocalDocument({
      bytes: bytes('%PDF fixture'), fileName: 'architecture.pdf', scope: 'knowledge',
      url: 'https://example.test/architecture.pdf', updatedAt: 7,
    }, {
      pdf: {
        extract: async () => ({
          title: 'Architecture Overview', author: 'Mindspace Team',
          pages: [
            { pageNumber: 1, text: 'Architecture Overview\nThe title page' },
            { pageNumber: 2, text: 'System constraints' },
          ],
        }),
      },
    })
    expect(document.sourceDocument).toMatchObject({ title: 'Architecture Overview', updatedAt: 7 })
    expect(document.authority).toMatchObject({
      fileName: 'architecture.pdf', documentTitle: 'Architecture Overview', author: 'Mindspace Team',
      url: 'https://example.test/architecture.pdf', titlePage: { pageNumber: 1, title: 'Architecture Overview' },
    })
    expect(document.chunks.map(item => item.locator.pageNumber)).toEqual([1, 2])
    expect(document.chunks[1]!.text).toContain('Page 2')
  })

  it('preserves DOCX title, paragraphs, and section headings through deterministic units', async () => {
    const document = await ingestLocalDocument({ bytes: bytes('docx'), fileName: 'design.docx', scope: 'knowledge' }, {
      docx: {
        extract: async () => ({
          title: 'Design Notes', author: 'Kai',
          paragraphs: [
            { text: 'Introduction', style: 'Heading 1' },
            { text: 'The database remains local.', style: 'Normal' },
          ],
        }),
      },
    })
    expect(document.sourceDocument.title).toBe('Design Notes')
    expect(document.chunks).toHaveLength(2)
    expect(document.chunks[1]).toMatchObject({ locator: { paragraphNumber: 2, heading: 'Introduction' } })
  })

  it('keeps TSV headers and original row numbers in every table unit', async () => {
    const document = await ingestLocalDocument({
      bytes: bytes('name\trole\nMing\tengineer\n\nYue\tdesigner\n'), fileName: 'people.tsv', scope: 'knowledge',
    })
    expect(document.chunks).toHaveLength(2)
    expect(document.chunks[0]).toMatchObject({ locator: { rowNumber: 2, header: ['name', 'role'] } })
    expect(document.chunks[0]!.text).toContain('name: Ming')
    expect(document.chunks[1]!.text).toContain('Row 4')
    expect(document.sourceDocument.text).toContain('Table header: name | role')
  })

  it('normalizes supported plain-text formats without a parser dependency', async () => {
    const markdown = await ingestLocalDocument({ bytes: bytes('# Project Notes\n\nKeep it local.'), fileName: 'notes.md', scope: 'knowledge' })
    const html = await ingestLocalDocument({ bytes: bytes('<h1>Web Note</h1><script>ignore()</script><p>Keep &amp; cite.</p>'), fileName: 'note.html', scope: 'knowledge' })
    const json = await ingestLocalDocument({ bytes: bytes('{"b":2,"a":"text"}'), fileName: 'data.json', scope: 'knowledge' })
    expect(markdown.sourceDocument.title).toBe('Project Notes')
    expect(html.sourceDocument.text).toContain('Keep & cite.')
    expect(html.sourceDocument.text).not.toContain('ignore')
    expect(json.sourceDocument.text).toContain('"b": 2')
  })

  it('reports empty, missing-parser, and malformed inputs explicitly', async () => {
    await expect(ingestLocalDocument({ bytes: new Uint8Array(), fileName: 'empty.txt', scope: 'knowledge' }))
      .rejects.toMatchObject({ code: 'empty-document' } satisfies Partial<IngestionError>)
    await expect(ingestLocalDocument({ bytes: bytes('pdf'), fileName: 'missing.pdf', scope: 'knowledge' }))
      .rejects.toMatchObject({ code: 'missing-parser' } satisfies Partial<IngestionError>)
    await expect(ingestLocalDocument({ bytes: bytes('{bad'), fileName: 'bad.json', scope: 'knowledge' }))
      .rejects.toMatchObject({ code: 'malformed-document' } satisfies Partial<IngestionError>)
  })

  it('uses content-addressed ids and validates quoted delimited rows deterministically', () => {
    expect(stableDocumentId('same.txt', bytes('same'))).toBe(stableDocumentId('same.txt', bytes('same')))
    expect(parseDelimited('a\tb\n"x\ty"\tz', '\t')).toEqual([['a', 'b'], ['x\ty', 'z']])
    expect(() => parseDelimited('a\n"unterminated', '\t')).toThrow('unterminated')
  })
})
