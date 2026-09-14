# Changelog

## 2.0.0

### 2026-09-14

### Breaking Changes

- Require Node.js `>=26` and pnpm 12.
- Target PM2 7. Older PM2 majors are not supported.
- Default event flags: `error: true`, `log: false`, `restart: true`. Stdout is off until you enable it. Restarts and stderr go to Discord out of the box.

### Features

- Wrap Discord payloads once at send time and keep the closing code fence when truncating to 2000 characters.
- Collapse duplicate or similar messages inside a 60 second window (`collapse`, `collapse_seconds`). Repeats become `[N more entries]` instead of a flood after an outage.

### Internal Changes

- Switch the toolchain to pnpm, oxlint, oxfmt, and `pnpm run validate`.
- Replace `node-fetch` with Node's built-in `fetch`.
- Drop npm lockfile in favor of `pnpm-lock.yaml`.
- Release workflow compiles `dist/` onto version tags and floating `v2` / `v2.x` tags.

## 1.0.0

### 2026-01-28

### Breaking Changes

- Set the minimum Node engine to `>=16.0.0` to match [pm2's v6](https://github.com/Unitech/pm2/blob/v6.0.14/package.json).
- Dropped support for PM2 v5 or below. It still might work with PM2 v5, as I can't find any major breaking changes in PM2's changelog, but if you have issues with pm2-discord and you're on PM2 v5, I will not fix any issues until you confirm they are still happening in PM2 v6.

### Features

- Implemented requested updates from [this PR](https://github.com/FranciscoG/pm2-discord/pull/6).
  - added a new `format` option, default to `false`, that wraps the message sent to Discord with triple-backticks for multi-line code block.

    ```sh
    pm2 set pm2-discord:format true
    ```

  - In the payload to the Discord webhook, set the username to be the process name.

- **Rate Limiting Compliance**: Fully implemented Discord's webhook rate limiting (30 requests per 60 seconds)
  - Automatic throttling to stay within Discord's limits
  - Respects `429 Too Many Requests` responses with automatic backoff
  - Handles both route-specific and global rate limits
  - Parses and uses all Discord rate limit headers (`X-RateLimit-*`)
  - Configurable rate limits via `rate_limit_messages` and `rate_limit_window_seconds`

- **Invalid Webhook Detection**: Prevents repeated 404 errors
  - Detects when webhooks are deleted or invalid (404 responses)
  - Automatically stops sending to invalid webhooks
  - Prevents bans from repeated invalid requests

- added character limit checks for webhook payload content to not exceed the [2000 character limit](https://discord.com/developers/docs/resources/webhook#execute-webhook-jsonform-params).

### Internal Changes

- Complete rewrite using TypeScript
- Added comprehensive unit test suite
- Added integration tests
- Added proper error handling for network failures and Discord API errors

## 0.1.2

### 2020-05-04

Update readme with more accurate instructions

## 0.1.1

### 2020-05-04

- Updated dependencies
- Added Changlelog.md

## 0.1.0

### 2017-02-01

Initial release after forking the code from `pm2-discord` and converting it to work with Discord
