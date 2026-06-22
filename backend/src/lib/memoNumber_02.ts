// src/lib/memoNumber.ts
import { prisma } from "../../prisma/client";

function toThaiNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
}
function pad4(n: number) {
  return String(n).padStart(4, "0");
}
function buildPrefix(buAbbr: string, deptAbbr: string, typeAbbr: string, yyyymm: string) {
  const parts = [buAbbr, deptAbbr, typeAbbr].filter(s => s && s.trim()).join("-");
  return `${parts}-${yyyymm}-`;
}

// Hash string to integer for advisory lock
function hashStringToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
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

  console.log("🔢 [START] reserveMemoNumber called");

  try {
    const now = toThaiNow();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const yyyymm = `${year}${String(month).padStart(2, "0")}`;
    const prefix = buildPrefix(buAbbr, deptAbbr, typeAbbr, yyyymm);
    const lockKey = hashStringToInt(prefix);

    console.log("🔢 Generated prefix:", prefix, "lockKey:", lockKey);

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        console.log(`🔄 [ATTEMPT ${attempt + 1}/5] Starting transaction...`);

        const result = await prisma.$transaction(
          async (tx) => {
            console.log("🔒 [TX] Acquiring advisory lock for key:", lockKey);

            // ✅ Advisory lock - ป้องกัน concurrent access ต่อ prefix เดียวกัน
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

            console.log("🔒 [TX] Lock acquired, querying max sequence...");

            // ✅ หา sequence สูงสุดโดยใช้ prefix (string match)
            const lastResult = await tx.$queryRaw<Array<{ max_seq: number | null }>>`
              SELECT MAX("sequenceNumber") as max_seq
              FROM "MemoNumber"
              WHERE "memonumber" LIKE ${prefix + '%'}
            `;

            const lastSeq = lastResult?.[0]?.max_seq ?? 0;
            const nextSeq = lastSeq + 1;
            const memonumber = `${prefix}${pad4(nextSeq)}`;

            console.log("✨ [TX] Creating memo number:", memonumber, "seq:", nextSeq);

            const rec = await tx.memoNumber.create({
              data: {
                memonumber,
                businessUnitId,
                departmentId,
                memotypeId,
                year,
                month,
                sequenceNumber: nextSeq,
              },
            });

            console.log("✅ [TX] Created successfully, id:", rec.id);

            return { id: rec.id, memonumber };
          },
          {
            maxWait: 5000,   // รอ connection pool สูงสุด 5 วินาที
            timeout: 10000,  // transaction timeout 10 วินาที
          }
        );

        console.log("✅ [SUCCESS] Returning result:", result.memonumber);
        return result;
      } catch (e: any) {
        console.error(`❌ [ATTEMPT ${attempt + 1}] Error:`, {
          code: e?.code,
          message: e?.message?.substring(0, 100),
        });

        // Unique constraint violation - retry
        if (e?.code === "P2002") {
          const waitTime = 50 + attempt * 50;
          console.log(`⏳ [RETRY] P2002 unique violation, waiting ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        // Timeout, deadlock, or connection issues - retry
        if (
          e?.code === "P2024" || // Connection pool timeout
          e?.code === "P2034" || // Write conflict/deadlock
          e?.message?.includes("timeout") ||
          e?.message?.includes("deadlock")
        ) {
          const waitTime = 100 + attempt * 100;
          console.log(`⏳ [RETRY] Timeout/deadlock, waiting ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        console.error("❌ [NON-RETRYABLE] Throwing error");
        throw e;
      }
    }

    console.error("❌ [EXHAUSTED] All retries failed for prefix:", prefix);
    throw new Error(`Failed to reserve memo number after retries. Prefix: ${prefix}`);
  } catch (err: any) {
    console.error("❌ [OUTER] Error:", err?.message?.substring(0, 100));
    throw err;
  }
}
