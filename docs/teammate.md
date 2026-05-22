# Connecting your assistant to your Gmail — a teammate's guide

Your operator set up a shared Team Gmail Assistant for your team. This page
walks you through the **one-time** sign-in and what to do when you connect
or reconnect a Gmail inbox.

You won't need a terminal, a credential file, or any technical setup. The
whole flow is browser clicks. The only thing you keep is a short string of
text your operator gave you — your **team key**.

> **Time to read:** ~5 minutes. **Time to actually do it:** ~2 minutes for
> sign-in, ~1 minute per inbox you connect.

---

## What your operator sent you

You'll receive your **team key** from your operator through a
**self-destructing one-time link** — something like
`https://onetimesecret.com/secret/<random>`. When you click it, the
page shows your key once and then erases it; reloading the page shows
nothing. This is on purpose. Your operator chose a delivery channel
that doesn't leave the key lying around in chat history or an inbox.

The key itself is a short line that looks roughly like this:

```
tk_AB12CD34_EFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH
```

**The moment you see it on the one-time link page**, do these two
things, in order:

1. **Copy it into your password manager right away** (1Password,
   Bitwarden, your browser's built-in password manager — whatever you
   use). Save it as something memorable like "Team Gmail Assistant
   team key".
2. **Close the tab.** Don't leave the key sitting in the link's page,
   and don't paste it back into the chat / email where the link came
   from. Those channels are persistent; the link page is not, and
   that's the point.

That's your team key. It's the only proof that you're on the team —
**whoever has it can act as you**, so treat it like a password.

You'll paste it **once** during the very first sign-in below, and the
assistant will remember you after that. If Google or your assistant
ever asks you to sign in again later (it occasionally happens), you'll
paste it again from your password manager. That's all it's ever used
for.

**If it leaks** — you accidentally pasted it into the wrong window,
you think someone else might have it, you lost the device you saved
it on, the one-time link page said "already viewed" when you clicked
it (meaning somebody else opened it first) — **tell your operator
right away**. They run one command (`rotate`) that kills the old key
instantly and sends you a new one. It's not a crisis; it's a
30-second fix. The thing to actually avoid is sitting on a leak
without telling them.

**If your operator sent the key to you another way** — plain email,
Slack message, SMS, anything that leaves the key persistently sitting
in a channel — that's fine for getting you onboarded, but ask them to
rotate it once you've saved it to your password manager. The new key
arrives via a one-time link; the old one (and any copy of it in the
delivery channel) becomes useless.

---

## Step 1 — Connect your assistant to the team server (once)

In your assistant (Claude.ai, or Claude on desktop / mobile), add the
Team Gmail Assistant as a connector. Your operator will give you the
exact URL — it looks like `https://gmail-mcp.<something>.workers.dev`.

When you add it, your browser will open a page that says **"Sign in to
Team Gmail Assistant"** with a single field labeled **"Team key"**.

1. Paste your team key into that field.
2. Click **Continue**.

That's it for sign-in. You should be redirected back to Claude with the
connector successfully added. You won't see this page again unless your
assistant asks you to sign in again later.

> **If it says "Sign-in failed"** — double-check you copied the team key
> exactly (no extra spaces, no missing characters; the dashes and
> underscores matter). If you've gotten it wrong 5 times in a minute,
> the server blocks further attempts from you for an hour. Ask your
> operator to clear the block — they have a one-line command for that —
> or wait an hour and try again.

---

## Step 2 — Connect a Gmail inbox

Once your assistant is signed in to the server, ask it in plain language:

> *"Connect my work inbox."*

The assistant will respond with a sign-in link. Click it. **This part needs
walking through carefully** because Google shows two screens that look
worrying but are normal.

### Screen A: "Choose an account"

Standard Google sign-in. Pick the Gmail account you want to connect.
Nothing surprising here.

### Screen B (the surprising one): "Google hasn't verified this app"

After you pick your account, Google will likely show a **yellow / orange
warning screen**. The exact wording varies, but it looks something like:

```
  ⚠  Google hasn't verified this app

  The app is requesting access to sensitive info in your Google Account.
  Until the developer verifies this app with Google, you shouldn't use it.

  [ Go back to safety ]                     Advanced ▾
```

**This is expected.** Your operator has set the app to **"Testing" mode**,
which is a deliberate choice — verification is a multi-week Google review
that your operator hasn't run. The warning is Google being cautious about
unverified apps in general, **not** a sign that anything's wrong with your
team's app specifically.

To continue:

