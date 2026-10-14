<div align="center">

# 📱 Telegram Account Manager Bot

**Connect many Telegram accounts. Get their messages in one place. Send from all of them with one command.**

[**Open the bot → @telethon_manager_bot**](https://t.me/telethon_manager_bot)

`Python 3.11+` · `Telethon` · `python-telegram-bot` · `Firebase Firestore` · `207 tests passing`

</div>

---

## Contents

[Features](#-features) · [Quick start](#-quick-start) · [Using the bot](#-using-the-bot) · [Connecting an account](#-connecting-an-account) · [Forwarding](#-what-gets-forwarded) · [Bulk actions](#-bulk-actions) · [Admins](#-owner-and-admins) · [Configuration](#-configuration) · [Data](#-where-data-is-stored) · [Logs & health](#-live-logs-and-health) · [Deploy](#-deployment) · [Tests](#-tests) · [Layout](#-project-layout)

---

## ✨ Features

- **Many accounts, one bot.** Log in with a phone number (+ 2-step password) or a Telethon session string.
- **Forwarding inbox.** Incoming messages from your accounts arrive in the bot, sorted into **user (DMs) / bot / channel (everything else)**, each with its own on/off switch. Reply or react to a forwarded message and it is sent back through the right account.
- **Bulk actions with live progress.** Message or block one user from all your accounts, with a delay between accounts. One message updates as it goes: a progress bar, how many went through, how many failed, how many are left.
- **`/multi`.** Message a user from only the accounts you tick.
- **Timed messages.** Send now, or after a wait (minutes up to 24 hours), from one account or many.
- **Account profile.** Change an account's name, bio and profile photo from the bot.
- **Daily broadcast.** Schedule a message to go out at set times from **all accounts or only the ones you tick** (multi broadcast).
- **Auto-click buttons.** `/all @bot hello [follow] (join)` presses the bot's inline buttons by name, and joins the channel behind a link button.
- **Refresh.** 🔄 Refresh on the accounts list re-reads every account's name from Telegram; accounts are always shown in number order.
- **Multi-admin.** The owner adds admins; every admin sees and controls only their own accounts.
- **Give accounts away.** The owner gives chosen (or all) accounts to an admin; an admin gives accounts to the owner. Open `🎁 Give accounts`, or the button on an account's screen.
- **Full account control.** Tap an account: see its number, add / change / remove its @username, change name, photo and bio, export its session, give it away or log it out.
- **Several daily broadcasts.** Up to 10 per owner/admin, each with its own message, accounts, delay and times; view, replace or delete them one by one.
- **Start screen.** Any admin can set a welcome text (`{name}` = first name) and an image from inside the bot (`/startscreen`).
- **Session export for anybody.** Someone who is not an admin can log in with their own number and code and get the session string of *that* account only. Nothing is stored. The owner can switch it off.
- **Coloured buttons.** Inline buttons use Telegram's new button colours (green / red / blue) on current apps; older apps show them normally.
- **Safe by design.** Sessions and API hashes are encrypted, secrets typed in chat are deleted, logs hold no message text.
- **Self-healing.** Connection watchdog, auto-reconnect, and an instance lease so two copies never fight over one session.

## ⚠️ Safety and Telegram rules

- Use this only for accounts you own or are explicitly allowed to manage. Follow Telegram's Terms of Service, rate limits and anti-spam rules.
- `/alll`, `/multi` and the daily broadcast open new chats, so they always keep **at least 3 seconds** between accounts.
- OTP codes, 2-step passwords, API hashes and session strings are **deleted from the chat right after they are read**. OTPs and passwords are never stored; API hashes and sessions are encrypted before going to Firestore.
- Keep `SESSION_ENCRYPTION_KEY` private and backed up.
- Logs never contain message texts, secrets or raw chat/sender/user ids (ids appear as short masked tags like `#a1b2c3`).

---

## 🚀 Quick start

**You need:** Python 3.11+, a bot token from [@BotFather](https://t.me/BotFather), an API ID/hash from [my.telegram.org](https://my.telegram.org), and a Firebase project with Firestore.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

# Fill the two generated values into .env:
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"   # → SESSION_ENCRYPTION_KEY
base64 -w 0 firebase-service-account.json                                                    # → FIREBASE_CREDENTIALS_B64

python app.py
```

Set `OWNER_ID` to your numeric Telegram ID (ask [@userinfobot](https://t.me/userinfobot)) and `BOT_TOKEN` to your bot's token. Open your bot and send `/start`.

---

## 🤖 Using the bot

`/start` shows a status card (accounts online, forwarding switches, daily broadcasts) with the start photo / GIF / video, and puts the **quick menu** under the chat: a bottom keyboard with the same actions as the buttons (**Connect Account** in green, **Logout** in red, the rest blue). `/keyboard` brings it back, `/hidekeyboard` removes it.
`/menu` shows every action as a button. Every step-by-step screen has **⬅️ Back** and **❌ Cancel**.

| Command | What it does |
|---|---|
| `/all` | Message a user from all your accounts (existing chats only) |
| `/alll` | Same, but opens the chat if needed (at least 3 sec between accounts) |
| `/allblock` | Block a user on all your accounts |
| `/multi` | Message a user from the accounts **you choose** (tick them, then Done; opens the chat if needed) |
| `/click` | Press a bot's inline buttons from all accounts, no message: `/click @bot [follow] (join)` |
| `/refresh` | Re-read all account names from Telegram and show the list in number order |
| `/broadcast` | Daily broadcasts screen: up to 10 at once, each from all accounts or chosen accounts |
| `/give` | Give accounts away: the owner picks an admin, an admin gives to the owner |
| `/export` | Admins: session string of one of their accounts. Anybody else: log in and export their own |
| `/startscreen` | Set the start **photo, GIF or video** and welcome text, switch public export on/off |
| `/keyboard` `/hidekeyboard` | Show / hide the quick menu under the chat |
| `/emojiid` | Send a message with custom emoji and get their IDs (for `BUTTON_ICONS`) |
| `/help` | Every command as a button |
| `/message` | Send from one account (pick account → chat → text). `/message 1 @user hi [follow] (join)` also presses inline buttons |
| `/usermessage` `/botmessage` `/channelmessage` | Forwarding switch for one account (opens a screen with buttons) |
| `/list` | Your accounts |
| `/logs` | (owner) one-time link to the live logs |
| `/cancel` | Cancel the current step / stop a running bulk action |

> The daily broadcast (old `/onalltime`) and the delay setting (old `/delay`) are no longer commands. The daily broadcast is a menu button that asks one question at a time, and the delay is asked every time you run a bulk action.

---

## 🔗 Connecting an account

**Connect account → phone number** asks for API ID, API hash, phone number, login code and, if the account has it, the 2-step password.

- **Number formats:** `+919876543210`, `919876543210` and `00919876543210` all work. Spaces, dashes and brackets are ignored. A number without a country code is refused (the bot will not guess the country).
- **Login code:** send it **with spaces between the digits** (`1 2 3 4 5`). Telegram cancels codes that are sent as plain text.
- **Session string:** *Connect account → session string* logs in with an existing Telethon session instead.
- **Masked phone:** each account shows a masked number (`+91••••••3210`) in **My accounts** and on its detail screen.

**Addressing an account in commands** (e.g. `/message`, `/usermessage`): use its number, name, `@username`, the masked phone, or the last 4+ digits of its phone number (only when that matches exactly one of your accounts).

---

## 📥 What gets forwarded

Incoming messages are sorted into three kinds. Each has its own switch: global in **Menu → Forwarding**, or per account (default → ON → OFF → default).

| Kind | What counts |
|---|---|
| **Bot** | Any Telegram bot, in any chat: the sender has Telegram's bot flag, **or** its username ends in `bot` |
| **User** | A real person writing to your account in a **private chat (DM)** |
| **Channel** | **Everything else**: channel posts, messages in groups and supergroups, posts made in a group as a channel, anonymous admins, and senders that cannot be identified outside a DM |

Bots are checked first, so a bot counts as a bot even inside a group. The switch is called **Channel & group messages** in the menu.

Every forwarded message starts with a header:

```
📱 Account 3 — Nothing 1
💭 Chat: Study Group          ← groups and channels only
👤 From: Ansh (@Ansh7653)
↩️ Replying to: "…"
```

Reply to a forwarded message (or react to it) and the bot sends it back through the same account, as a quoted reply.

---

## 📤 Bulk actions

### `/all`, `/alll`, `/allblock` step by step

```
You: /all
Bot: Enter the user name                  →  @mandal4482
Bot: Confirm the user  [✅ Confirm] [⬅️ Back] [❌ Cancel]
Bot: Delay between accounts (0–100 sec)   →  0 = instant, or 1 / 3 / 5 / 10 / 30 … or type a number
Bot: Send the message text                →  hello
Bot: Working on 5 account(s) …            →  "✅ Message sent: 5/5 accounts"
```

- **Delay 0:** all accounts act at the same moment. **Delay N:** one account acts, the bot waits N seconds, then the next.
- `/alll` accepts 3–100 seconds only. `/allblock` has the same steps as `/all` but no message question.
- Offline accounts are reported and skipped without waiting. **🛑 Stop** (or `/cancel`) stops a running job.

### Auto-click inline buttons

Accounts cannot "see" a bot's inline buttons, so name them at the end of the command:

```
/all @mandal4482 hello [follow] (join) 3sec Y     message, then press "follow", then "join"
/all @mandal4482 [follow] (join)                   no message: only press the buttons of the bot's latest reply
/click @mandal4482 [join]                          same, as its own command and menu button (🖱 Click buttons)
```

- `[name]` and `(name)` do the same thing; names are pressed **in the order written** (up to 5).
- A name matches any button whose text **contains** it, ignoring case: `join` presses "Join", "✅ Joined" and "Join channel".
- If the matching button is a **link to a channel** (or an invite link), the account **joins that channel**. Any other button is simply pressed.
- Each name is waited for up to 25 seconds. An account whose button never shows up is listed under *Problems* with the missing name.
- Works in `/all`, `/alll`, `/multi`, `/click` and the daily broadcast. Names must be the last things in the command (before `3sec` / `Y`); a message that ends in `(brackets)` would be read as a button name.

### Live progress

While a bulk action runs, the bot keeps editing one message instead of staying silent:

```
📨 Sending (@mandal4482)
██████░░░░  6/10
✅ Done: 5    ❌ Failed: 1    ⏳ Left: 4
➡️ Now: Account 7
```

When it ends, the same message turns into the result (with the reason for every failure). **🛑 Stop** is under it the whole time.

### `/multi`: choose the accounts

```
/multi @mandal4482 hi          → shows your accounts to tick
```

1. Tap accounts to tick or untick them (☑️ / ⬜). **Select all** and **Clear** are there too. You can also type numbers (`1 3 5`) or `all`.
2. Press **Done**. With more than one account it asks the delay (3–100 sec, because chats may be opened). With one account it skips that question.
3. Pick when to send, check the summary, and confirm.

`/multi @user hi 5sec Y` already has everything, so it only asks which accounts.

### Daily broadcast: all or chosen accounts

*Menu → Daily broadcast* (or `/broadcast`) asks: user → message → buttons to click (optional) → **which accounts** (tick them, or Select all) → delay → first time → runs per day. Ticking every account means "all accounts", so accounts you connect later are included automatically.

### Timed messages

`/message`, `/all`, `/alll` and `/multi` ask **⏰ When should it be sent?**: Now, 1, 5, 15, 30 or 60 minutes, or type your own (`10`, `30m`, `2h`, up to 24 hours). A command that already carries its message (`/all @user hi Y`) sends now.

The wait lives inside the running bot: **if the bot restarts or redeploys before the time comes, the message is cancelled.** While one is waiting, other bulk actions wait too; tap **Stop** to cancel it.

### One-line forms

```
/all @mandal4482 hello 3sec Y     runs now (Y = confirmed, 3sec = delay between accounts)
/all @mandal4482 hello Y          asks only for the delay
/all @mandal4482 hello 3sec       asks you to confirm first
/all @mandal4482 hello 3sec N     cancelled
/allblock @mandal4482 3sec Y      same idea, no message
/message 1 @mandal4482 hello      sends right away from your account 1
```

A trailing `Y`/`N` and a trailing `3sec` are read as options, so a message that really ends in "Y" or "5s" should go through the step-by-step flow.

---

## 👑 Owner and admins

- The owner (`OWNER_ID`) opens **Manage admins** from `/start` to add an admin by Telegram user ID, or remove one.
- Removing an admin logs out and deletes **their** accounts and stops their daily broadcast.
- Account numbers (`1, 2, 3…`) are per admin. Forwarded messages, replies, reactions, bulk actions, notifications and the daily broadcast always stay inside the admin who owns the account.
- Only the owner can open the logs.
- Anyone else who opens the bot is told it is only for its admin.

---

## ⚙️ Configuration

| Name | Required | Meaning |
|---|:---:|---|
| `BOT_TOKEN` | ✅ | Token from @BotFather (`123456:ABC...`) |
| `OWNER_ID` | ✅ | Numeric Telegram ID of the owner (`ADMIN_ID` also works) |
| `FIREBASE_CREDENTIALS_B64` | ✅ | Firebase service-account JSON as one base64 line |
| `SESSION_ENCRYPTION_KEY` | ✅ | Fernet key: exactly 44 characters, ends with `=`, **value only** (no `NAME=`, quotes or spaces) |
| `FIREBASE_DATABASE_ID` | | Firestore database name (blank = default) |
| `TIMEZONE` | | IANA name for the daily broadcast, default `UTC` (e.g. `Asia/Kolkata`) |
| `LOG_LEVEL` | | Default `INFO` |
| `PORT` | | Default `8080` (Render sets it) |
| `SELF_PING_URL`, `SELF_PING_INTERVAL` | | Keep-awake ping. Interval `0` = off, otherwise at least 30 (default 600) |
| `PUBLIC_URL` | | Address used for the one-time `/logs` link (auto-detected on Render) |
| `INSTANCE_LEASE` | | `on` (default) stops two copies using the same sessions. Keep it on. |
| `BUTTON_ICONS` | | Custom emoji on buttons, JSON `{"🔗": "<custom emoji id>"}` (leading emoji → id). Needs the **bot owner to have Telegram Premium**. Empty = normal emoji. |

**Troubleshooting — `SESSION_ENCRYPTION_KEY is not a valid Fernet key`:** the value is incomplete or has extra text around it. Generate a fresh key with the command in [Quick start](#-quick-start), or re-paste the existing one in full. **Never replace the key of a running setup:** saved sessions can only be read with the key that encrypted them.

---

## 🗄️ Where data is stored

| Firestore collection | Document | Holds |
|---|---|---|
| `telegram_accounts` | auto id | Encrypted session and API hash, phone, `phone_masked`, forwarding overrides, owner, number |
| `telegram_admins` | admin's Telegram ID | Who added them, when, name |
| `telegram_admin_settings` | admin's Telegram ID | Global forwarding switches and the account counter |
| `telegram_daily_jobs` | admin's Telegram ID | Daily broadcast: `target`, `text`, `delay_seconds`, `start_time`, `times_per_day`, `account_ids` (empty = all), `buttons` |
| `telegram_reply_map` | `chatId_messageId` | Which forwarded message belongs to which original (for replies and reactions) |
| `telegram_settings` | `instance_lease` | The lock that keeps one copy running |

Optional: add a Firestore TTL policy on the `expires_at` field of `telegram_reply_map` to auto-delete old entries.

**Upgrading from the single-admin version:** nothing to migrate by hand. On first start your existing accounts become the owner's, the old global forwarding switches and account counter move to per-admin settings, and the old daily job becomes the owner's daily broadcast. `ADMIN_ID` still works as `OWNER_ID`. `LOGS_TOKEN` and `/logs?token=` URLs are gone (use `/logs`), and the global `/delay` setting is no longer used.

---

## 📊 Live logs and health

### Logs without a secret in the URL

`/logs` (owner only) sends a **one-time link** that expires after 10 minutes. Opening it shows an **Open logs** button; pressing it starts a 12-hour browser session (HttpOnly, SameSite=Strict cookie) and the address becomes plain `/logs`. Browser history and referrers never contain a secret, and a link preview or scanner cannot use the link up. `/logs/logout` ends the session. `/status` (JSON) needs the same session.

### Health for UptimeRobot

| URL | Answer |
|---|---|
| `/` and `/health` | `200 ok` · `200 degraded` (some accounts offline) · `503 down` (bot not answering Telegram, watchdog stalled, or every saved account offline). A new start gets 3 minutes of grace. A standby copy reports ok. |
| `/live` | Always `200` while the process runs. Use it for a platform check that should not restart you when Telegram is down. |

Health uses a bot heartbeat (`get_me` every minute) and the connection watchdog. The response contains only a status and a reason code, never account names. Other paths return 404.

---

## ☁️ Deployment

- Use `/health` for UptimeRobot and `/live` for a platform liveness check.
- Self-ping (`SELF_PING_INTERVAL`, default 600 s, `0` = off) keeps a sleeping host awake.
- Firestore stores encrypted sessions, so the **same `SESSION_ENCRYPTION_KEY` must be present after every restart**.
- On a redeploy, the new copy waits about 25 s for the old one to disconnect (instance lease), which protects sessions from `AuthKeyDuplicatedError`.
- Never commit `.env`, Firebase JSON files, the `key` file or session strings.

---

## ✅ Tests

```bash
python -m unittest discover -s tests -v
```

**169 tests, all passing.** They cover parsing, phone masking and lookup, config, the web server (health states, one-time login, cookies), Firestore isolation between admins, every wizard (bulk, message, connect with 2-step password and Back, daily broadcast, admin add/remove), access control, per-admin forwarding, user/bot/channel detection and bulk timing.

Without the Telegram/Telethon libraries installed, the tests use tiny stand-ins (`tests/stubs.py`); with them installed nothing is replaced.

---

## 🗂️ Project layout

```text
app.py                          entry point
telegram_manager/
  config.py constants.py crypto.py errors.py log_setup.py parsing.py access.py
  store/      accounts admins settings jobs lease replies database   (Firestore, one class each)
  core/       manager + mixins: login, accounts, dialogs, messaging (bulk), forwarding,
              replies, scheduler, watchdog, lease, lifecycle, status
  web/        server, access (one-time login), health, selfping, logs_page, login_page
  bot/
    registry.py lifecycle.py middleware.py guard.py keyboards.py bulk_runner.py ui.py deps.py
    wizard/   engine spec state        (step-by-step flows with Back/Cancel)
    flows/    bulk message connect schedule admins common
    handlers/ start accounts forwarding commands schedule admins logs text
tests/
```


---

## 🆕 What changed in this version

- **Daily broadcasts** are now stored as `telegram_daily_jobs/<admin id>_<slot>`. An old single job (`<admin id>`) is moved to slot 1 on the first start.
- **Giving an account** changes its owner and gives it the next free number in its new place. The account stays connected; it is removed from the old holder's chosen-account broadcasts.
- **Session export** (public): needs the person's own API ID/hash, number and code (+ 2-step password). It disconnects without logging out, so the exported session stays valid. The message with the session deletes itself after 5 minutes. One code request per 30 seconds per person.
- **Start screen settings** live in `telegram_settings/start_screen` (`text`, `photo`, `public_export`).
- Buttons get their colour through `style` (Bot API 9.4+). With python-telegram-bot 21.6 it is sent via `api_kwargs`; newer versions take it natively.

### 🎨 UI upgrade (Bot API 9.4 – 10.3)

- **Quick menu (bottom keyboard)**: persistent reply keyboard with coloured buttons (`style`: `success` green, `primary` blue, `danger` red). A tap shows a short *⏳ Loading…* line, then the screen (the line is removed). Pressing a button also leaves any half-finished step, like a command does. Layout and labels: `telegram_manager/bot/reply_menu.py` (`LAYOUT`).
- **Start screen**: HTML card with a live status quote and a collapsed command list (`<blockquote expandable>`). The media on top can be a **photo, GIF or video** (`/startscreen` → *Photo / GIF / Video*). GIF and video are stored by file id, nothing is downloaded. Old `photo` settings keep working. With media, the text is kept inside the 1024-character caption limit by dropping the optional blocks first.
- **Custom emoji on buttons** (`icon_custom_emoji_id`): set `BUTTON_ICONS`; every button whose text starts with that emoji gets the custom one (the plain emoji is removed from the text so it is not shown twice). Telegram rejects custom emoji when the bot owner has no Premium, so this is off by default.
- Pagination buttons in step-by-step lists are blue.
- Not used on purpose: Rich Messages (10.1+), ephemeral messages and communities (group features), message streaming drafts: they do not fit a private-chat control bot.
