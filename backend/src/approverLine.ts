import { prisma } from "../prisma/client";

export type ApproverStatus = {
  name: string;
  level: number;
  statusCode: "waiting" | "approved" | "rejected";
  isLevelSatisfied?: boolean; // New field to track if status is due to level satisfaction
};

export async function getApproverLineStatus(
  memoId: number,
  ver?: number
): Promise<ApproverStatus[]> {
  // 1) ตัดสินใจเวอร์ชัน
  const whereClause = ver !== undefined ? { memoId, version: ver } : { memoId };

  // 2) ดึง "แถวล่าสุดต่อคน" with delegation info and approval requirements
  const actions = await prisma.memoApproverAction.findMany({
    where: whereClause,
    orderBy: [
      { loaUser: { level: "asc" } },
      { version: "desc" },
    ],
    distinct: ["loaUserId"],
    select: {
      status: { select: { code: true } },
      assignedUserId: true,
      actualActorId: true,
      loaUser: {
        select: {
          level: true,
          approvalRequirement: true, // Add approval requirement
          user: { 
            select: { 
              id: true,
              name: true, 
              lastname: true, 
              nickname: true,
              delegatedToUserId: true,
              delegationStartDate: true,
              delegationEndDate: true,
              delegatedToUser: {
                select: {
                  id: true,
                  name: true,
                  lastname: true,
                  nickname: true
                }
              }
            } 
          },
        },
      },
      actualActor: {
        select: {
          id: true,
          name: true,
          lastname: true,
          nickname: true
        }
      }
    },
  });

  // 3) First pass: Group by level and check if ANY requirement is met (same logic as web UI)
  const levelApprovalStatus = new Map<number, { 
    hasApproval: boolean; 
    requirement: string;
  }>();
  
  actions.forEach((a) => {
    const lvl = a.loaUser.level;
    const requirement = a.loaUser.approvalRequirement || "ALL";
    
    if (!levelApprovalStatus.has(lvl)) {
      levelApprovalStatus.set(lvl, { 
        hasApproval: false, 
        requirement 
      });
    }
    
    if (a.status.code === "approved") {
      const levelStatus = levelApprovalStatus.get(lvl)!;
      levelStatus.hasApproval = true;
    }
  });

  // 4) Second pass: map ออก with delegation handling and level satisfaction logic
  return actions
    .filter((a) => a.loaUser.user !== null) // Filter out null users (unresolved flexible slots)
    .map((a) => {
      const originalUser = a.loaUser.user!;
      let displayUser: { name: string; lastname: string | null; nickname: string | null; id?: number } = originalUser;

      // Check if there's active delegation - if so, show delegated user completely
      if (originalUser.delegatedToUserId && 
          originalUser.delegationStartDate && 
          originalUser.delegationEndDate) {
        const now = new Date();
        const isActiveDelegation = now >= originalUser.delegationStartDate && now <= originalUser.delegationEndDate;
        
        if (isActiveDelegation && originalUser.delegatedToUser) {
          displayUser = {
            id: originalUser.delegatedToUser.id,
            name: originalUser.delegatedToUser.name,
            lastname: originalUser.delegatedToUser.lastname,
            nickname: originalUser.delegatedToUser.nickname
          };
        }
      }

      // If action was performed by someone else (actualActor), use that person's name
      if (a.actualActorId && a.actualActor) {
        displayUser = {
          id: a.actualActor.id,
          name: a.actualActor.name,
          lastname: a.actualActor.lastname,
          nickname: a.actualActor.nickname
        };
      }

      const first = (displayUser.name ?? "").trim();
      const last  = (displayUser.lastname ?? "").trim();
      const nick  = (displayUser.nickname ?? "").trim();
      const full  = [first, last].filter(Boolean).join(" ").trim();

      // กันเคสชื่อเล่นซ้ำกับชื่อจริง/ชื่อเต็ม
      const nickIsDup =
        (!!nick && (nick.localeCompare(first, undefined, { sensitivity: "accent" }) === 0 ||
                    nick.localeCompare(full,  undefined, { sensitivity: "accent" }) === 0));

      const display = !nick || nickIsDup
        ? (full || first || nick || "")
        : (full ? `${full} (${nick})` : `${first ? `${first} (${nick})` : nick}`);

      // No delegation indicator - just show the effective user directly

      // 5) Apply level satisfaction logic (same as web UI)
      const lvl = a.loaUser.level;
      const originalStatus = a.status.code as "waiting" | "approved" | "rejected";
      const levelStatus = levelApprovalStatus.get(lvl);
      const isLevelSatisfied = levelStatus?.requirement === "ANY" && levelStatus?.hasApproval;
      
      // If this is a waiting approver in a satisfied ANY level, show as "approved"
      const finalStatus = (originalStatus === "waiting" && isLevelSatisfied) ? "approved" : originalStatus;

      return {
        name: display,
        level: lvl,
        statusCode: finalStatus,
        isLevelSatisfied: originalStatus === "waiting" && isLevelSatisfied, // Track if this is level satisfaction
      };
    });
}