1. Click the small **"Advanced"** link in the bottom right (or wherever
   Google's put it lately).
2. A new line appears: **"Go to <app name> (unsafe)"** — yes, the word
   "unsafe" is right there, and it's still fine because the app is your
   own team's, sitting on your operator's Cloudflare account. Click that
   line.
3. Google will then ask which permissions to grant — Gmail read, send,
   labels, drafts. Review them, then click **Continue** / **Allow**.

If you don't see the "Advanced" link, or you see a different error like
**"Access blocked: this app is in testing"**, your Gmail address isn't on
your operator's test-user allowlist. Tell them which address you're trying
to connect, they'll add it (one line in Google Cloud Console), and you
retry. Up to 100 addresses are allowed total.

### Screen C: "Nickname this inbox"

After Google sends you back, our server shows a small confirmation page:

> Inbox 'work' connected. You can close this tab and go back to your
> assistant.

That's it. The nickname you chose ('work') is how you'll refer to that
inbox going forward.

---

## Step 3 — Repeat for any other inboxes you want connected

You can connect as many Gmail inboxes as you like, each with its own
nickname. Ask the assistant:

> *"Connect my personal inbox under the nickname 'personal'."*
>
> *"Also connect my alerts@... inbox as 'alerts'."*

Each one goes through the same Sign-in → Warning → Advanced → Allow
flow as above. Your operator only has to add each address to the
test-user list **once**, ahead of time.

Once they're all in, ask the assistant:

> *"What inboxes do I have connected?"*

It'll list them by nickname.

---

## What you can ask the assistant to do

Once you have inboxes connected, the assistant can do all of this — and
**always tells you which inbox the answer came from or which inbox it's
sending from**:

- **"Did anything important arrive today?"** — searches **all** your
  inboxes at once, returns a single unified answer with each result
  labeled by inbox.
- **"Search my work inbox for 'contract' from last week."** — one named
  inbox.
- **"Read the thread from Acme in my work inbox."**
- **"Draft a reply to that last Acme thread."** — saves a draft. Does
  **not** send.
- **"Send that draft from my work inbox."** — explicit. The assistant
  will always say out loud *which* inbox it's sending from before it
  sends, so you can catch a wrong-account mistake.
- **"Add the 'Followups' label to that thread in my work inbox."**

The assistant will not send mail "as a side effect" of any other action.
Sending is always a deliberate, named-inbox-explicit step.

---

## When the assistant asks you to reconnect an inbox — this is **normal**

Periodically — usually once a week, sometimes longer — you'll ask the
assistant to do something Gmail-related and it'll say something like:

> Your 'work' inbox needs to be reconnected. Ask me to run reconnect_inbox
> for 'work' — I'll give you a link, you click 'Sign in with Google' once,
> and it's back.

**This is expected and not a bug.** Google's "Testing" mode (the same
mode that causes the "unverified app" warning above) deliberately makes
the saved credentials expire about every **7 days of inactivity**. The
only way to make this stop is verification, which your operator is
explicitly not doing.

What to do:

> *"Reconnect my work inbox."*

The assistant gives you a new sign-in link. Click it. You'll see the
same "Choose an account → Advanced → Go to (unsafe) → Allow" sequence as
the first time. **Important:** sign in as the **same Google account** the
inbox was originally connected with — our server checks, and refuses if
you accidentally pick a different account. If you do pick the wrong one
the page will say so cleanly; just retry.

After Allow, you see:

> Inbox 'work' is back. You can close this tab and go back to your
> assistant.

Your nickname, label history, and connection identity all stay the same.
Only the credential changes.

The whole reconnect takes about 30 seconds. Plan for it the same way you
plan for your phone occasionally asking you to re-enter your password.

---

## What if I want to disconnect an inbox?

> *"Disconnect my work inbox."*

The assistant tells our server, which calls Google to revoke our access,
then deletes its stored credentials. You can see in your Google account
(under **myaccount.google.com → Security → Third-party apps with account
access**) that we're no longer listed.

You can reconnect later by running `connect_inbox` again — it's a fresh
connection from Google's perspective.

---

## Quick reference

| What you ask | What the assistant does |
|---|---|
| "Connect my X inbox" | Gives you a sign-in link; you do Google's flow once |
| "Reconnect my X inbox" | Same as above, only the credential is replaced |
| "List my inboxes" | Shows nicknames + a `needs_reconnect` flag |
| "Rename my X inbox to Y" | Just the label changes |
| "Disconnect my X inbox" | Revokes at Google, deletes our copy |
| "What arrived today?" | Cross-inbox search, results labeled by source |
| "Search X for ..." | One named inbox |
| "Read the thread about ..." | Full thread in one inbox |
| "Draft a reply" | Saved as a draft. **Not sent.** |
| "Send from X" | Explicit. Always names the sending inbox. |
| "Add label Y in inbox X" | Just that |

---

## TL;DR

1. Paste your team key once when adding the assistant connector.
2. **Keep the team key** — you might need it again if your assistant
   ever asks you to re-sign-in.
3. When connecting a Gmail inbox, expect the "Google hasn't verified
   this app" warning. Click **Advanced → Go to (unsafe) → Allow**.
4. **Reconnecting each inbox roughly once a week is expected and
   normal — not a malfunction, not a bug to report.** It is a
   deliberate consequence of how Google handles "Testing"-mode apps:
   Google expires the saved credential every ~7 days of inactivity,
   and there is no setting on our side that turns that off. When the
   assistant asks you to reconnect, just do it — 30 seconds of
   clicking. Don't ping your operator about it; it's working as
   intended.
5. Send-mail actions always name the sending inbox. If your assistant
   ever sounds vague about which account it's about to send from, ask
   it to confirm.
