#!/usr/bin/env bash
# End-to-end smoke test through the real callable HTTP path with the Auth emulator.
# Run from the repo root:
#   npx --prefix functions firebase emulators:exec --project demo-escapes \
#     --only functions,firestore,auth "bash scripts/smoke-emulator.sh"
set -e
A=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
F=http://127.0.0.1:5001/demo-escapes/asia-south1
R=$(curl -s -X POST "$A/accounts:signUp?key=fake" -H 'Content-Type: application/json' -d '{"email":"alice@example.com","password":"secret123","returnSecureToken":true}')
TOK=$(echo "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0)).idToken')
USERID=$(echo "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0)).localId')
call(){ curl -s -X POST "$F/$1" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOK" -d "{\"data\":$2}"; echo; }
TRIP=$(call createTrip '{"name":"Smoke trip","idempotencyKey":"smoke-0001"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).result.tripId')
echo "trip=$TRIP"
P=$(call initiateUpiPayment "{\"tripId\":\"$TRIP\",\"qrPayload\":\"upi://pay?pa=cafe@okaxis&pn=Cafe&am=120.00\",\"platform\":\"ANDROID\",\"reviewConfirmed\":true,\"idempotencyKey\":\"smoke-0002\",\"expense\":{\"title\":\"Coffee\",\"participantUids\":[\"$USERID\"]}}")
echo "$P"
TX=$(echo "$P" | node -pe 'JSON.parse(require("fs").readFileSync(0)).result.transactionId')
call recordUpiClientResponse "{\"transactionId\":\"$TX\",\"platform\":\"ANDROID\",\"rawResponse\":\"Status=SUCCESS&responseCode=00\",\"idempotencyKey\":\"smoke-0003\"}"
call getTripSummary "{\"tripId\":\"$TRIP\"}" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0)).result; JSON.stringify(r.totals)'
