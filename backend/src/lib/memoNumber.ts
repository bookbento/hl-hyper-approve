// src/lib/memoNumber.ts
import { prisma } from "../../prisma/client";

function toThaiNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
}
function buildPrefix(buAbbr: string, deptAbbr: string, typeAbbr: string, yyyymm: string) {
  const parts = [buAbbr, deptAbbr, typeAbbr].filter(s => s && s.trim()).join("-");
  return `${parts}-${yyyymm}-`;
}

export async function reserveMemoNumber(params: {
  businessUnitId: number;
  departmentId: number | null;
  memotypeId: number | null;
  buAbbr: string;
  deptAbbr: string;
  typeAbbr: string;
}): Promise<{ id: number; memonumber: string }> {
  const { businessUnitId, departmentId, memotypeId, buAbbr, deptAbbr, typeAbbr } = params;

  const now = toThaiNow();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const yyyymm = `${year}${String(month).padStart(2, "0")}`;
  const prefix = buildPrefix(buAbbr, deptAbbr, typeAbbr, yyyymm);

  console.log("🔢 [START] reserveMemoNumber", { prefix, businessUnitId, departmentId, memotypeId });

  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // ✅ Atomic INSERT...SELECT — compute next sequence from BOTH constraints in one statement.
      // Uses the GREATER of:
      //   1) MAX(seq) from memonumber prefix match (covers the memonumber unique constraint)
      //   2) MAX(seq) from composite columns match (covers the @@unique composite constraint)
      // This handles cases where abbreviations changed but the composite key still exists.
      const rows = await prisma.$queryRaw<Array<{
        id: number;
        memonumber: string;
        sequenceNumber: number;
      }>>`
        INSERT INTO "MemoNumber" (
          "memonumber",
          "businessUnitId",
          "departmentId",
          "memotypeId",
          "year",
          "month",
          "sequenceNumber",
          "createdAt"
        )
        SELECT
          ${prefix} || LPAD(next_seq::text, 4, '0'),
          ${businessUnitId},
          ${departmentId}::int,
          ${memotypeId}::int,
          ${year},
          ${month},
          next_seq,
          NOW()
        FROM (
          SELECT GREATEST(
            COALESCE((
              SELECT MAX("sequenceNumber")
              FROM "MemoNumber"
              WHERE "memonumber" LIKE ${prefix + '%'}
            ), 0),
            COALESCE((
              SELECT MAX("sequenceNumber")
              FROM "MemoNumber"
              WHERE "businessUnitId" = ${businessUnitId}
                AND "year" = ${year}
                AND "month" = ${month}
                AND "departmentId" IS NOT DISTINCT FROM ${departmentId}::int
                AND "memotypeId" IS NOT DISTINCT FROM ${memotypeId}::int
            ), 0)
          ) + 1 AS next_seq
        ) sub
        RETURNING "id", "memonumber", "sequenceNumber"
      `;

      const rec = rows[0];
      console.log("✅ [SUCCESS] Reserved:", rec.memonumber, "seq:", rec.sequenceNumber);
      return { id: rec.id, memonumber: rec.memonumber };

    } catch (e: any) {
      console.error(`❌ [ATTEMPT ${attempt + 1}/${MAX_ATTEMPTS}]`, e?.code, e?.message?.substring(0, 200));

      // P2002 = Prisma unique constraint, P2010 = raw query unique violation (23505)
      const isUniqueViolation =
        e?.code === "P2002" ||
        (e?.code === "P2010" && e?.meta?.code === "23505");

      const isRetryable =
        isUniqueViolation ||
        e?.code === "P2024" ||  // connection pool timeout
        e?.code === "P2034" ||  // write conflict / deadlock
        e?.message?.includes("timeout") ||
        e?.message?.includes("deadlock") ||
        e?.message?.includes("server closed the connection") ||
        e?.message?.includes("Can't reach database server");

      if (isRetryable && attempt < MAX_ATTEMPTS - 1) {
        const waitTime = 100 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
        console.log(`⏳ [RETRY] waiting ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      throw e;
    }
  }

  throw new Error(`Failed to reserve memo number after ${MAX_ATTEMPTS} retries. Prefix: ${prefix}`);
}
