-- Whether a user is emailed when a document waits for their approval. On by
-- default; each user can turn it off in Settings > Profile.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "approvalEmailsEnabled" BOOLEAN NOT NULL DEFAULT true;
