# Demo: user journeys

These journeys define what a person can do in the main demo (`demo/index.html`,
deployed at <https://froussios.github.io/burrow-storage/>), and drive its browser
and deployment smoke tests.

## Selectable scenarios

`demo/index.html?scenario=core` and `demo/index.html?scenario=offline` open separate
scenarios. The sidebar lists **Remote only** (the core) first, followed by
**Remote + offline**. An absent scenario selects `core`; an unknown value shows
the index without opening a store. This scenario UI is the main demo at the
project's root URL. Published `v2.html` links serve the same page.
`demo:build` packages and stamps both pages.

The header links to [an introduction to Burrow](overview.md), so visitors arriving
directly at the demo can see what the library provides.

The editor shows **Last cloud read** and **Last cloud save**, using the device's
clock. These are successful encrypted-document requests, including initial reads
and background offline replay; local-copy reads, queued edits and failed
requests do not advance them. An empty cloud response still counts as a
confirmed read. The demo remembers only these times on this device, separately
for each app and token, under a one-way fingerprint. It stores neither the token
nor any encryption/write key in that history. Reconnecting restores each earlier
timestamp with **(not from this session)** until the current session confirms a
newer request of that kind. With no recorded timestamp, it shows **Not
recorded**. Sign-out clears the display but retains this timestamp history; if
browser storage is unavailable, current confirmations still display normally.
These are not server modification times or a promise that every pending edit has
synced; the status badge reports pending work. The demo observes its backend
without changing the library API or storing timestamps with user content. Cached
subscription notifications alone do not count as cloud reads. The supplied
Firestore demo setup is instrumented; a custom backend needs equivalent
demo-side request observation.

- **Remote only / Core lib, backed by Firebase** uses app `burrow-demo-v2-core`.
  It keeps no persistent content copy. Remote failures are shown as failed saves,
  with confirmation before abandoning an unsaved edit.
- **Remote + offline** uses app `burrow-demo-v2-offline` and the same async editor
  over `offline(core)`. It keeps a plaintext content copy in IndexedDB. Reopening
  that copy still requires its token; caching content does not remember a token.

Token custody is a separate **demo option**, independent of library selection.
Each of the **Returning user** and **New user** cards has its own **Remember token
on this device** checkbox, unchecked by default in both library scenarios. The
explanation is in a tooltip accessible by hover, focus or tap; a second tap,
Escape and outside clicks dismiss it.
When unchecked, the token stays in memory for the visit. The user must keep it
or obtain it again from their passkey to reopen the scenario. **Create token
only** explicitly tells the user that no passkey is created and the demo will not
store the token: write it down or save it in a password manager before leaving.

When remembering is selected, the demo saves the token unencrypted in its own
localStorage record, `${app}:token`, and reopens it next visit. This works with
either library setup; neither Burrow core nor the offline wrapper persists the
token. The page describes that anyone who can read the browser's files can use
the token, and tells the user to keep a separate copy. A failed token save leaves
it in memory and explicitly tells the user to keep it themselves.

The setup area has one enclosing box containing only the Returning user and
New user sections, with a visible **OR** between them. The scenario explainer
lives in the sidebar. Library actions have a collapsed terminal-icon **Code**
disclosure directly beside their controls. There is no central code catalog or
shared setup file. Short examples show the API calls for passkey retrieval, manual connection, passkey
creation, random tokens, theme, content reads/writes and sign-out.
Remember token on this device, Copy token and Export JSON have no snippets;
remembering still has tooltip help. Examples never contain live user tokens
or content, and `docs:check` type-checks the displayed examples against the public
API for both scenarios. These focused examples omit the demo's surrounding UI,
session management and error reporting; they are not copies of its full handlers.
**Returning user**, with undertitle **Reconnect to your data**, groups **Get token
from passkey** with the token-entry form. **New user**, with undertitle **Create a
new token**, groups the two creation actions. Each action reads only its own
card's remembering choice. All actions have equal button styling.

The editor is labelled **Content**: it is saved text, with no draft-to-published
step. Once connected, it explains that content saves automatically after a short
pause in typing.
The write snippets explain that object property names are storage keys and that
writes update only the provided keys, preserving other keys' values.

The content and theme controls are always visible. They are disabled while setup
is required, including after sign-out or a refused token, and enabled after the
initial content read finishes. Token details appear only after setup. A remote
failure after setup does not disable the editor. The sidebar contains the library scenarios and their setup explanations.

New random tokens and passkey-derived tokens are separate per scenario. Passkey
creation labels include the scenario; selecting an existing credential still
derives a different token for each app. A deliberately reused pasted token cannot
reveal another scenario's content because document derivation includes the app
namespace. The app namespaces are retained when promoting the scenario demo.

Switching scenarios waits for pending editor writes to reach the selected store
(or the offline copy). It does not sign out the other scenario or erase its data.
Without a remembered token, returning requires a token or passkey again. Signing
out removes only the selected scenario's demo token record and, for the offline
wrapper, its local content copy. Remote content remains available with the token.
Removing a remembered token also signs out other tabs that were using it.

The storage-specific branches are initialization, offline status/change
subscriptions and offline `forget()` on sign-out. Token remembering is shared
demo code for both scenarios. Both use the same editor, export and theme code.
More divergent scenarios should be called out when added.

`test/e2e/demo.spec.ts` covers navigation, reloads, offline replay, remote
namespace isolation, core failures, passkey separation and independent token
custody, including storage failure. It uses real crypto and a shared memory
backend; it never contacts the live project.

## Terms

- **Storage token**: the client-held secret that grants access to one user's data.
- **Passkey token**: a storage token derived from a passkey for the selected app.
- **Remote only**: the core stores content encrypted on the backend, without a local content copy.
- **Remote + offline**: the same API over an optional unencrypted IndexedDB copy.
- **Remember token**: a separate app-owned choice, available in either scenario.
  It keeps the token unencrypted on this device until sign-out.

## Journeys to preserve

| Journey | Expected behavior | Coverage |
| --- | --- | --- |
| New user | Create a random token or a passkey and token explicitly; explain token custody | `demo.spec.ts`, `passkey.spec.ts` |
| Returning user | Restore access with a passkey or a saved token | `demo.spec.ts`, `passkey.spec.ts` |
| Another device | The same token and scenario recover the same encrypted content | Browser scenarios and deployed smoke tests |
| Offline use | Queue content locally and replay when reachable; show earlier cloud times until confirmed | `demo.spec.ts` |
| Sign-out | Remove the token record and offline content copy; ask before discarding unsynced writes | `demo.spec.ts` |
| Token transport | A token in the URL does not sign the user in | `demo.spec.ts` |

The main demo keeps the content area visible and disabled until setup completes.
There is no older sign-in-mode page; scenarios and token remembering are independent.
