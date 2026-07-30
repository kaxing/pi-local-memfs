# pi-local-memfs

A TypeScript port of [Letta MemFS](https://docs.letta.com/concepts/memfs) for Pi agents.

It ports the core local MemFS model: durable Markdown memory in per-agent Git repositories, full `system/` prompt projection, a compact external-memory tree, retrieval tools, and commit-backed mutations.

## Install

```sh
pi install git:github.com/kaxing/pi-local-memfs
```

## Use

The memory layer starts off on first use. Its on/off state and selected agent persist across Pi sessions, including `--no-session` runs.

```text
/toggle-local-memfs on
/toggle-local-memfs off
/toggle-local-memfs status
/toggle-local-memfs agent <name>
```

Agent profiles and extension state are stored locally:

```text
~/.pi/agent/local-memfs/agents/<name>
~/.pi/agent/local-memfs/state.json
```

Each profile includes a minimal `system/persona.md`. Memory changes are committed to Git and persist across Pi sessions.

When enabled, the agent can call:

```text
memfs_list    memfs_read    memfs_search
memfs_write   memfs_edit    memfs_move    memfs_delete
```

Memory is plaintext local data. Do not store credentials or secrets.

## Development

```sh
npm install
npm run check
npm test
```

## Origin and license

Ported from [Letta MemFS / Letta Code](https://github.com/letta-ai/letta-code), licensed under Apache-2.0. This project is also Apache-2.0.
