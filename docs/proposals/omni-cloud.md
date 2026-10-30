<!-- SPDX-FileCopyrightText: 2026 Corwin Brust <corwin@bru.st> -->
<!-- SPDX-FileCopyrightText: 2026 Bryant Frankford <nathanielfrankford@gmail.com> and Contributors -->
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Omni: continuity for Claude in a cloud sandbox

*Status 2026-10-30, later: the gateway, the hub, the skills reader and their tests are in `omni/`; the plugin is
listed in the marketplace; the gateway is packaged (`inputloop-gitcha-omni-gateway`: unit, conffile, token minting,
a members file shaped for gw19, the nginx example) and the medic watches it. Not yet run against a real vibrobeast
server or a real cloud session: the first real run is the open item.*

## The fault this is for

A Claude session in a cloud sandbox (claude.ai/code, a Cowork cloud session) is a fresh container. The desktop
extension that carries vibrobeast's seven servers does not run there, so the session has no memory seat, no
persona sheets, no Tavern on loopback, no Llama Bridge, no C4, and only the skills a plugin menu happens to carry.
The person cannot tell this session from a desktop one until a tool is missing. The work done in each does not
meet.

## The shape

```
   cloud sandbox                                   a host the person owns (gw19, or their desk)
   ┌──────────────────────────┐   https, bearer   ┌────────────────────────────────────────────┐
   │ Claude ── omni-hub (stdio)│ ───────────────▶ │ nginx (TLS) ── omni-gateway (127.0.0.1:8769)│
   │   tools: [seat] note_write│                   │   /mcp/seat     ── mentcached   (stdio child)│
   │          [tavern] say     │                   │   /mcp/persona  ── persona      (stdio child)│
   │          skill_read ...   │                   │   /mcp/tavern   ── tavern.py mcp (stdio child)│
   │   skills: checkouts of    │                   │   /mcp/gitcha   ── gitcha-mcp   (stdio child)│
   │   vibrobeast-skills, jarvis│                  │   one token per member, read per request    │
   └──────────────────────────┘                   └────────────────────────────────────────────┘
```

- **One implementation of each thing.** The memory seat keeps its five rules where it lives; Omni carries the
  call and the answer byte for byte. Nothing is rebuilt in the sandbox, so there is one record.
- **The gateway speaks the JSON-RPC-by-POST half of MCP's Streamable HTTP**, so a member can also be added to
  Claude Code directly as a remote MCP server, without the hub. The hub adds: one door for many members, tokens
  from the environment, the first-wins rule for tool names (as vibrobeast's own hub), `omni_status`, the
  `omni_reach` receipt line, and the skills reader.
- **Tokens are environment secrets** in the cloud environment (`OMNI_TOKEN_SEAT`, ...), read at call time, never
  on disk in the sandbox, never in the conversation. On the host each member's token is a mode-600 file.
- **Consent does not move.** A member's tool that asks a person's yes (a jailed write, a key run) still asks the
  person; the hub cannot answer, and says so in its skill.
- **The gateway runs only what its members file names**, each as its own child process. It is not a shell.

## Redistribution: as minted, or by parts

The pieces are already separable, and Omni keeps them so:

| piece | where it lives | how it reaches a cloud session |
|---|---|---|
| servers (memory seat, persona, tavernface, llamabridge, c4face) | inputloop/vibrobeast, `plugins/vibrobeast-servers` | as gateway members on a host |
| Tavern's own `mcp` face | inputloop/tavern | a gateway member (`python3 tavern.py mcp --as NAME`) |
| Gitcha's extension server | this repository, `extension/` | a gateway member, or installed as its own plugin |
| skills (vibrobeast-skills, jarvis) | their repositories | `OMNI_SKILLS` checkouts read by `skill_read`, or installed as plugins |
| the hub | this repository, `omni/` | the `omni` plugin from this marketplace |

A downstream garden takes any row alone: a members file naming only its own servers, a roster naming only the
members it was given tokens for, a skills root of its own. Nothing in Omni knows the names above.

## Minimum steps to first use

1. On the host: install the gateway (for now: a checkout, `node omni/bin/omni-gateway.js --members FILE`), a
   members file naming the servers to offer and a token file per member, nginx with TLS in front of
   `127.0.0.1:8769`, and `omni-gateway --check` to see each member start and list its tools.
2. In the cloud environment: the tokens as secrets (`OMNI_TOKEN_SEAT` ...), `OMNI_ROSTER_JSON` or a roster file,
   `OMNI_SKILLS` naming checkouts, the host under allowed domains, and the `omni` plugin from this marketplace.
3. In the session: `omni_status`, then work; `omni_reach` in the hand-back.

## Open

- Packaging: `inputloop-gitcha-omni-gateway` (a unit as user `omni`, members file under `/etc/inputloop/omni/`,
  the nginx example). The medic would then watch it too.
- The server-to-client stream (SSE) of Streamable HTTP: not carried; no member here needs it yet.
- Whether the gateway should also front the key server: no, by design, until the consent flow across the wire
  is written down and checked.
- A members file for gw19 naming mentcached, persona, tavern and gitcha, and the first real run.
