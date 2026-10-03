# Burrow — shared Firestore project (Spark)

Files for the one Firebase project every Burrow prototype shares. See the
requirements doc, sections "Reference backend: Firestore" (FS-1..FS-13).

- `firebase.json`     — points the CLI at the rules and configures the emulator.
- `firestore.rules`   — the id-as-capability rules with the SHA-256 write chain.
- `tests/`            — emulator tests for the FS-13 matrix. `cd tests && npm i && npm test`.

Deploy: `firebase login && firebase use <project-id> && firebase deploy --only firestore:rules`

Stay on Spark. Do not enable Blaze, Auth, Storage or Functions; nothing here needs them.
