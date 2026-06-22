#!/usr/bin/env bash
# Phase 3 — Equivalence test for POST /api/memos/search
#
# Compares POST /api/memos/search (NEW) against GET /api/memos (LEGACY)
# for the 13 filter combos from the design doc. Prints PARITY metrics
# (total / item set / statCounts) so the user can spot drift.
#
# Usage:
#   export COOKIE='refreshToken=...'
#   export BASE_URL='http://localhost:3001'   # default
#   bash scripts/equivalence-search.sh
#
# Dependencies: curl, jq

set -u

COOKIE="${COOKIE:-}"
BASE_URL="${BASE_URL:-http://localhost:3001}"
SEARCH="$BASE_URL/api/memos/search"
LEGACY="$BASE_URL/api/memos"

if [ -z "$COOKIE" ]; then
  echo "ERROR: set COOKIE env var (e.g. export COOKIE='refreshToken=...')"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (apt-get install jq / brew install jq)"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

# fetch legacy /api/memos once and cache; subsequent comparisons filter
# this in jq for parity baseline
LEGACY_TMP=$(mktemp)
echo "Loading legacy /api/memos (single call) ..."
LEGACY_HTTP=$(curl -sS -o "$LEGACY_TMP" -w "%{http_code}" \
  -H "Cookie: $COOKIE" "$LEGACY")
if [ "$LEGACY_HTTP" != "200" ]; then
  echo "ERROR: GET /api/memos returned $LEGACY_HTTP"
  cat "$LEGACY_TMP" | head -c 500
  exit 1
fi
LEGACY_TOTAL=$(jq 'length' "$LEGACY_TMP")
echo "  ✓ legacy: $LEGACY_TOTAL memos"
echo

PASS=0
WARN=0

# Print formatted table of POST /search response for visual parity
report_search() {
  local label="$1"
  local body="$2"
  local expected_total="${3:-}"

  echo "── $label"
  local tmp
  tmp=$(mktemp)
  local code
  code=$(curl -sS -o "$tmp" -w "%{http_code}" \
    -X POST "$SEARCH" \
    -H "Content-Type: application/json" \
    -H "Cookie: $COOKIE" \
    -d "$body")

  if [ "$code" != "200" ]; then
    echo "  ✗ HTTP $code"
    head -c 300 "$tmp"
    echo
    rm -f "$tmp"
    return
  fi

  local total page totalPages itemsLen firstId lastId
  total=$(jq '.total' "$tmp")
  page=$(jq '.page' "$tmp")
  totalPages=$(jq '.totalPages' "$tmp")
  itemsLen=$(jq '.items | length' "$tmp")
  firstId=$(jq -r '.items[0].id // "-"' "$tmp")
  lastId=$(jq -r '.items[-1].id // "-"' "$tmp")
  printf "  total=%s pages=%s items=%s first=%s last=%s\n" \
    "$total" "$totalPages" "$itemsLen" "$firstId" "$lastId"

  if [ -n "$expected_total" ]; then
    if [ "$total" = "$expected_total" ]; then
      echo "  ✓ total matches expected ($expected_total)"
      PASS=$((PASS + 1))
    else
      echo "  ⚠ total=$total expected=$expected_total"
      WARN=$((WARN + 1))
    fi
  fi
  rm -f "$tmp"
}

# Compute legacy "ALL" count after applying client-side hide rules
# (Deleted + Draft-of-others). This should match POST /search total
# for view=ALL with no other filters.
me_id=$(curl -sS -H "Cookie: $COOKIE" "$BASE_URL/api/me" | jq -r '.id // empty')
if [ -z "$me_id" ]; then
  echo "WARN: could not resolve current user id from /api/me"
  ME_FILTERED_LEGACY="$LEGACY_TOTAL"
else
  # legacy already excludes Deleted server-side; drafts of others are also
  # filtered server-side in getAllMemos. So legacy length ≈ "ALL".
  ME_FILTERED_LEGACY="$LEGACY_TOTAL"
fi

