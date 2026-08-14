# Changelog

## 0.3.3 - 2026-08-14

- Declared `onnxruntime-node` as a direct runtime dependency and added post-install preflight checks for ONNX, PDF, and DOCX support.
- Kept the DSH Host alive while surfacing the precise ONNX startup failure in settings instead of returning a generic failed health probe.
- Documented the single structured-memory service rule so an integrated V2 memory bundle and the legacy external bundle cannot be mounted together by mistake.

## 0.3.2 - 2026-08-14

- Preserved per-parent page, paragraph, and row ranges after short-unit aggregation instead of assigning the whole document range to every result.

## 0.3.1 - 2026-08-14

- Fixed explicit index rebuilds while the embedding runtime is stopped: lexical chunks now refresh immediately and vector state remains correctly marked dirty.

## 0.3.0 - 2026-08-14

- Added user-visible, editable, logically deletable, and restorable version history for both uploaded knowledge and session-isolated DSH compaction summaries.
- Made the canonical document body authoritative and rebuilt only its derived lexical/vector chunks after edits or restores, with optimistic revision checks.
- Added stable `local-rag://source/...` addresses, bounded source reading, and exact source/document filters for model follow-up retrieval without exposing filesystem paths.
- Standardized Unicode chunking around 200 characters, extended to the next sentence end, hard-capped at 300, with at most three children per parent.
- Aggregated short PDF pages, DOCX paragraphs, and TSV/CSV rows before chunking while preserving page/paragraph/row ranges.
- Allowed an explicit rebuild while the embedding runtime is stopped to refresh lexical chunks immediately while correctly leaving vectors marked dirty.

## 0.2.2 - 2026-08-14

- Detached verified model downloads from the Web RPC request lifetime, so interrupted UI calls preserve resumable partials and only explicit cancellation stops the Host download.
- Added the verified ONNX tokenizer layout mapping required by Transformers.js before writing the model readiness marker.
- Bound conversation-summary retrieval explicitly to the executing DSH session while keeping uploaded knowledge global.

## 0.2.1 - 2026-08-14

- Made PDF text extraction independent of pdfjs-dist's optional native Canvas binding so pnpm profiles without that optional platform package still load PDFs.

## 0.2.0 - 2026-08-14

- Replaced raw completed-turn indexing with committed DSH compaction-summary indexing, startup recovery, deduplication against prior summaries and recent surface text, and an atomic processed ledger.
- Added PDF, DOCX, TSV, CSV, TXT, Markdown, JSON, and HTML chunked uploads with source authority and exact page, paragraph, row, timestamp, turn, and sequence locators.
- Added parallel vector/BM25+ retrieval with lexical-only fallback and explicit per-lane status.
- Added model catalog, selection, verified download, explicit start/stop, persisted auto-start, and stale-vector rebuild protection.
- Added strict V2 Remote descriptors and settings controls for uploads, model lifecycle, dual corpora, provenance, and partial results.
- Removed legacy `dsh-turn:` documents during migration.

## 0.1.3 - 2026-08-14

- Read the self-mounted Remote namespace through Cordis `ctx.get()` so the client does not violate static injection checks.

## 0.1.2 - 2026-08-14

- Removed the client bundle's self-dependency on `remote.localRag`; the bundle mounts that Remote during `apply()` and must not wait for it first.

## 0.1.1 - 2026-08-14

- Fixed the Host lifecycle for the current Cordis `Service` base, which has no parent async-generator initializer.
- Added a lifecycle regression test and current-session-aware settings search preview.

## 0.1.0 - 2026-08-14

- Added explicit `search_local_memory` tool with current-context-first guidance.
- Added local vector + BM25+ retrieval with RRF and parent/child chunks.
- Added isolated current-session memory and imported knowledge scopes.
- Added post-commit background indexing for completed chat turns.
- Added ModelScope-first, Hugging-Face-fallback ONNX model installation with resume, SHA-256 verification, atomic activation, cancellation, and a local inference health check.
- Added DSH settings UI for model, index, documents, and search preview.
- Added strict checked-in Typert Remote descriptors and standalone bundle patch.
