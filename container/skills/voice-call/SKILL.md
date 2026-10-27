---
name: voice-call
description: >-
  Take a live voice call from the person you are talking to. Use when someone asks to call you,
  start a call, talk by voice, hop on a call, says "call me" or "I need to call you", and whenever
  a message starts with [Voice call].
---

# voice-call

## Starting a call

Run `ncl voice call`. The host sends a one-time call link to the person's DM; it works once and
expires after 5 minutes. Tell them to check their DM. Never post, repeat or ask for the link in a
thread: it lets whoever holds it speak as that person. If the command refuses (voice calls not
enabled for this agent, a person who may not call it, not Slack), say so in one line.

## During a call

- Messages starting with `[Voice call]` are the caller speaking. The `<request>` is their words as a
  speech model heard them, not a summary, and may be misheard: ask a short question when a word that
  matters looks wrong. The `<transcript>` shows what else was said around it.
- Your replies are read aloud. Open each with one to three plain spoken sentences: no markdown,
  tables, code, links or file paths unless asked. Put any detail the thread should keep after them.
- A new `[Voice call]` message while you work steers that work, as a typed message would.
- People in the thread see your replies as usual. Approvals still happen in Slack; say when you are
  waiting on one.
- When the call ends you get a closing `[Voice call]` message. Act on its transcript only if it asks
  for something.
