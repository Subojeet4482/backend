# v7
Chat service (`chat/lib/social.js`, new): friends + requests, block, DMs, groups (roles, kick, invite, music box),
reactions / edit / delete (world, DM, group), reports, discover, presence (memory only), avatars, per-chat mute/pin/archive.
`chat/lib/routes.js`: richer /profile/:uid, photo upload (compressed data URLs), name+username search, /internal/profile-sync.
Core: POST /auth/google, GET /wallet/recipient, POST /wallet/transfer (atomic, password re-check, lockout), name sync to chat.
No new Firestore composite indexes are needed.
v7.1: /auth/register re-sends the verify link for unverified existing emails; /auth/login re-sends it when email is unverified; mail failures are no longer silent.
