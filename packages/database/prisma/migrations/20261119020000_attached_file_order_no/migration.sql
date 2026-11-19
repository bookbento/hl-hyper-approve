-- Display order of attachments (was implicit and scrambled by concurrent inserts).
-- Existing rows keep id order: orderNo 0 for all, readers sort by (orderNo, id).
ALTER TABLE "AttachedFile" ADD COLUMN "orderNo" INTEGER NOT NULL DEFAULT 0;
