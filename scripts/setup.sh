#!/usr/bin/env bash
# One-shot setup of the shared Burrow Firestore project on the Spark plan.
# Needs: node 18+, gcloud (https://cloud.google.com/sdk), a Google account.
# Everything here is idempotent enough to re-run; already-exists errors are fine.
set -euo pipefail

PROJECT="${PROJECT:-burrow-storage-shared}"      # project id (also the display name)
LOCATION="${LOCATION:-australia-southeast1}"     # Firestore location; cannot be changed later
APP_NAME="${APP_NAME:-burrow}"
# Referrers allowed to use the web API key. Add every domain you deploy prototypes to.
REFERRERS="${REFERRERS:-https://froussios.github.io/*,http://localhost:*,http://127.0.0.1:*}"

npm ls -g firebase-tools >/dev/null 2>&1 || npm i -g firebase-tools

echo "== 1. sign in (browser opens once for each)"
firebase login --no-localhost 2>/dev/null || firebase login
gcloud auth login --brief

echo "== 2. create project (no billing account => Spark)"
firebase projects:create "$PROJECT" --display-name "$PROJECT" || echo "project exists, continuing"
gcloud config set project "$PROJECT"
firebase use "$PROJECT"

echo "== 3. enable + create Firestore (default db, native mode)"
gcloud services enable firestore.googleapis.com firebase.googleapis.com
firebase firestore:databases:create "(default)" --location "$LOCATION" \
  || gcloud firestore databases create --location="$LOCATION" \
  || echo "database exists, continuing"

echo "== 4. register the web app and fetch its config"
APP_ID=$(firebase apps:list WEB --json | node -e '
  const r=JSON.parse(require("fs").readFileSync(0,"utf8")).result||[];
  const a=r.find(x=>x.displayName===process.argv[1]); if(a) console.log(a.appId);' "$APP_NAME")
if [ -z "$APP_ID" ]; then
  APP_ID=$(firebase apps:create WEB "$APP_NAME" --json | node -e '
    console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).result.appId)')
fi
firebase apps:sdkconfig WEB "$APP_ID" --json | node -e '
  const c=JSON.parse(require("fs").readFileSync(0,"utf8")).result.sdkConfig;
  const t={apiKey:c.apiKey,projectId:c.projectId,appId:c.appId};
  require("fs").writeFileSync("burrow.firestore.json",JSON.stringify(t,null,2)+"\n");
  console.log(JSON.stringify(t));'
echo "   wrote burrow.firestore.json (the three fields the adapter uses)"

echo "== 5. restrict the auto-created browser key to Firestore + your domains"
KEY_NAME=$(gcloud services api-keys list --format='value(name)' \
  --filter='displayName~"Browser key"' | head -n1)
if [ -n "$KEY_NAME" ]; then
  gcloud services api-keys update "$KEY_NAME" \
    --allowed-referrers="$REFERRERS" \
    --api-target=service=firestore.googleapis.com
else
  echo "   no 'Browser key' found yet; rerun step 5 after the first app config fetch"
fi

echo "== 6. deploy rules"
firebase deploy --only firestore:rules --project "$PROJECT"

echo "== 7. run the rules tests against the emulator"
( cd tests && npm install --silent && npm test )

echo "done. Project: $PROJECT  App: $APP_ID"
