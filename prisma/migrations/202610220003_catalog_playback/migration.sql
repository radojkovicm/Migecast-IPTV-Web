-- AlterTable
ALTER TABLE "playlist" ADD COLUMN     "catalogRevision" INTEGER,
ADD COLUMN     "catalogUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "catalogItem" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "season" INTEGER,
    "episode" INTEGER,
    "parentId" TEXT,
    "encryptedLocator" TEXT NOT NULL,

    CONSTRAINT "catalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbackLease" (
    "id" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playbackLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalogItem_playlistId_kind_title_idx" ON "catalogItem"("playlistId", "kind", "title");

-- CreateIndex
CREATE INDEX "catalogItem_playlistId_parentId_idx" ON "catalogItem"("playlistId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "catalogItem_playlistId_sourceKey_key" ON "catalogItem"("playlistId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "playbackLease_providerKey_key" ON "playbackLease"("providerKey");

-- CreateIndex
CREATE UNIQUE INDEX "playbackLease_userId_key" ON "playbackLease"("userId");

-- CreateIndex
CREATE INDEX "playbackLease_expiresAt_idx" ON "playbackLease"("expiresAt");

-- AddForeignKey
ALTER TABLE "catalogItem" ADD CONSTRAINT "catalogItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
