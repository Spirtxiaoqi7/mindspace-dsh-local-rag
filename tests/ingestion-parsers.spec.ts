import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  createDefaultDocumentParserPorts,
  ingestLocalDocument,
} from '../src/ingestion/index.ts'

describe('production document parser adapters', () => {
  it('extracts PDF metadata, title page, page numbers, and searchable units', async () => {
    const pdf = await PDFDocument.create()
    pdf.setTitle('Authoritative Whale Manual')
    pdf.setAuthor('Mindspace Lab')
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage().drawText('Authoritative Whale Manual\nTitle page authority', { x: 40, y: 760, font })
    pdf.addPage().drawText('Chapter one: local hybrid retrieval evidence', { x: 40, y: 760, font })
    const bytes = await pdf.save()

    const result = await ingestLocalDocument({
      bytes,
      fileName: 'whale-manual.pdf',
      scope: 'knowledge',
      url: 'https://example.test/whale-manual',
      updatedAt: 42,
    }, createDefaultDocumentParserPorts())

    expect(result.authority).toMatchObject({
      kind: 'pdf',
      fileName: 'whale-manual.pdf',
      documentTitle: 'Authoritative Whale Manual',
      author: 'Mindspace Lab',
      url: 'https://example.test/whale-manual',
      titlePage: { pageNumber: 1 },
    })
    expect(result.chunks.map(chunk => chunk.locator.pageNumber)).toEqual([1, 2])
    expect(result.sourceDocument.units?.map(unit => unit.locator.pageNumber)).toEqual([1, 2])
    expect(result.sourceDocument.text).toContain('local hybrid retrieval evidence')
  })

  it('extracts DOCX headings and paragraph coordinates with mammoth', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`)
    zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`)
    zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Whale Operations</w:t></w:r></w:p>
          <w:p><w:r><w:t>DOCX evidence paragraph for retrieval.</w:t></w:r></w:p>
          <w:sectPr/>
        </w:body>
      </w:document>`)
    const bytes = await zip.generateAsync({ type: 'uint8array' })

    const result = await ingestLocalDocument({
      bytes,
      fileName: 'operations.docx',
      scope: 'knowledge',
    }, createDefaultDocumentParserPorts())

    expect(result.authority).toMatchObject({ kind: 'docx', documentTitle: 'Whale Operations' })
    expect(result.chunks[0]).toMatchObject({ locator: { paragraphNumber: 1, heading: 'Whale Operations' } })
    expect(result.chunks[1]).toMatchObject({ locator: { paragraphNumber: 2, heading: 'Whale Operations' } })
    expect(result.sourceDocument.text).toContain('DOCX evidence paragraph')
  })
})
