# Multi-device storage without an identity backend

Burrow gives static apps encrypted, user-scoped storage spaces without maintaining
server-side user records or app registrations. User content is stored encrypted
on the server. Login information and the master key stay on the client side;
neither Burrow nor your app stores them on its backend. The user's password
manager controls credential syncing across devices, and syncs only when the user
has chosen to enable it.

[Try Burrow](https://froussios.github.io/burrow-storage/v2.html?scenario=core) ·
[Set up your Firestore project](../README.md#quick-start) · [API reference](api.md)
