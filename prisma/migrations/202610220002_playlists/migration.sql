-- AlterTable
ALTER TABLE "user" ADD COLUMN     "playlistRevision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "playlist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedInput" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "entryCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlistAssignment" (
    "userId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,

    CONSTRAINT "playlistAssignment_pkey" PRIMARY KEY ("userId","playlistId")
);

-- CreateTable
CREATE TABLE "playlistSelection" (
    "userId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,

    CONSTRAINT "playlistSelection_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "playlist_providerKey_idx" ON "playlist"("providerKey");

-- CreateIndex
CREATE INDEX "playlistAssignment_playlistId_idx" ON "playlistAssignment"("playlistId");

-- CreateIndex
CREATE INDEX "playlistSelection_userId_playlistId_idx" ON "playlistSelection"("userId", "playlistId");

-- AddForeignKey
ALTER TABLE "playlistAssignment" ADD CONSTRAINT "playlistAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlistAssignment" ADD CONSTRAINT "playlistAssignment_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlistSelection" ADD CONSTRAINT "playlistSelection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlistSelection" ADD CONSTRAINT "playlistSelection_userId_playlistId_fkey" FOREIGN KEY ("userId", "playlistId") REFERENCES "playlistAssignment"("userId", "playlistId") ON DELETE CASCADE ON UPDATE CASCADE;