# Counts by status from legacy data
LEGACY_DRAFT=$(jq '[.[] | select(.status=="Draft")] | length' "$LEGACY_TMP")
LEGACY_PROCESSING=$(jq '[.[] | select(.status=="Processing")] | length' "$LEGACY_TMP")
LEGACY_APPROVED=$(jq '[.[] | select(.status=="Approved")] | length' "$LEGACY_TMP")
LEGACY_REJECTED=$(jq '[.[] | select(.status=="Rejected")] | length' "$LEGACY_TMP")
LEGACY_TERMINATED=$(jq '[.[] | select(.status=="Terminated")] | length' "$LEGACY_TMP")

echo "Legacy status breakdown:"
echo "  Draft=$LEGACY_DRAFT  Processing=$LEGACY_PROCESSING"
echo "  Approved=$LEGACY_APPROVED  Rejected=$LEGACY_REJECTED  Terminated=$LEGACY_TERMINATED"
echo

# ─────────────────────────────────────────────────────────────────────
# 13 combos
# ─────────────────────────────────────────────────────────────────────

echo "============================================================"
echo " Equivalence: POST /api/memos/search vs GET /api/memos"
echo "============================================================"

# 1. view=ALL — total should match legacy length
report_search "1. view=ALL, page=1, sort=createdAt desc" \
  '{"page":1,"pageSize":10,"view":"ALL","sortBy":"createdAt","sortDir":"desc","includeStatCounts":true,"includeFacets":true}' \
  "$ME_FILTERED_LEGACY"

# 2. view=MY_APPROVAL — verify number is reasonable (manual visual check)
report_search "2. view=MY_APPROVAL" \
  '{"page":1,"pageSize":10,"view":"MY_APPROVAL","includeStatCounts":true}'

# 3. view=MY_CREATED — should == count where user.id === me_id
LEGACY_MY_CREATED=$(jq --argjson me "$me_id" '[.[] | select(.user.id == $me)] | length' "$LEGACY_TMP")
report_search "3. view=MY_CREATED" \
  '{"page":1,"pageSize":10,"view":"MY_CREATED","includeStatCounts":true}' \
  "$LEGACY_MY_CREATED"

# 4. status=Processing — verify against legacy count
report_search "4. status=Processing" \
  '{"page":1,"pageSize":10,"status":"Processing","includeStatCounts":true}' \
  "$LEGACY_PROCESSING"

# 5. statuses=[Approved] (multi-select via header column)
report_search "5. statuses=[Approved]" \
  '{"page":1,"pageSize":10,"statuses":["Approved"]}' \
  "$LEGACY_APPROVED"

# 6. search="MEMO-1" (document code pattern → exact id=1 match)
report_search "6. search='MEMO-1' (id pattern)" \
  '{"page":1,"pageSize":10,"search":"MEMO-1"}'

# 7. search="memo" (broad text)
report_search "7. search='memo' (broad)" \
  '{"page":1,"pageSize":10,"search":"memo"}'

# 8. subjectContains
report_search "8. subjectContains='test'" \
  '{"page":1,"pageSize":10,"subjectContains":"test"}'

# 9. sort by latestAction
report_search "9. sortBy=latestAction desc" \
  '{"page":1,"pageSize":10,"sortBy":"latestAction","sortDir":"desc"}'

# 10. sort by subject asc (tests collation order)
report_search "10. sortBy=subject asc" \
  '{"page":1,"pageSize":10,"sortBy":"subject","sortDir":"asc"}'

# 11. combination
report_search "11. status=Processing + sort=createdAt asc + page=2" \
  '{"page":2,"pageSize":5,"status":"Processing","sortBy":"createdAt","sortDir":"asc"}'

# 12. page beyond total (clamped/empty)
report_search "12. page=99999 (beyond total)" \
  '{"page":99999,"pageSize":10}'

