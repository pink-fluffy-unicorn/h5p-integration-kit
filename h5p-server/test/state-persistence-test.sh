#!/usr/bin/env bash
#
# Verifies that the saved states of learners ("Zwischenspeicherungen") survive a
# complete Docker update of the H5P server.
#
# The script creates a throwaway content object, stores a state and finished data for
# two different users, then removes the container AND the image, rebuilds everything
# and checks that the data is still there and is handed to the player again.
#
# Usage (from anywhere):
#   ./h5p-server/test/state-persistence-test.sh
#
# Requires: docker compose, curl, python3. The compose stack may be running or not.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${H5P_TEST_BASE_URL:-http://localhost:3000}"
USER_DATA_DIR="$REPO_ROOT/h5p-server/h5p/userdata"
USER_A="test-teilnehmer-a"
USER_B="test-teilnehmer-b"

failures=0

pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; failures=$((failures + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

wait_for_server() {
    for _ in $(seq 1 60); do
        curl -sf -m 2 "$BASE_URL/health" >/dev/null 2>&1 && return 0
        sleep 2
    done
    return 1
}

cleanup() {
    if [ -n "${CONTENT_ID:-}" ]; then
        curl -sf -o /dev/null -X DELETE "$BASE_URL/api/content/$CONTENT_ID" 2>/dev/null
    fi
}
trap cleanup EXIT

step "1. H5P server reachable?"
if ! wait_for_server; then
    echo "  Server not reachable at $BASE_URL - start it with 'docker compose up -d --build'."
    exit 1
fi
pass "$(curl -s "$BASE_URL/health")"

step "2. Create throwaway content"
CONTENT_ID=$(curl -s -X POST "$BASE_URL/api/save" -H 'Content-Type: application/json' -d '{
  "library": "H5P.MultiChoice 1.16",
  "metadata": { "title": "State persistence test", "license": "U", "defaultLanguage": "de" },
  "params": {
    "question": "<p>Testfrage</p>",
    "answers": [
      { "correct": true,  "text": "<div>A</div>", "tipsAndFeedback": { "tip": "", "chosenFeedback": "", "notChosenFeedback": "" } },
      { "correct": false, "text": "<div>B</div>", "tipsAndFeedback": { "tip": "", "chosenFeedback": "", "notChosenFeedback": "" } }
    ],
    "behaviour": { "enableRetry": true, "enableSolutionsButton": true, "enableCheckButton": true, "type": "auto", "singlePoint": false, "randomAnswers": false, "showSolutionsRequiresInput": true, "confirmCheckDialog": false, "confirmRetryDialog": false, "autoCheck": false, "passPercentage": 100, "showScorePoints": true }
  }
}' | python3 -c 'import sys, json; print(json.load(sys.stdin).get("contentId", ""))')

if [ -z "$CONTENT_ID" ]; then
    fail "Content could not be created (is H5P.MultiChoice 1.16 installed?)"
    exit 1
fi
pass "contentId=$CONTENT_ID"

step "3. Save states, as the H5P client would"
curl -sf -o /dev/null -X POST "$BASE_URL/contentUserData/$CONTENT_ID/state/0?userId=$USER_A" \
    -H 'Content-Type: application/json' \
    -d '{"data":"{\"answers\":[1]}","invalidate":0,"preload":1}' \
    && pass "state of $USER_A saved" || fail "state of $USER_A not saved"

curl -sf -o /dev/null -X POST "$BASE_URL/contentUserData/$CONTENT_ID/state/0?userId=$USER_B" \
    -H 'Content-Type: application/json' \
    -d '{"data":"{\"answers\":[0]}","invalidate":0,"preload":1}' \
    && pass "state of $USER_B saved" || fail "state of $USER_B not saved"

curl -sf -o /dev/null -X POST "$BASE_URL/finishedData?userId=$USER_A" \
    -H 'Content-Type: application/json' \
    -d "{\"contentId\":\"$CONTENT_ID\",\"score\":1,\"maxScore\":2,\"opened\":1,\"finished\":2,\"time\":1}" \
    && pass "finished data of $USER_A saved" || fail "finished data of $USER_A not saved"

step "4. Data outside of the container?"
if [ -f "$USER_DATA_DIR/$CONTENT_ID-userdata.json" ]; then
    pass "$USER_DATA_DIR/$CONTENT_ID-userdata.json exists on the host"
    BEFORE=$(md5sum "$USER_DATA_DIR/$CONTENT_ID-userdata.json" | cut -d' ' -f1)
else
    fail "no file below $USER_DATA_DIR - the state is only inside the container!"
    BEFORE=""
fi

step "5. Docker update: remove container and image, rebuild"
(cd "$REPO_ROOT" && docker compose down >/dev/null 2>&1)
docker image rm h5p-integration-kit/h5p-server:local >/dev/null 2>&1
(cd "$REPO_ROOT" && GID=$(id -g) docker compose up -d --build >/dev/null 2>&1)
if wait_for_server; then
    pass "server up again: $(curl -s "$BASE_URL/health")"
else
    fail "server did not come up again"
    exit 1
fi

step "6. Are the states still there?"
STATE_A=$(curl -s "$BASE_URL/contentUserData/$CONTENT_ID/state/0?userId=$USER_A" \
    | python3 -c 'import sys, json; print(json.load(sys.stdin).get("data") or "")')
[ "$STATE_A" = '{"answers":[1]}' ] && pass "state of $USER_A intact: $STATE_A" \
    || fail "state of $USER_A lost or changed: '$STATE_A'"

STATE_B=$(curl -s "$BASE_URL/contentUserData/$CONTENT_ID/state/0?userId=$USER_B" \
    | python3 -c 'import sys, json; print(json.load(sys.stdin).get("data") or "")')
[ "$STATE_B" = '{"answers":[0]}' ] && pass "state of $USER_B intact: $STATE_B" \
    || fail "state of $USER_B lost or changed: '$STATE_B'"

if [ -n "$BEFORE" ]; then
    AFTER=$(md5sum "$USER_DATA_DIR/$CONTENT_ID-userdata.json" 2>/dev/null | cut -d' ' -f1)
    [ "$BEFORE" = "$AFTER" ] && pass "file unchanged (md5 $AFTER)" || fail "file changed: $BEFORE -> $AFTER"
fi

grep -q "$USER_A" "$REPO_ROOT/h5p-server/h5p/userdata/$CONTENT_ID-finished.json" 2>/dev/null \
    && pass "finished data intact" || fail "finished data lost"

step "7. Does the player hand the state back to the client?"
curl -s "$BASE_URL/play/$CONTENT_ID?userId=$USER_A" \
    | grep -q '\\"answers\\":\[1\]' \
    && pass "H5PIntegration contains the state of $USER_A" \
    || fail "H5PIntegration does not contain the state - the learner would restart from scratch"

curl -s "$BASE_URL/play/$CONTENT_ID?userId=unbeteiligter-nutzer" \
    | grep -q '"contentUserData": \[\]' \
    && pass "an uninvolved user gets an empty state" \
    || fail "the state leaks to other users"

step "Result"
if [ "$failures" -eq 0 ]; then
    printf '\033[32mAll checks passed - the states survive a Docker update.\033[0m\n'
    exit 0
fi
printf '\033[31m%s check(s) failed.\033[0m\n' "$failures"
exit 1
