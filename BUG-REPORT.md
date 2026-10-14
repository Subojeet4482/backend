# Bug Report — `chat-render-final-v9` (backend) + `user-panel-v6` (frontend)

Dono projects pura padhe (backend 69 files, frontend 135 files), phir **asli code chalakar** test kiya (fake Firestore + simulated browser).
Fixed versions: `chat-render-final-v10-fixed.zip` aur `user-panel-v7-fixed.zip`.

## Ek nazar mein

| # | Bug | Kitna bada | File |
|---|-----|-----------|------|
| 1 | Admin approve / reject / refund (withdraw + deposit) **sab crash** — `money()` define hi nahi hai | 🔴 Critical | `wallet.js` |
| 2 | **Stored XSS** — kisi bhi user ka naam / photo URL dusron ke browser mein script chala sakta hai (token chori → paisa nikalna) | 🔴 Critical | `userapi.js`, `wallet.js`, chat `routes.js`, `rank.js` + chat renderers |
| 3 | Login: shared IP par **rate limit (120/min)** ke wajah se `/me` 429 → login fail | 🟠 High | `svc.js`, `http.js`, `live.js` |
| 4 | Login: Render cold start par login fail (no timeout, no retry) | 🟠 High | `api.js` |
| 5 | Login: 4 Oct 2026 se **pehle ke users** email-verify na hone par block | 🟠 High | `api.js` |
| 6 | Token refresh par koi bhi 503/429 aaye to user **logout** | 🟠 High | `api.js` |
| 7 | Admin panel ke **Reports / Groups / DMs** galat database padhte hain (hamesha khali) | 🟠 High | `adminapi.js` |
| 8 | Match: cancel (refund) ke baad complete → dobara prize pay ho sakta hai; fee badalne par galat refund | 🟡 Medium | `adminapi.js` |
| 9 | Daily cron ek step fail hote hi pura abort (monthly rewards bhi nahi chalte) | 🟡 Medium | `routes.js` |
| 10 | Logout ke dauran refresh chal raha ho to purana session wapas zinda ("zombie") | 🟡 Medium | `api.js` |
| 11 | Login/logout events overlap → logout ke baad bhi polling chalti rehti hai | 🟡 Medium | `auth-state.js` |
| 12 | History fail hone par balance update freeze; payment app se wapas aane par "Deposit Credited" toast lost | 🟡 Medium | `live.js` |
| 13 | Password reset: har error "link expired" dikhata hai; reset 6 char, register 8 char | 🟢 Low | `api.js`, `forgot.js` |
| 14 | Guest ko "No Matches Found" (asal mein login chahiye); double-submit; cache logout par clear nahi | 🟢 Low | `home.js`, `login.js`, `api.js` |

---

## A. Login problem — asli kaaran (sab reproduce kiye)

Pehle ek zaroori baat: panel **login seedha Firebase REST se karta hai** (`api.login`), backend ka `/auth/login` use hi nahi hota. Backend sirf aakhir mein `GET /me` se token verify karta hai. Isliye login ke 3 tootne ke point hain: Firebase, `/me`, aur baad ka session.

**1. Rate limit (sabse common)** — Backend har IP ko 120 request/minute deta tha, aur panel har logged-in tab se ~24 request/minute bhejta tha (`/me` + `/wallet/history` har 6 sec, `/matches` har 15 sec).
Test: 4 users ek IP par = OK. **5 users = 121vi request par 429**. 6 users = 150 mein se 30 block. 8 users = 200 mein se 80 block.
Login ka aakhri step `/me` hai → "Error 1110688: Too many requests", **password sahi hone ke bawajood login fail**. (WiFi / hostel / mobile CGNAT par yahi hota hai.)
Fix: limit default 600/min; `live.js` ab history har tick nahi mangta (24 → 16 request/min per tab).

**2. Render cold start** — `fetch` par timeout nahi tha, aur `/me` 502/timeout par login seedha fail ("Server is busy").
Fix: har request par 25s timeout; GET retry; login ke `/me` par 5 koshish + button par "Server is waking up…". **POST kabhi auto-retry nahi hota** (double pay/join se bachne ke liye).

**3. Purane users block** — `api.login` har kisi se email verification maangta hai. Purana rule ("4 Oct 2026 se pehle bane accounts exempt") sirf dead code mein bacha tha (`currentUser()` ne `emailVerified: true` hard-code kar diya).
Fix: Firebase `createdAt` se wahi rule wapas. Naye accounts ko verify karna hi padega (aur asli gate backend ka `/me` hai).

