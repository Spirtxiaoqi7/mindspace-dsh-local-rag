const checks = [
  ['onnxruntime-node', 'Windows/macOS/Linux ONNX execution'],
  ['pdfjs-dist/legacy/build/pdf.mjs', 'PDF ingestion'],
  ['mammoth', 'DOCX ingestion'],
]

const failures = []
for (const [specifier, capability] of checks) {
  try {
    await import(specifier)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push(`${specifier} (${capability}): ${detail}`)
  }
}

if (failures.length) {
  console.error('mindspace-dsh-local-rag runtime dependency check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('mindspace-dsh-local-rag runtime dependencies verified.')
}
