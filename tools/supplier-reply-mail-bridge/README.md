# Supplier-reply mail bridge (local)

A small program that runs next to FlowChain. It reads a mailbox (or a folder of `.eml` files) and hands each supplier
reply to FlowChain's supplier-reply endpoint (`POST /api/integrations/supplier-replies`, see
[docs/supplier-reply-ingest-api.md](../../docs/supplier-reply-ingest-api.md)). From there a reply goes through the same
reading, checks and card as a pasted one, and a person records it. Nothing is recorded on an order by the bridge.

**中文摘要**
- 这个小程序在本机运行：每隔一分钟看一次邮箱。凡是提到订单号（如 PO-202611-0012）的新邮件，就带着口令发给 FlowChain 的接口。
- 回复会出现在对应订单的卡片上，由人确认。
- 没有邮箱也能演示：把 `.eml` 文件放进一个文件夹，用 `--eml-dir` 读取。
- 测试邮箱请用 Gmail（应用专用密码）或 163／QQ 邮箱（授权码）。Outlook.com 个人账号已不能用密码登录 IMAP。

## How it works

    mailbox (IMAP) or .eml folder
        → only messages that name an order number (PO-202611-0012), from listed senders if any
        → POST /api/integrations/supplier-replies   (Authorization: Bearer fcsr.…; text, subject, from, Message-ID, day received)
        → FlowChain reads it like a paste → the order's card → a person records it

What happens to each message:

| FlowChain answers | The bridge | In the mailbox |
| --- | --- | --- |
| 201 with the new reply, or 200 "already in" | done | marked read; moved to the done folder if one is set and the server offers MOVE |
| 422 and other 4xx (no order named, several open orders, too long …) | done, logged with the code | stays unread for a person |
| 200 "still being read", 409, 429, 5xx, no answer | tries again next round | unchanged |
| 401 token, 403 workspace switch, 404 endpoint off, a redirect, or an answer that is not FlowChain's (a web page) | stops and says what to fix | unchanged |

- **Not sent:**
  - messages that name no order number;
  - messages from a sender not on the list, when senders are listed;
  - messages larger than `MAX_BYTES` (5 MB by default).

  These stay unread and are remembered, so they are not read again.
- **Each round:**
  - The bridge first reads only the unread messages' envelopes. It then reads up to 50 messages it has not handled before in full, so old unread mail never blocks a new reply.
  - Attachments are never sent.
- **Each message reaches FlowChain once:**
  - The bridge remembers each message it handled in a state file next to the settings file.
  - FlowChain keeps a message only once, by its Message-ID.
  - A message without a usable Message-ID gets an id made from its sender, date, subject and text, so a retry is still kept once.
- **Never deleted:**
  - The bridge never deletes or expunges mail.
  - It moves a message only when the server offers IMAP MOVE.
  - Without MOVE (163 or QQ may not offer it), a sent message is only marked read, and the bridge says so once.
- **Redirects:** the bridge never follows one, so the token and the text go only to the address you set.

## Set it up

1. **FlowChain with the endpoint switched on.** Start the API with `FLOWCHAIN_SUPPLIER_REPLY_INGEST=on`.
   - The public-data demo workspaces also need `FLOWCHAIN_SUPPLIER_REPLY_INGEST_PUBLIC_DATA=on`.
   - The workspace's AI reading must be switched on, as for pasting.
2. **A token.** An admin makes one; it acts for that admin and is shown once. There is no Settings screen for it yet.
   While signed in as the admin, run this in the browser's developer console on the FlowChain page:

       await (await fetch('/api/settings/integrations/supplier-reply-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Mail bridge' }) })).json()

   Copy the `secret` (it starts with `fcsr.`) into the settings file below. It is not shown again.
