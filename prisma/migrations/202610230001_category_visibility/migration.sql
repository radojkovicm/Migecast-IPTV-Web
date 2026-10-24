ALTER TABLE "playlist" ADD COLUMN "visibilityRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "categoryVisibility" JSONB NOT NULL DEFAULT '{"tv":null,"movie":null,"series":null}';
