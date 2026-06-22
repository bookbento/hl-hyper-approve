// ============================================================================
// CODE SNIPPETS TO ADD TO MemoAndApproval.tsx
// Copy and paste these sections into the appropriate locations
// ============================================================================

// ============================================================================
// SNIPPET 1: Add this line after line 961 (after const [extraActive, ...])
// ============================================================================
  const [extraLines, setExtraLines] = useState<any[]>([]);


// ============================================================================
// SNIPPET 2: Add this type definition after the ExtraLine type (around line 1150)
// ============================================================================
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
// SNIPPET 3: Add this useEffect after the extraActive useEffect (around line 1145)
// ============================================================================
  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        const res = await api.get(
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
// SNIPPET 4: Add this helper function BEFORE the groups useMemo (around line 1280)
// ============================================================================
  const getExtraLineInsertLevel = (extraLine: any): number => {
    if (!extraLine.createdAt) return -1;
    
    const extraCreatedTime = new Date(extraLine.createdAt).getTime();
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
// SNIPPET 5: Add this useMemo AFTER the groups useMemo (around line 1296)
// ============================================================================
  const mergedItems = React.useMemo(() => {
    const items: Array<{
      type: "group" | "extra";
      level: number;
      data: any;
    }> = [];
    
    groups.forEach((grp) => {
      items.push({
        type: "group",
        level: grp.level,
        data: grp,
      });
    });
    
    extraLines.forEach((extraLine: any) => {
      const insertAfterLevel = getExtraLineInsertLevel(extraLine);
      items.push({
        type: "extra",
        level: insertAfterLevel + 0.5,
        data: extraLine,
      });
    });
    
    items.sort((a, b) => a.level - b.level);
    
    return items;
  }, [groups, extraLines, approverGroups]);


// ============================================================================
// SNIPPET 6: RENDERING CHANGE (around line 1482)
// ============================================================================
// FIND THIS:
//   {groups.map((grp) => (
//     <div key={grp.level} className="mb-8 last:mb-0">

// REPLACE WITH:
          {mergedItems.map((item, index) => {
            if (item.type === "group") {
              const grp = item.data as ApproverGroup;
              return (
                <div key={`group-${grp.level}`} className="mb-8 last:mb-0">
                  {/* ALL EXISTING GROUP CODE STAYS HERE - DON'T CHANGE ANYTHING INSIDE */}


// ============================================================================
// SNIPPET 7: CLOSING RENDERING (at the end of the groups.map)
// ============================================================================
// FIND THE CLOSING:
//           </ul>
//         </div>
//       ))}

// REPLACE WITH:
                  </ul>
                </div>
              );
            } else {
              const extraLine = item.data;
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