**4. Refresh par logout** — `refresh()` har non-OK jawab par `logout()` karta tha, 503/429 par bhi. Ab sirf pakke 4xx (token revoked / user disabled / key problem) par logout; 5xx / 429 / offline par session bachta hai.
**Config note:** Browser key ke *API restrictions* mein **"Token Service API"** zaroor ho, warna har ~1 ghante baad logout hoga.

**5. Zombie session** — logout ke waqt refresh in-flight ho to wo purane user ke tokens `localStorage` mein wapas likh deta tha. Fixed + purane toote hue session load par saaf hote hain.

**6. auth-state race** — login handler `await` karta hai; beech mein logout aaye to login baad mein `live.start()` chala deta tha (logged-out session par har 6 sec 401). Ab events ek-ek karke chalte hain, purana event ruk jata hai.

**7. Chhote** — Enter + button tap se double login; password reset ka har error "link invalid/expired" dikhana (weak password / network par bhi); reset min 6 vs register min 8 (ab dono 8); logout par cache clear nahi.

**Jo maine NAHI badla (aapka faisla):** backend ka `/auth/login` (brute-force counter, IP block, ban check) panel use hi nahi karta — user password login par sirf Firebase ka apna throttling lagta hai. Ban abhi bhi server par enforce hota hai (withdraw, deposit, join, transfer mein check hai). Agar backend-side login protection chahiye to login ko backend se route karna padega — bada change hai, alag se karna chahiye.

---

## B. Baaki bade bugs

**1. `money()` undefined (🔴)** — `wallet.js` mein `decideWithdraw` aur `decideDeposit` `money(t.amount)` bulate hain, par ye function kahin define nahi tha.
Test: approve / reject / refund (withdraw) aur approve / reject (deposit) — **paanchon `ReferenceError: money is not defined`**. Matlab panel aur Telegram bot dono se koi withdrawal approve/reject nahi ho sakta tha; user ka paisa pending mein atka rehta.
Fix: helper add kiya (`"-₹100"` → `100`). Test ke baad: approve → `totalWithdrawn +100`; refund → `withdrawBalance +100`; deposit approve → `+50.5`.

**2. Stored XSS (🔴)** — `PUT /me/profile` mein `appName` sirf trim + length check hota tha; `photoUrl` ka regex `https://\S{5,480}` mein `"` bhi chalta tha; `joinMatch` mein `gameName` bhi unfiltered. `rank.js` ye sab seedha `innerHTML` mein daalta tha. Token `localStorage` mein hai, aur withdraw ke liye password nahi chahiye → ek attacker dusron ka balance apne UPI par nikal sakta tha.
Test: `appName = <img src=x onerror=alert(1)>` aur `photoUrl = https://x.com/a"onerror="…` **200 OK se save hue** aur `/leaderboard` ke through victim ko mile. Original `rank.js` par 4 payload chale; fixed par sab inert.
Fix (dono taraf): server `<`, `>`, control chars aur photo URL mein `" ' < > \ \`` reject karta hai (main + chat profile + joinMatch); frontend mein `rank.js`, `home.js`, `join.js`, chat renderers (`messages.js` ka `_safe` ab quotes bhi escape karta hai) mein escape lagaya.
**Dhyan:** agar pehle se kisi ne aisa data save kar diya ho to wo database mein rahega — upar wale pages ab usse escape karke dikhate hain, par ek baar `users` aur chat `profiles` mein `<` wale naam / photoUrl search karke saaf kar dena.

**3. Admin Reports / Groups / DMs galat DB (🟠)** — v7 ke baad chat service reports, groups, DMs **CHAT Firestore** mein rakhti hai, par admin API abhi bhi **MAIN** padh rahi thi (comment mein bhi likha tha "until the app is moved"). Panel mein ye screens hamesha khali; resolve / hide / delete galat DB par chalte.
Fix: pehle CHAT, phir purana MAIN data (duplicate hata kar). 404 ab sahi aata hai (pehle 500).

**4. Match state machine (🟡)** — `/complete` blind `update()` tha: galat id par 500, aur **cancelled (refund ho chuka) match ko complete karke phir prize pay** ho sakta tha (double payout). `PUT` se players ke join ke baad `fee` badalne par cancel galat amount refund karta. Fix: complete cancelled par 409; fee join ke baad lock; `total` joined se kam nahi.

