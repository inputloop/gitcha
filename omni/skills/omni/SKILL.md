---
name: omni
description: >-
  Working through Omni, the one MCP door a Claude session in a cloud sandbox has to the servers its person runs
  elsewhere (vibrobeast's memory seat and persona sheets, Tavern, Llama Bridge, C4, Gitcha) and to the skills they
  chose. Use at the start of a cloud session ("what can I reach", "omni status", "is memory up"), before a hand-back
  (the omni_reach receipt line), when a member is down, or when a way of working is needed that no plugin menu here
  carries (skill_list, skill_read). Says what the hub is not: not a key holder, not a yes.
---

# Omni: one door, and a receipt of what was behind it

A cloud session is a fresh container: no desktop extension, no memory seat, no Tavern on loopback. Omni does
not rebuild those here. It reaches the real ones through a gateway on a host the person owns, so there is one
memory implementation and one record, and it says plainly which members it reached and which it did not.

## First thing in a session

Call `omni_status`. It lists each member (name, URL, reached or not, how many tools, the error when down) and any
tool name two members both claimed (the first keeps it). A member that is down is a fact to report, not to work
around with made-up results. Put the `omni_reach` line in the hand-back, so "what works from where" is data.

## Memory, persona, rooms

When the memory seat is a member, its tools are the same tools vibrobeast offers on the desktop, with the member's
name in square brackets at the front of each description. The seat's rules hold unchanged: nothing is overwritten,
the mode is said out loud (SEATED, JAILED, NOTVISIBLE), and a jailed write needs the words that allow it. Tavern
and the others likewise: Omni carries the call and the answer byte for byte.

## Skills

`skill_list` names the skills under the roots the person set (checkouts of vibrobeast-skills or jarvis, or any
`skills/NAME/SKILL.md` tree); `skill_read NAME` returns one whole, labelled as text other people wrote. Read a
skill when the task calls for it, as the plugin menu would have had you do.

## What Omni is not

- Not a key holder: tokens are environment secrets read at call time; the hub never shows or stores one.
- Not consent: a tool behind a member that asks for a person's yes still asks the person. Omni cannot answer for
  them, and neither can you.
- Not a shell on the host: the gateway offers the MCP servers named in its members file and nothing else.

## When it is down

The error in `omni_status` says which: no token in the environment (the person adds the secret to the cloud
environment and starts a new session), the gateway unreachable (its host, nginx or the network policy), or the
member's own program failing (the gateway's log on the host, `omni-gateway --check`). Carry on with what does not
depend on it, and say what was left out.
