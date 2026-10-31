# Bring your data with you

Give your static site personal data that follows people from one device to the
next, without building an account system or running your own server. Burrow turns
a few `get`/`set` calls into encrypted cloud storage, unlocked with a storage token
or a passkey-derived token. Start with the core, and add optional offline support
when you want people to keep working through a lost connection.

The [demo](https://froussios.github.io/burrow-storage/v2.html?scenario=core) lets you
save content and a theme, then reconnect on another device with the same token or
passkey. Compare remote-only storage with the optional offline wrapper, which
keeps an unencrypted content copy on the device and syncs changes later. The
demo's token-remembering option belongs to the app; Burrow never stores tokens.

Use your own Firestore project for cloud storage. Begin with the
[quick start](../README.md#quick-start), or explore the [API](api.md).