**5. Daily cron (🟡)** — `archiveOld`, purge, cleanup, monthly reward sab ek hi chain mein the; ek fail = baaki sab skip, aur job 4 baar retry hoke chhod diya jata. Test (missing collection-group index simulate): original **500**, fixed **200** + baaki steps chale + Telegram mein failed step dikhta hai. Chat ka cron bhi isolate kiya.
**Firestore note:** `archiveOld` ko `transactions.createdAt` par **collection-group index** chahiye. Agar daily job message mein "archiveOld: FAILED_PRECONDITION" aaye to error mein diya link kholkar index bana dein.

**6. `live.js` (🟡)** — `Promise.all([/me, /wallet/history])`: history 429 de (4+ tabs mein `/wallet/history` ki 30/min limit) to balance bhi update nahi hota. Aur tab/app badalne par watcher restart hone se "Deposit Credited" toast gaayab (UPI app se wapas aane par yahi hota hai). Fix: alag-alag fail, state bachi rehti hai, overlapping tick nahi.

---

## C. Jo bug nahi nikle (check kiya)
- `_sheetEl` / `ui` / `chat` / `openSheet` — `window` par define hain, theek.
- Notification "Claim" balance nahi badhata — jaan-boojhkar (code mein likha hai: user apna balance nahi badha sakta).
- Ban server par enforce hota hai (withdraw / deposit / join / transfer).
- `cleanupPending` sirf purane unverified naye-flow accounts hatata hai, purane users ko nahi.
- Shared lib copies (`core` / `chat` / `shared`) identical hain.
- Koi syntax error nahi; undefined variable sirf `money` tha.

## D. Aapke faisle / dhyan dene wali baatein (maine badla nahi)
1. **Client IP** — `server.js` pehle `cf-connecting-ip`, phir `x-forwarded-for` ka pehla hissa lagata hai. Render par ye kaise aata hai, check kar lein; agar spoof ho sakta hai to rate-limit / IP-block bypass ho sakta hai.
2. **IP block** — 5 galat login / ghanta = 24 ghante IP block, user + admin login ka counter shared hai.
3. **Cancel refund** — fee hamesha `depositBalance` mein wapas jata hai; jo hissa `withdrawBalance` se kata tha wo ab nikala nahi ja sakta.
4. **`/wallet/recipient`** — Player ID se naam dikhata hai (30/min limit), enumerate ho sakta hai.
5. Google-login users transfer nahi kar sakte (password verify hota hai).
6. Firestore `config/security` mein `globalLimit` pehle se save ho (Telegram bot se) to naya default 600 lagu nahi hoga — wahan se badhayein.
7. **Admin panel ka frontend zip mein nahi tha** — uska UI review nahi hua (sirf `/admin/*` backend dekha).

## E. Kaise test kiya (aur limit)
- Syntax: dono projects ke saare JS files. Undefined-variable scan (AST se): backend **2 → 0**.
- Backend: asli `http.js` + saare routes ek local server par, fake Firestore ke saath — **120 routes** smoke test (pehle 1 crash, ab 0), **28 behaviour checks** (XSS, match guards, admin DB), money flows, rate-limit simulation, first-login profile creation.
- Frontend: asli `api.js` simulated browser mein — **30 checks** (retry, refresh, logout, grandfathering, reset errors), plus `live.js`, `auth-state.js`, `rank.js` ke before/after test.
- **Limit:** asli Firebase / Render / Telegram par test nahi ho sakta (network band). Deploy ke baad ek baar khud login, withdraw approve aur leaderboard check kar lein.

## F. Deploy steps
1. Backend zip redeploy (Render).
2. Frontend zip deploy (Netlify etc.).
3. Google Cloud → Browser key → API restrictions mein **Identity Toolkit API** + **Token Service API**.
4. UptimeRobot se `/health` ping (har 5 min) — free tier sleep se bachne ke liye.
5. Agar `globalLimit` Firestore mein save hai to Telegram bot se badhayein.
6. Deploy ke baad pehla daily-job message dekhein; "Failed steps" aaye to index banayein.
7. `users` / chat `profiles` mein `<` wale naam ya photoUrl search karke saaf karein.
