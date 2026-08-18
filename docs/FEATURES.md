# Succinix Features

[简体中文](FEATURES.zh-CN.md)

## What It Is

Succinix is a browser project terminal environment. It keeps files, commands, processes, and services in one WebContainer workspace, so the application and terminal use the same project.

## What It Is For

| Task | What Succinix provides |
| --- | --- |
| Run a frontend or Node project | Real `node`, `npm`, and `npx`, with development-server preview URLs |
| Process scripts and data | `python`, `pip`, and common Unix commands on the same files |
| Keep a browser project | Workspace and settings snapshots that can be restored after refresh |
| Organize project environments | Separate workspaces, instances, processes, and port views |
| Embed in a product | Cordis services for files, command confinement, terminal sessions, and session persistence |

## How To Use It

1. Run the development server and open `http://localhost:7892`; enter `help` in the terminal.
2. Create a project, then use `npm install` and `npm run dev`; use `ports` for the preview URL.
3. Run `snapshot save` to preserve work and `succinix doctor` to diagnose the environment.
4. To embed Succinix, install `@succinix/engine` and attach it to WebContainer as described in [Integration](SDK.md).

## Know Before Using

- Chromium only; the page needs COOP/COEP.
- Node commands run in WebContainer and other Unix commands run in Lifo; they share files.
- Python runs scripts and supported packages, but has no general interactive REPL and cannot start OS subprocesses.
- Ports are browser previews only, not inbound Internet services.
- Instance separation organizes projects; it is not a security or permission boundary.
- Native binaries, `apt`, `chmod`, symlinks, and hard links are unavailable.

For service fields or protocol compatibility, see [Integration](SDK.md), [Protocol](PROTOCOL.md), and the [Cordis contract](cordis-contract.md).
