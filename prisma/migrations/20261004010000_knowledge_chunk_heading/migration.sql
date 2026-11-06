-- The Markdown heading path of the section a chunk was split from. Chunks
-- imported before this change, and text without headings, keep null.
ALTER TABLE "AiKnowledgeChunk" ADD COLUMN "heading" TEXT;
