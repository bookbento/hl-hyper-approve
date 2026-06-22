# PowerShell script to apply all changes to MemoAndApproval.tsx

$filePath = "frontend/src/page/MemoViewer/MemoAndApproval.tsx"
$content = Get-Content $filePath -Raw

Write-Host "Applying changes to MemoAndApproval.tsx..." -ForegroundColor Green

# Change 1: Add extraLines state after extraActive
$pattern1 = '(\s+const \[extraActive, setExtraActive\] = useState<ExtraLine \| null>\(null\);)'
$replacement1 = '$1' + "`n  // ✅ State for all extra approval lines (not just active)`n  const [extraLines, setExtraLines] = useState<any[]>([]);"
$content = $content -replace $pattern1, $replacement1
Write-Host "✓ Added extraLines state" -ForegroundColor Cyan

# Change 2: Add ExtraApprovalLineDTO type after ExtraLine type
$pattern2 = '(type ExtraLine = \{[^}]+\};)'
$replacement2 = '$1' + @"

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
"@
$content = $content -replace $pattern2, $replacement2
Write-Host "✓ Added ExtraApprovalLineDTO type" -ForegroundColor Cyan

# Change 3: Add useEffect to fetch extra lines (after extraActive useEffect)
$pattern3 = '(useEffect\(\(\) => \{[^}]+setExtraActive[^}]+\}, \[memoId\]\);)'
$replacement3 = '$1' + @"

  // ✅ Fetch all extra approval lines
  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        const res = await api.get(
          `/api/memos/$\{memoId\}/extra-approval-lines`,
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
"@
$content = $content -replace $pattern3, $replacement3
Write-Host "✓ Added useEffect for fetching extra lines" -ForegroundColor Cyan

# Change 4: Add helper function before groups useMemo
$pattern4 = '(\s+// 2\) enrich groups ให้มี hasSigMarkerForThisUser)'
$replacement4 = @"
  // ✅ Function to determine which approval level an extra line should appear after
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

$1
"@
$content = $content -replace $pattern4, $replacement4
Write-Host "✓ Added getExtraLineInsertLevel helper function" -ForegroundColor Cyan

# Change 5: Add mergedItems useMemo after groups useMemo
$pattern5 = '(const groups = React\.useMemo\([^)]+\),\s+\[approverGroups, sigUsers\]\s+\);)'
$replacement5 = '$1' + @"

  // ✅ Merge approval groups with extra approval lines
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
"@
$content = $content -replace $pattern5, $replacement5
Write-Host "✓ Added mergedItems useMemo" -ForegroundColor Cyan

# Change 6: Update rendering from groups.map to mergedItems.map
$pattern6 = '\{groups\.map\(\(grp\) => \('
$replacement6 = '{mergedItems.map((item, index) => {' + "`n            if (item.type === `"group`") {`n              const grp = item.data as ApproverGroup;`n              return ("
$content = $content -replace $pattern6, $replacement6
Write-Host "✓ Updated rendering to use mergedItems" -ForegroundColor Cyan

# Change 7: Update closing of map
$pattern7 = '(\s+</ul>\s+</div>\s+)\)\)\}'
$replacement7 = '$1              );' + @"

            } else {
              const extraLine = item.data;
              return (
                <ExtraApprovalCard
                  key={`extra-$\{extraLine.id\}`}
                  extraLine={extraLine}
                  prettyTime={(iso: string) => timeAgo(iso)}
                  formatFullName={formatFullName}
                  Avatar={Avatar}
                />
              );
            }
          })}
"@
$content = $content -replace $pattern7, $replacement7
Write-Host "✓ Updated closing rendering logic" -ForegroundColor Cyan

# Save the modified content
Set-Content -Path $filePath -Value $content -NoNewline
Write-Host "`n✅ All changes applied successfully!" -ForegroundColor Green
Write-Host "File: $filePath" -ForegroundColor Yellow