3. **A test mailbox.** Use a mailbox made for this, not your own or a real supplier's.
   - **Gmail:** turn on 2-Step Verification, then make an app password. Host `imap.gmail.com`, port 993.
   - **163 / QQ Mail:** turn on IMAP in the settings and use the authorization code (授权码) as the password.
     Hosts: `imap.163.com` and `imap.qq.com`, port 993.
   - **Not supported here:** Outlook.com personal accounts no longer take a password for IMAP; they need OAuth, which this
     bridge does not do yet. Work and school Microsoft 365 mailboxes usually need an admin's consent for the same reason.
4. **A settings file outside the FlowChain folder.** For example `C:\Users\<you>\flowchain-mail-bridge.env`.
   - The bridge refuses a file inside the checkout or any of its git worktrees. It compares real paths, so a link or
     junction into the checkout is refused too.
   - `.gitignore` also ignores `*bridge*.env` and the state file. The password and token are never committed.

       FLOWCHAIN_MAIL_BRIDGE_ENDPOINT=http://localhost:18831/api/integrations/supplier-replies
       FLOWCHAIN_MAIL_BRIDGE_TOKEN=fcsr.…
       FLOWCHAIN_MAIL_BRIDGE_IMAP_HOST=imap.gmail.com
       FLOWCHAIN_MAIL_BRIDGE_IMAP_USER=flowchain.test.replies@gmail.com
       FLOWCHAIN_MAIL_BRIDGE_IMAP_PASSWORD=<app password>
       # Optional:
       FLOWCHAIN_MAIL_BRIDGE_IMAP_MAILBOX=INBOX
       FLOWCHAIN_MAIL_BRIDGE_IMAP_DONE_FOLDER=FlowChain
       FLOWCHAIN_MAIL_BRIDGE_TIME_ZONE=America/New_York
       FLOWCHAIN_MAIL_BRIDGE_FROM=acme-home.example,globex-party.example
       FLOWCHAIN_MAIL_BRIDGE_ORDER_PREFIX=PO

   - **Endpoint:** use the port your FlowChain API runs on. The token is only ever sent over `https`, or to this
     machine (`localhost`).
   - **Time zone:** use the workspace's own. It sets the day a reply counts as received.

## Run it

    cd tools/supplier-reply-mail-bridge
    npm ci
    node bridge.mjs --config=C:\Users\<you>\flowchain-mail-bridge.env --once      # one round
    node bridge.mjs --config=C:\Users\<you>\flowchain-mail-bridge.env             # a round every 60 s (--interval=…)

Without a mailbox, from a folder of `.eml` files. Sent ones move to `sent/`, refused ones to `refused/`, others to `skipped/`:

    node bridge.mjs --config=C:\Users\<you>\flowchain-mail-bridge.env --eml-dir=C:\Users\<you>\replies

`examples/` holds three made-up messages for the UCI demo orders: an English reply, a Chinese reply and a newsletter
that is skipped. Copy them into the folder, not in place, because the bridge moves the files it reads. A message whose
date is in the future, or more than 60 days old, is refused by FlowChain.

The log shows file names or message numbers and FlowChain's answer. It never shows the text, the password or the token.

## Tests

    node --test test/*.test.mjs

They use a stub endpoint on this machine and a stub IMAP client, with no account and no FlowChain running. FlowChain's
own `npm test` runs them too. The test that parses `examples/` with mailparser runs when this folder's packages are
installed (`npm ci`); otherwise it is skipped.

## What the bridge does not check (FlowChain and a person do)

The bridge sends a message when it names an order number anywhere, including in the quoted earlier thread, and it
takes the From address as written. Anyone can forge a From address. These cases are caught later:
- **The reading** drops the quoted thread before it reads.
- **The card** shows "sender not on record" when the address is not the supplier's.
- **A person** records every reply. Nothing is recorded on an order by the bridge or by the reading alone.

## Not done yet

- It has not been run against a live FlowChain or a real mailbox. The endpoint itself is covered by #425's tests.
- OAuth sign-in (Outlook.com, Microsoft 365, Gmail without app passwords).
- A Settings screen for tokens.
- Running as a background service (it runs in a terminal window for now).
