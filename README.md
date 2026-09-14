# pm2-discord

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/iShark5060/pm2-discord/ci.yml?style=flat-square&label=CI)](https://github.com/iShark5060/pm2-discord/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/Node-%3E%3D26-339933?logo=node.js&logoColor=white&style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-7.x-3178C6?logo=typescript&logoColor=white&style=flat-square)

A PM2 module that posts process events and logs to a Discord webhook.

This is a maintained fork of [FranciscoG/pm2-discord](https://github.com/FranciscoG/pm2-discord), itself based on [mattpker/pm2-slack](https://github.com/mattpker/pm2-slack). I run it against PM2 7 on Node 26.

## Requirements

- Node 26 or newer
- PM2 7.x

## Install

From a published tag (this is the one you want on a server):

```sh
pm2 install iShark5060/pm2-discord#v2
pm2 set pm2-discord:discord_url https://discord.com/api/webhooks/...
```

`dist/` is only on release tags. `pm2 install iShark5060/pm2-discord` without `#v2` clones `main` and will not have a build.

`discord_url` is required. Create a webhook in Discord, then paste that URL. Discord's own walkthrough is [Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks).

From this checkout:

```sh
pnpm install
pnpm build
pm2 install .
pm2 set pm2-discord:discord_url https://discord.com/api/webhooks/...
```

If the module is already installed and you rebuilt it, `pm2 install .` again or `pm2 restart pm2-discord`.

## Gotchas

- Install a **published tag** (`#v2`). `dist/` is compiled in the release workflow and is not on `main`.
- Create a GitHub Release on a `vMAJOR.MINOR.PATCH` tag. That build force-updates the release tag plus floating `v2` / `v2.x` tags. The original commit is kept as `vX.Y.Z-src`.

## Events

These can be turned on or off with `pm2 set pm2-discord:<event> true|false`.

| event               | description                    | default |
| ------------------- | ------------------------------ | ------- |
| log                 | stdout from your processes     | `false` |
| error               | stderr from your processes     | `true`  |
| kill                | PM2 itself was killed          | `true`  |
| exception           | uncaught exceptions            | `true`  |
| restart             | a process restarted            | `true`  |
| delete              | a process was removed from PM2 | `false` |
| stop                | a process stopped              | `true`  |
| "restart overlimit" | a process hit its restart cap  | `true`  |
| exit                | a process exited               | `false` |
| start               | a process started              | `false` |
| online              | a process came online          | `false` |

```sh
pm2 set pm2-discord:log true
pm2 set pm2-discord:error false
pm2 set pm2-discord:"restart overlimit" false
```

Stdout is noisy on most apps, so `log` is off until you ask for it. Restarts and stderr are on because those are the messages I actually want in Discord.

## Options

| option                    | type                   | description                                                          | default |
| ------------------------- | ---------------------- | -------------------------------------------------------------------- | ------- |
| process_name              | `string` \| `string[]` | Only forward events from this process, or list of processes          | `null`  |
| buffer                    | `boolean`              | Concatenate messages before sending. See [Buffering](#buffering)     | `true`  |
| buffer_seconds            | `number`               | How long to wait before flushing a buffer. Min `1`, max `5`          | `1`     |
| queue_max                 | `number`               | Flush when this many messages are buffered. Min `10`, max `100`      | `100`   |
| collapse                  | `boolean`              | Merge duplicate or similar messages in a time window                 | `true`  |
| collapse_seconds          | `number`               | Window for that merge. Min `1`, max `300`                            | `60`    |
| rate_limit_messages       | `number`               | Max webhook posts inside the rate-limit window                       | `30`    |
| rate_limit_window_seconds | `number`               | Rate-limit window in seconds                                         | `60`    |
| format                    | `boolean`              | Wrap the payload in triple backticks so Discord renders a code block | `true`  |

Same `pm2 set` style as events:

```sh
pm2 set pm2-discord:process_name myprocess
pm2 set pm2-discord:buffer true
pm2 set pm2-discord:buffer_seconds 2
pm2 set pm2-discord:queue_max 50
pm2 set pm2-discord:collapse true
pm2 set pm2-discord:collapse_seconds 60
```

## Rate limiting

Discord webhooks allow 30 requests per 60 seconds. This module stays under that, queues the rest, and backs off on `429`. If the webhook is gone (`404`), it stops sending so Discord does not treat it as abuse.

You can lower the limits. You cannot raise them past Discord's cap.

```sh
pm2 set pm2-discord:rate_limit_messages 20
pm2 set pm2-discord:rate_limit_window_seconds 60
```

Discord's own notes: [rate limits](https://discord.com/developers/docs/topics/rate-limits) and [bots being rate limited](https://support-dev.discord.com/hc/en-us/articles/6223003921559-My-Bot-is-Being-Rate-Limited).

## Buffering

When `buffer` is on, messages for the same window are joined into one Discord payload:

1. First message starts a `buffer_seconds` timer.
2. Later messages reset that timer and append, until one of these happens:
   - the timer fires
   - the buffer hits `queue_max`
   - the next message would push the payload past Discord's 2000 character limit
3. Those messages are sent as one webhook post, then the buffer starts empty again.

Code fences are applied to the finished payload, not to each log line. If the body still has to be cut to fit 2000 characters, the closing fence stays put so Discord does not fall out of the code block.

## Collapse

If a message matches one that is still waiting to send, it is counted instead of queued again. After a send, further copies in the next `collapse_seconds` are held, then posted once as the original text plus `[5 more entries]`.

Matching ignores timestamps, whitespace, UUIDs, and hex pointers, so stack traces that only differ by a clock or an address still fold together. Turn it off with `pm2 set pm2-discord:collapse false`.

If the host was offline and a hundred copies piled up, Discord gets one webhook with a count.

## Debugging

```sh
PM2_DISCORD_DEBUG=1 pm2 install .
```

## Development

```sh
pnpm install
pnpm run validate
```

`validate` is the PR check: format, lint, typecheck, unit tests. Integration tests need a live PM2 daemon (`pnpm run test:integration`).

## License

MIT. See [LICENSE](LICENSE).
