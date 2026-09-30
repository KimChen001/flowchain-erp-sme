-- Email sign-in links and database-backed sessions.
-- Additive only: three new tables and their indexes and foreign keys. No
-- existing table, column or row is changed.
-- CreateTable
CREATE TABLE "WorkspaceSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionIdHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,

    CONSTRAINT "WorkspaceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceSignInLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "requestIp" TEXT,
    "requestUserAgent" TEXT,

    CONSTRAINT "WorkspaceSignInLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignInRateLimitEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignInRateLimitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceSession_sessionIdHash_key" ON "WorkspaceSession"("sessionIdHash");

-- CreateIndex
CREATE INDEX "WorkspaceSession_tenantId_userId_revokedAt_idx" ON "WorkspaceSession"("tenantId", "userId", "revokedAt");

-- CreateIndex
CREATE INDEX "WorkspaceSession_expiresAt_idx" ON "WorkspaceSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceSignInLink_tokenHash_key" ON "WorkspaceSignInLink"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceSignInLink_tenantId_userId_consumedAt_idx" ON "WorkspaceSignInLink"("tenantId", "userId", "consumedAt");

-- CreateIndex
CREATE INDEX "WorkspaceSignInLink_expiresAt_idx" ON "WorkspaceSignInLink"("expiresAt");

-- CreateIndex
CREATE INDEX "SignInRateLimitEvent_kind_keyHash_createdAt_idx" ON "SignInRateLimitEvent"("kind", "keyHash", "createdAt");

-- CreateIndex
CREATE INDEX "SignInRateLimitEvent_createdAt_idx" ON "SignInRateLimitEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "WorkspaceSession" ADD CONSTRAINT "WorkspaceSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSession" ADD CONSTRAINT "WorkspaceSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSignInLink" ADD CONSTRAINT "WorkspaceSignInLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSignInLink" ADD CONSTRAINT "WorkspaceSignInLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
