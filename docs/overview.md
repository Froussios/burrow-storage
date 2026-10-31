# Multi-device storage without an identity backend

Burrow gives static apps encrypted, user-scoped storage spaces across devices
without maintaining server-side user records or app registrations. Access travels
through the user's password manager as a synced passkey or a saved storage token.
The browser derives each app's storage addresses and keys locally, so one shared
backend serves independent users and apps using opaque encrypted documents.

[Try Burrow](https://froussios.github.io/burrow-storage/v2.html?scenario=core) ·
[Quick start](../README.md#quick-start) · [API reference](api.md)
