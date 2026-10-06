# Firestore rules and emulator config

The files Burrow's reference backend needs on the store side. `npx burrow-setup firestore` walks
through creating a project and deploying them; the full guide, including costs, quotas and the
API-key restriction, is [docs/firestore-setup.md](../docs/firestore-setup.md).

- `firestore.rules` — the id-as-capability rules: `get` for anyone, no `list`, no `delete`,
  `create` at revision 0, `update` only at the next revision with a token whose SHA-256 matches
  the stored commitment. The collection is `burrow`; if you use `FirestoreBackend({ collection })`
  with another name, change it here too.
- `firebase.json` — points the Firebase CLI at the rules and configures the emulator (port 8080,
  no UI).
- `tests/` — emulator tests for every rule (`cd tests && npm ci && npm test`, or
  `npm run test:rules` from the repository root). Needs Java 21.

Deploy to your project:

```sh
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules --project <your-project-id>
```

Stay on the Spark plan. Do not enable Blaze, Authentication, Storage or Functions; nothing here
needs them, and Spark's hard quotas are what make abuse a nuisance rather than a bill.
