ALTER TABLE "AiKnowledgeDocument"
  ADD COLUMN "indexAttemptStatus" TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN "indexAttemptId" TEXT,
  ADD COLUMN "indexAttemptError" TEXT,
  ADD COLUMN "indexAttemptStartedAt" TIMESTAMP(3),
  ADD COLUMN "indexAttemptFinishedAt" TIMESTAMP(3);
