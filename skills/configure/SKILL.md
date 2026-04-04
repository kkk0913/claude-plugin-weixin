---
name: configure
description: Set up the WeChat channel — login via QR and review access policy. Use when the user asks to configure WeChat, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /wechat:configure — WeChat Channel Setup

WeChat uses QR code login (no bot token). The session is stored in
`~/.claude/channels/weixin/account.json`. The server reads it at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Session** — check `~/.claude/channels/weixin/account.json` exists. If it
   does, show: *"Session saved (logged in)."* If not: *"Not logged in yet — the
   server will show a QR code on next startup."*

2. **Access** — read `~/.claude/channels/weixin/access.json` (missing file =
   defaults: `mode: "pairing"`, empty allowlist). Show:
   - Mode and what it means in one line
   - Allowed users: count and list
   - Pending pairings: count with codes and user IDs if any

3. **What next** — end with a concrete next step based on state:
   - No session → *"Restart the session (`/reload-plugins`) and scan the QR
     code with WeChat."*
   - Session exists, policy is pairing, nobody allowed → *"Message your WeChat
     account from another user. It replies with a code; approve with
     `/wechat:access pair <code>`."*
   - Session exists, someone allowed → *"Ready. Messages from allowed users
     reach the assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture WeChat user IDs you don't know. Once the IDs are in, pairing
has done its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this channel?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/wechat:access policy allowlist`. Do this proactively — don't wait to
   be asked.
4. **If no, people are missing** → *"Have them message your WeChat; you'll
   approve each with `/wechat:access pair <code>`. Run this skill again once
   everyone's in and we'll lock it."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"Message your WeChat from another contact to capture your own ID first.
   Then we'll add anyone else and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone: *"They'll need to message you so you get
   their user ID, or you can briefly flip to pairing:
   `/wechat:access policy pairing` → they message → you pair → flip back."*

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown
offer.

### `clear` — remove saved session

Delete `~/.claude/channels/weixin/account.json`. The next server restart will
trigger a fresh QR login.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `account.json` once at boot. Session changes need a restart
  or `/reload-plugins`. Say so after clearing.
- `access.json` is re-read on every inbound message — policy changes via
  `/wechat:access` take effect immediately, no restart.
- WeChat uses QR login, not tokens. There's nothing to paste — the QR shows
  in the server's stderr.
