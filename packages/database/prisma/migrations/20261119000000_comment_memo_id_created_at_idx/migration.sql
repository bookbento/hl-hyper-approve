-- CreateIndex
CREATE INDEX "Comment_memoId_createdAt_idx" ON "Comment"("memoId", "createdAt" DESC);
