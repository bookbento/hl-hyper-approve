#!/usr/bin/env bash
# Smoke test for POST /api/memos/search
#
# Usage:
#   1. Login via browser → DevTools → Application → Cookies
#      → copy the full "refreshToken=..." cookie value
#   2. Set env vars:
#        export COOKIE='refreshToken=eyJhbGciOiJI...'
#        export BASE_URL='http://localhost:3001'
#   3. bash scripts/smoke-search.sh
#
# Each test prints status + a JSON summary. Failures are highlighted.

set -u

COOKIE="${COOKIE:-}"
COOKIE='refreshToken=ey.....'
BASE_URL="${BASE_URL:-http://localhost:3001}"
URL="$BASE_URL/api/memos/search"

if [ -z "$COOKIE" ]; then
  echo "ERROR: set COOKIE env var (e.g. export COOKIE='refreshToken=...')"
  exit 1
fi

PASS=0
FAIL=0

run() {
  local name="$1"
  local body="$2"
  local expected_status="${3:-200}"

  echo
  echo "── TEST: $name ────────────────────────────"
  echo "  body: $body"

  local tmp_body
  tmp_body=$(mktemp)
  local http_code
  http_code=$(curl -sS -o "$tmp_body" -w "%{http_code}" \
    -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "Cookie: $COOKIE" \
    -d "$body")

  if [ "$http_code" = "$expected_status" ]; then
    echo "  ✓ status=$http_code"
    PASS=$((PASS + 1))
  else
    echo "  ✗ status=$http_code (expected $expected_status)"
    echo "  body: $(cat "$tmp_body" | head -c 500)"
    FAIL=$((FAIL + 1))
    rm -f "$tmp_body"
    return
  fi

  # Pretty-print summary: total, page, items length, has statCounts/facets
  if command -v jq >/dev/null 2>&1; then
    jq -r '
      "  total=" + (.total|tostring) +
      "  totalPages=" + (.totalPages|tostring) +
      "  page=" + (.page|tostring) +
      "  pageSize=" + (.pageSize|tostring) +
      "  items=" + (.items|length|tostring) +
      "  statCounts=" + (if .statCounts then "yes" else "no" end) +
      "  facets=" + (if .facets then "yes" else "no" end)
    ' < "$tmp_body" 2>/dev/null
  else
    echo "  (install jq for pretty summary)"
    head -c 300 "$tmp_body"
    echo
  fi
  rm -f "$tmp_body"
}

echo "========================================================"
echo "POST $URL"
echo "Cookie: ${COOKIE:0:30}..."
echo "========================================================"

# 1. Happy path — first load with stat + facets
run "1. first load (stat + facets)" \
  '{"page":1,"pageSize":10,"sortBy":"createdAt","sortDir":"desc","includeStatCounts":true,"includeFacets":true}'

# 2. Pagination — page 2 (no aggregates)
run "2. page 2 (no aggregates)" \
  '{"page":2,"pageSize":10,"sortBy":"createdAt","sortDir":"desc"}'

# 3. View MY_CREATED
run "3. view MY_CREATED" \
  '{"page":1,"pageSize":5,"view":"MY_CREATED","includeStatCounts":true}'

# 4. View MY_APPROVAL
run "4. view MY_APPROVAL" \
  '{"page":1,"pageSize":5,"view":"MY_APPROVAL","includeStatCounts":true}'

# 5. Free-text search
run "5. search 'budget'" \
  '{"page":1,"pageSize":5,"search":"budget"}'

# 6. Search by document code (MEMO-{id} pattern)
run "6. search 'MEMO-1'" \
  '{"page":1,"pageSize":5,"search":"MEMO-1"}'

# 7. Column filter — subjectContains
run "7. subjectContains 'test'" \
  '{"page":1,"pageSize":5,"subjectContains":"test"}'

# 8. Column filter — multi status
run "8. statuses=[Processing]" \
  '{"page":1,"pageSize":5,"statuses":["Processing"]}'

# 9. Sort by latestAction
run "9. sort by latestAction desc" \
  '{"page":1,"pageSize":5,"sortBy":"latestAction","sortDir":"desc"}'

# 10. Sort by subject asc
run "10. sort by subject asc" \
  '{"page":1,"pageSize":5,"sortBy":"subject","sortDir":"asc"}'

# 11. Date range (createdAt)
run "11. createdFrom + createdTo (last 30 days)" \
  "{\"page\":1,\"pageSize\":5,\"createdFrom\":\"$(date -d '30 days ago' +%Y-%m-%d 2>/dev/null || date -v-30d +%Y-%m-%d)\",\"createdTo\":\"$(date +%Y-%m-%d)\"}"

# 12. pageSize="all"
run "12. pageSize=all" \
  '{"page":1,"pageSize":"all"}'

# 13. Page beyond total
run "13. page 9999" \
  '{"page":9999,"pageSize":10}'

# ── INVALID INPUT (expect 400) ──
run "14. invalid pageSize=500" \
  '{"page":1,"pageSize":500}' \
  400

# ── NO AUTH (run without cookie, expect 401) ──
echo
echo "── TEST: 15. no auth (401) ────────────────────────────"
http_code=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d '{"page":1,"pageSize":10}')
if [ "$http_code" = "401" ]; then
  echo "  ✓ status=401"
  PASS=$((PASS + 1))
else
  echo "  ✗ status=$http_code (expected 401)"
  FAIL=$((FAIL + 1))
fi

echo
echo "========================================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================================"
[ "$FAIL" -eq 0 ]