# 13. pageSize="all"
echo "── 13. pageSize=all (skipped if dataset huge — manual check)"
TMP=$(mktemp)
code=$(curl -sS -o "$TMP" -w "%{http_code}" \
  -X POST "$SEARCH" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{"page":1,"pageSize":"all","includeStatCounts":true}')
if [ "$code" = "200" ]; then
  total=$(jq '.total' "$TMP")
  itemsLen=$(jq '.items | length' "$TMP")
  echo "  total=$total items=$itemsLen"
  if [ "$total" = "$itemsLen" ]; then
    echo "  ✓ pageSize=all returned all items"
    PASS=$((PASS + 1))
  else
    echo "  ⚠ items returned ($itemsLen) != total ($total)"
    WARN=$((WARN + 1))
  fi
fi
rm -f "$TMP"

# ─────────────────────────────────────────────────────────────────────
# StatCounts equivalence
# ─────────────────────────────────────────────────────────────────────

echo
echo "============================================================"
echo " StatCounts vs Legacy"
echo "============================================================"

TMP=$(mktemp)
curl -sS -X POST "$SEARCH" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{"page":1,"pageSize":1,"view":"ALL","includeStatCounts":true}' \
  -o "$TMP"

SC_TOTAL=$(jq '.statCounts.total' "$TMP")
SC_DRAFT=$(jq '.statCounts.Draft' "$TMP")
SC_PROC=$(jq '.statCounts.Processing' "$TMP")
SC_APPROVED=$(jq '.statCounts.Approved' "$TMP")
SC_REJECTED=$(jq '.statCounts.Rejected' "$TMP")
SC_TERMINATED=$(jq '.statCounts.Terminated' "$TMP")

printf "                  %-12s %-12s %s\n" "search" "legacy" "match"
check() {
  local label="$1" sv="$2" lv="$3"
  if [ "$sv" = "$lv" ]; then
    printf "  %-15s %-12s %-12s ✓\n" "$label" "$sv" "$lv"
    PASS=$((PASS + 1))
  else
    printf "  %-15s %-12s %-12s ⚠\n" "$label" "$sv" "$lv"
    WARN=$((WARN + 1))
  fi
}
check "total"       "$SC_TOTAL"      "$LEGACY_TOTAL"
check "Draft"       "$SC_DRAFT"      "$LEGACY_DRAFT"
check "Processing"  "$SC_PROC"       "$LEGACY_PROCESSING"
check "Approved"    "$SC_APPROVED"   "$LEGACY_APPROVED"
check "Rejected"    "$SC_REJECTED"   "$LEGACY_REJECTED"
check "Terminated"  "$SC_TERMINATED" "$LEGACY_TERMINATED"
rm -f "$TMP"

# ─────────────────────────────────────────────────────────────────────
# ID set comparison for view=ALL pageSize=all
# ─────────────────────────────────────────────────────────────────────

echo
echo "============================================================"
echo " ID Set Parity (view=ALL, full set)"
echo "============================================================"

TMP=$(mktemp)
curl -sS -X POST "$SEARCH" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{"pageSize":"all","view":"ALL"}' -o "$TMP"

LEGACY_IDS=$(mktemp)
SEARCH_IDS=$(mktemp)
jq -r '.[].id' "$LEGACY_TMP" | sort -n > "$LEGACY_IDS"
jq -r '.items[].id' "$TMP"  | sort -n > "$SEARCH_IDS"

ONLY_LEGACY=$(comm -23 "$LEGACY_IDS" "$SEARCH_IDS" | wc -l)
ONLY_SEARCH=$(comm -13 "$LEGACY_IDS" "$SEARCH_IDS" | wc -l)
COMMON=$(comm -12 "$LEGACY_IDS" "$SEARCH_IDS" | wc -l)

echo "  legacy ids:  $(wc -l < "$LEGACY_IDS")"
echo "  search ids:  $(wc -l < "$SEARCH_IDS")"
echo "  in common:   $COMMON"
echo "  only legacy: $ONLY_LEGACY"
echo "  only search: $ONLY_SEARCH"

if [ "$ONLY_LEGACY" -eq 0 ] && [ "$ONLY_SEARCH" -eq 0 ]; then
  echo "  ✓ ID sets are identical"
  PASS=$((PASS + 1))
else
  echo "  ⚠ ID sets differ — sample diff (first 10 each):"
  echo "    only in legacy:"; comm -23 "$LEGACY_IDS" "$SEARCH_IDS" | head -10 | sed 's/^/      /'
  echo "    only in search:"; comm -13 "$LEGACY_IDS" "$SEARCH_IDS" | head -10 | sed 's/^/      /'
  WARN=$((WARN + 1))
fi
rm -f "$TMP" "$LEGACY_IDS" "$SEARCH_IDS" "$LEGACY_TMP"

# ─────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────

echo
echo "============================================================"
echo " Summary: $PASS passed, $WARN warnings"
echo "============================================================"
[ "$WARN" -eq 0 ]
