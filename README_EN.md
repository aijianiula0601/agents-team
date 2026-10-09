# Chorus

> Think together. Build together.

[简体中文](README.md)

Chorus is an early, source-run preview for people who want several AI agents to work like a small engineering team—not a row of disconnected chat tabs.

Give agents different roles, put them in one room, and let them discuss, hand work off, and execute against real projects on your Mac through model APIs or coding CLIs.

![Chorus team room](docs/chorus-team-room-overview.png)

> **Current status:** There is no public release or ready-made download yet. The macOS app currently targets **macOS 13+ on Apple Silicon** and requires **Node.js 22.12+**.

## Why Chorus

A single coding agent is useful. Bigger jobs usually need different kinds of thinking: someone to investigate, someone to challenge the plan, and someone to implement it.

Chorus gives those agents shared context and distinct responsibilities. They can join naturally when their role is relevant, stay quiet when it is not, or be called directly with `@name`. Independent work can run in parallel, while writes to a shared workspace are queued to reduce collisions.

The goal is simple: spend less time copying context between tools and more time watching a useful conversation turn into actual work.

## Quick Start

### Requirements

- macOS 13 or later
- Apple Silicon Mac
- Node.js 22.12 or later

Run the macOS app from source:

```bash
git clone https://github.com/aijianiula0601/agents-team.git
cd agents-team/mac-app
npm ci
npm run dev
```

Then:

1. Open **Settings → Models & Keys**.
2. Configure an OpenAI, Anthropic, Ollama, or OpenAI-compatible endpoint, or install and sign in to Codex, Claude Code, or Cursor CLI.
3. Create a few agents, give them clear roles, and add them to a team.
4. Send a task to the room. Use `@agent-name` when you want a specific agent to start or take over.

Local Mac conversations do not require a relay account.

To build a local DMG:

```bash
cd mac-app
npm run build
```

The current macOS build is **ad-hoc signed and not notarized**. macOS may block it on first launch; use **System Settings → Privacy & Security → Open Anyway** if you trust your local build.

## What It Can Do

- Run role-based agents in shared team rooms or one-to-one conversations.
- Share completed conversation context across team members.
- Route work naturally, through direct `@mentions`, or in an `@mention`-only mode.
- Use OpenAI, Anthropic, Ollama, and custom OpenAI-compatible endpoints.
- Run Codex, Claude Code, and Cursor CLI against local workspaces.
- Give each agent its own managed workspace or bind it to an existing project.
- Stream progress, stop active work, retry failures, and keep CLI sessions tied to the relevant conversation.
- Run independent agents in parallel while serializing conflicting shared-workspace work.
- Open real PTY terminal sessions for interactive CLI input and approvals.
- Optionally sync teams, conversations, tasks, and results to Android through a self-hosted relay.

## Optional Android Access

Android is a remote workbench, not an execution host. Models, coding CLIs, and project files remain on the Mac.

Cross-device use requires your own relay service:

```bash
cd relay-service
cp .env.dev.example .env.dev
# Configure MySQL, Redis, public URL, and authentication settings.
go run ./cmd/server
```

Connect the Mac and Android apps to the same relay and sign in with the same account. A task sent from Android is queued by the relay, claimed by the Mac, executed there, and streamed back to connected devices.

```text
Android ⇄ self-hosted relay (Go · MySQL · Redis) ⇄ Mac (models · CLIs · workspaces)
```

The relay is optional for Mac-only use. See the [relay setup guide](relay-service/README.md) and [Android build guide](android-app/README.md) before enabling it.

## Architecture

```text
                         ┌─ Cloud model providers
                         │  Requests leave the device
Team room                │
or direct chat           ├─ Ollama / compatible endpoint
        │                │
        ▼                └─ Codex / Claude Code / Cursor CLI
Chorus macOS host                    │
  ├─ shared workbench                ▼
  ├─ agent orchestration       Local Mac workspace
  ├─ streaming and routing
  └─ optional sync
          │
          ▼
Self-hosted relay
  ├─ Go API and WebSocket
  ├─ MySQL
  └─ Redis
          ▲
          │
      Android app
```

The Mac is the execution host. The relay stores account data, chat snapshots, device state, and queued tasks, but does not run agents. Model credentials and native CLI sessions are handled by the Mac host.

The shared interface in [`shared/web`](shared/web/README.md) is the source of truth for both clients. After changing it, sync the generated client copies from the repository root:

```bash
node scripts/sync-ui.js
```

## Current Limitations

- Chorus is an early preview intended to be run from source.
- There is no public binary release today.
- The desktop host currently supports macOS 13+ on Apple Silicon only.
- Local macOS packages use ad-hoc signing and are not Apple-notarized.
- Android requires a self-hosted relay plus MySQL and Redis; there is no hosted Chorus relay.
- Android cannot run models or coding CLIs by itself. The Mac must be online to execute new work.
- Relay-backed chats and tasks pass through infrastructure you operate. Treat the relay as trusted infrastructure and deploy it behind HTTPS.
- Requests to cloud model providers leave your device. Project content read by a cloud-backed model or CLI may be included in those requests. Review the provider's data policy before using sensitive repositories.
- Ollama can remain local when both the model endpoint and the rest of your setup are local.
- Public source availability does **not** mean this project currently claims to be open source. No open-source license is declared, so do not assume permission to copy, modify, or redistribute the code beyond the repository's stated terms.

## Repository Guide

| Path | Purpose |
|---|---|
| [`mac-app`](mac-app/README.md) | Electron host, model integrations, coding CLIs, local workspaces, and packaging |
| [`android-app`](android-app/README.md) | Capacitor Android client, signing, installation, and update checks |
| [`shared/web`](shared/web/README.md) | Shared UI, team orchestration, routing, streaming, and configuration |
| [`relay-service`](relay-service/README.md) | Authentication, task queue, realtime sync, storage, and admin tools |
| [`docs`](docs/README.md) | Product walkthrough, screenshots, and documentation index |
| [`scripts`](scripts/README.md) | Build, UI sync, versioning, and verification scripts |
| [`prototype`](prototype/README.md) | Early interaction prototype |

## Development Checks

Run the main checks from the repository root:

```bash
cd mac-app
npm test

cd ../relay-service
go test ./...
go vet ./...
```

The relay also has race-enabled tests:

```bash
cd relay-service
go test -race ./...
```

## Feedback

Chorus is at the stage where a sharp bug report or a blunt note about confusing setup is more useful than polite applause.

Please [open a GitHub issue](https://github.com/aijianiula0601/agents-team/issues) if you try it. Useful reports include your macOS version, Node.js version, selected backend, and the smallest set of steps that reproduces the problem.

Before posting logs or screenshots, remove API keys, tokens, account details, private source code, database addresses, and relay credentials.
