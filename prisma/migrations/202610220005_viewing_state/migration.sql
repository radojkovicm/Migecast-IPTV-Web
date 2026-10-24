-- CreateTable
CREATE TABLE "viewingState" (
    "userId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duration" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "viewingState_pkey" PRIMARY KEY ("userId","playlistId","providerKey","itemId")
);

-- CreateIndex
CREATE INDEX "viewingState_userId_playlistId_providerKey_favorite_idx" ON "viewingState"("userId", "playlistId", "providerKey", "favorite");

-- AddForeignKey
ALTER TABLE "viewingState" ADD CONSTRAINT "viewingState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewingState" ADD CONSTRAINT "viewingState_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
