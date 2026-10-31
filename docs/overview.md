# Multi-device storage without an identity backend

Burrow gives static apps encrypted, user-scoped storage spaces without maintaining
server-side user records or app registrations. Access can follow users across
devices through their password manager, as a synced passkey or a saved storage
token; Burrow never stores the token. The browser derives each app's addresses and
keys locally, so your shared backend serves independent users and apps, storing
encrypted documents under opaque IDs.

[Try Burrow](https://froussios.github.io/burrow-storage/v2.html?scenario=core) ·
[Set up your Firestore project](../README.md#quick-start) · [API reference](api.md)
