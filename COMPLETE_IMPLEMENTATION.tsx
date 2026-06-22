// ============================================================================
// COMPLETE IMPLEMENTATION CODE FOR MemoAndApproval.tsx
// ============================================================================
// This file contains all the code snippets that need to be added to MemoAndApproval.tsx
// Follow the instructions for each section

// ============================================================================
// SECTION 1: Type Definition (Add after ExtraLine type, around line 1145)
// ============================================================================

// ✅ Type for extra approval lines with full details including comment
type ExtraApprovalLineDTO = {
  id: number;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REJECTED";
  createdAt?: string;
  approvers: Array<{
    id: number;
    actedAt?: string | null;
    user: {
      id: number;
      name: string;
      lastname?: string | null;
      nickname?: string | null;
      profileImagePath?: string | null;
    };
    status?: { id: number; name: string } | null;
  }>;
  comment?: {
    id: number;
    comment: string;
    createdAt: string;
    user: {
      id: number;
      name: string;
      lastname?: string | null;
      nickname?: string | null;
    };
  } | null;
};

// ============================================================================
// SECTION 2: State Declaration (Add after other useState declarations, around line 950)
// ============================================================================

// ✅ State for all extra approval lines (not just active)
const [extraLines, setExtraLines] = useState<ExtraApprovalLineDTO[]>([]);

// ============================================================================
// SECTION 3: Fetch Extra Lines useEffect (Add after extraActive useEffect, around line 1145)
// ============================================================================

// ✅ Fetch all extra approval lines
useEffect(() => {
  let ok = true;
  (async () => {
    try {
      const res = await api.get<ExtraApprovalLineDTO[]>(
        `/api/memos/${memoId}/extra-approval-lines`,
        { withCredentials: true }
      );
      if (ok) setExtraLines(res.data ?? []);
    } catch {
      if (ok) setExtraLines([]);
    }
  })();
  return () => {
    ok = false;
  };
}, [memoId]);

// ============================================================================
// SECTION 4: Helper Function (Add before groups useMemo, around line 1280)
// ============================================================================

// ✅ Function to determine which approval level an extra line should appear after
const getExtraLineInsertLevel = (extraLine: ExtraApprovalLineDTO): number => {
  if (!extraLine.createdAt) return -1;
  
  const extraCreatedTime = new Date(extraLine.createdAt).getTime();
  
  // Find the highest level that was completed before this extra line was created
  let insertAfterLevel = -1;
  
  for (const grp of approverGroups) {
    for (const user of grp.users ?? []) {
      if (user.status === "approved" && user.actedAt) {
        const userActedTime = new Date(user.actedAt).getTime();
        if (userActedTime < extraCreatedTime && grp.level > insertAfterLevel) {
          insertAfterLevel = grp.level;
        }
      }
    }
  }
  
  return insertAfterLevel;
};

// ============================================================================
// SECTION 5: Merged Items useMemo (Add after groups useMemo, around line 1296)
// ============================================================================

// ✅ Merge approval groups with extra approval lines
const mergedItems = React.useMemo(() => {
  const items: Array<{
    type: "group" | "extra";
    level: number;
    data: any;
  }> = [];
  
  // Add all approval groups
  groups.forEach((grp) => {
    items.push({
      type: "group",
      level: grp.level,
      data: grp,
    });
  });
  
  // Add extra approval lines at appropriate positions
  extraLines.forEach((extraLine) => {
    const insertAfterLevel = getExtraLineInsertLevel(extraLine);
    items.push({
      type: "extra",
      level: insertAfterLevel + 0.5, // Insert between levels
      data: extraLine,
    });
  });
  
  // Sort by level
  items.sort((a, b) => a.level - b.level);
  
  return items;
}, [groups, extraLines, approverGroups]);

// ============================================================================
// SECTION 6: Update Rendering (Replace groups.map at line 1482)
// ============================================================================

// FIND THIS LINE (around line 1482):
// {groups.map((grp) => (

// REPLACE WITH:
{mergedItems.map((item, index) => {
  if (item.type === "group") {
    const grp = item.data as ApproverGroup;
    return (
      <div key={`group-${grp.level}`} className="mb-8 last:mb-0">
        {/* ALL EXISTING GROUP RENDERING CODE - DO NOT CHANGE */}
        {/* Keep everything from the original groups.map here */}
        {/* This includes: Header, ul with users, all the approval buttons, etc. */}
      </div>
    );
  } else {
    // Render extra approval card
    const extraLine = item.data as ExtraApprovalLineDTO;
    return (
      <ExtraApprovalCard
        key={`extra-${extraLine.id}`}
        extraLine={extraLine}
        prettyTime={(iso: string) => timeAgo(iso)}
        formatFullName={formatFullName}
        Avatar={Avatar}
      />
    );
  }
})}

// ============================================================================
// MANUAL STEPS TO APPLY:
// ============================================================================
// 1. Open frontend/src/page/MemoViewer/MemoAndApproval.tsx
// 2. The import is already added (verified)
// 3. Add SECTION 1 (Type Definition) after the ExtraLine type
// 4. Add SECTION 2 (State) after other useState declarations
// 5. Add SECTION 3 (useEffect) after the extraActive useEffect
// 6. Add SECTION 4 (Helper Function) before the groups useMemo
// 7. Add SECTION 5 (Merged Items) after the groups useMemo
// 8. Update SECTION 6 (Rendering) - wrap existing group code in conditional
// ============================================================================
