# pm2-discord

## Org standards

Quality gate: `pnpm run validate`. GitHub-hosted runners, not Blacksmith. Node 26, pnpm 12. Module-publish track: `release` event → build `dist/` onto the version tag and floating `v2` / `v2.x` tags.

## Overview

PM2 module that forwards process events and logs to a Discord webhook. Config is `pm2 set pm2-discord:<key> <value>`.

## Delivery

Compiled `dist/` exists only on release tags. Consumers must install a published tag (`#v2`), not `main`.
