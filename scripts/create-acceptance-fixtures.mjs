import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const output = join(import.meta.dirname, '..', 'acceptance-fixtures')
await mkdir(output, { recursive: true })

const pdf = await PDFDocument.create()
pdf.setTitle('Mindspace RAG Acceptance Authority')
pdf.setAuthor('Mindspace Lab')
const font = await pdf.embedFont(StandardFonts.Helvetica)
pdf.addPage().drawText('Mindspace RAG Acceptance Authority\nAuthority seal: MS-2026-0814', { x: 48, y: 760, font })
pdf.addPage().drawText('The verified local retrieval codename is CORAL-LANTERN-7429.', { x: 48, y: 760, font })
await writeFile(join(output, 'acceptance-authority.pdf'), await pdf.save())

await writeFile(
  join(output, 'acceptance-rows.tsv'),
  'id\ttopic\tfact\n1\tproject\tThe TSV recall token is RAG-TSV-9157.\n2\tpolicy\tCurrent conversation has priority.\n',
  'utf8',
)

console.log(output)
