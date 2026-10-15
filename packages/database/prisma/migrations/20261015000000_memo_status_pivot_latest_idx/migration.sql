-- CreateIndex
CREATE INDEX "MemoStatusPivot_memoId_createdAt_id_idx" ON "MemoStatusPivot"("memoId", "createdAt" DESC, "id" DESC);

