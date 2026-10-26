# Security Policy

## Reporting a Vulnerability

Please report security issues to `firsemisphere@gmail.com`

## What this package is, and what holding the token means

`w-screenctl` is a developer / AI-agent tool: it exposes an HTTP API that drives **the host's real mouse, keyboard and desktop screenshot** (`/mouse/*`, `/keyboard/*`, `/screenshot`) and **a Chrome instance** (`/chrome/*`, including `file://` navigation and, when enabled, arbitrary JavaScript through `/chrome/evaluate`).

Whoever can call the API with a valid token therefore controls the machine at the privilege of the user running the service. **Treat the token like a password for that user account.** Run the service only on machines and accounts where you accept that.

## Secure defaults

Releases after 1.0.26 are secure by default (this is a breaking change, see README → *Upgrade Notes*):

| Area | Default |
|---|---|
| Listening address | `127.0.0.1` only. A non-loopback address (`0.0.0.0`, a LAN IP, a host name) **without a token makes the server refuse to start** and print why. |
| Authentication | Every endpoint except `GET /health` requires `Authorization: Bearer <token>`. The token is compared in constant time (`crypto.timingSafeEqual` over SHA-256 digests). **There is no option, flag or value that disables authentication** (`token: false`, an empty string or whitespace count as "not set"). |
| Token | 16–256 printable ASCII characters. If none is supplied, a 256-bit random token is generated at every start and written to `~/.w-screenctl/token-<port>` (POSIX: directory `0700`, file `0600`; Windows: inherits the user-profile ACL). The token itself is never printed, only its source and file path. There is deliberately no `--token` command-line flag (it would show up in process lists and shell history). |
| Cross-site requests | No CORS headers are sent. Any request carrying an `Origin` header is rejected with `403` unless the origin is listed in `allowedOrigins` (exact `scheme://host[:port]`; `*` and `null` are refused at startup). |
| DNS rebinding | The `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (plus `allowedHosts`) when bound to loopback; otherwise `403`. Header parsing is strict: duplicate `Host` / `Authorization` headers and values padded with non-HTTP whitespace (e.g. NBSP) are rejected. |
| Arbitrary JavaScript | `POST /chrome/evaluate` is disabled (`403 EVALUATE_DISABLED`) unless explicitly enabled (`enableEvaluate`, `SCREENCTL_ENABLE_EVALUATE=1`, or `node g.mjs --evaluate`). |
| Logs | The token is never written to logs. |
| System-level endpoints | `/screenshot`, `/mouse/*` and `/keyboard/*` are on by default (they are the main purpose of the package) and protected by the token. For Chrome-only use they can be switched off as a group (`enableSystem: false`, `SCREENCTL_ENABLE_SYSTEM=0`, `node g.mjs --no-system`): `403 SYSTEM_DISABLED`, still after token verification, and recorded. |
| Audit log | On by default. Every control action and every rejected request (401/403) is appended as one JSON line to `~/.w-screenctl/audit-<port>.jsonl` (time, method, path, source IP, status, duration, result and a parameter summary; denials also carry the reason code). Never recorded: the token / `Authorization` header, request bodies, typed text (only its length), evaluate scripts (only length and SHA-256), URL query strings / fragments / credentials, `userData` paths, response content. Single-character key presses (possibly a password typed key by key; counted per grapheme, so a single emoji counts too) are recorded as `<char>`, and key strings that are not known key names as `<key>`. Whatever carrier it travels in (for example a token mistakenly placed in a URL path), the current token is scrubbed from every line before it is written, `Origin` / `Host` values are recorded only if they pass a syntax check (credentials, paths and query strings are dropped), and long segments of unregistered paths are masked. File mode `0600` (POSIX), size-capped (5 MiB) with rotation (5 files kept). A write failure never fails a request (one console warning). It can be switched off (`auditLog: false`, `SCREENCTL_AUDIT_LOG=0`, `--no-audit-log`), which prints a warning at startup. |

Why a token even on loopback: without one, any web page the user visits can send requests to `http://127.0.0.1:<port>` (cross-site request forgery), and DNS rebinding can defeat same-origin protections. The token is the only control that does not rely on browser behaviour; the `Origin` / `Host` checks are defence in depth.

## Known limits (by design, not vulnerabilities)

- **Whoever holds the token has full control** of the mouse, keyboard, screen and Chrome, including reading local files through a `file://` page. Do not share the token, do not commit token files, and rotate it (edit the token file and restart) if it may have leaked.
- Binding to a non-loopback address is supported only when a token is set, but the token then travels **in clear text over HTTP**. Prefer an SSH tunnel (`ssh -L 7000:127.0.0.1:7000 host`) or a TLS-terminating reverse proxy, and restrict the port with a firewall. The `Host` header is not checked on a non-loopback bind unless `allowedHosts` is set.
- There is no rate limiting or lockout on failed authentication; use a random token of at least 32 characters (the generated one is 43).
- On Windows the file mode bits have no effect; the token file is protected by the ACL of its folder (the default user profile is readable only by the user and administrators). Do not store it in a shared folder.
- The audit log is an operational record, **not tamper-proof** (anyone who can write the directory can edit it) and it contains source IPs, endpoints, coordinates and URLs without query strings: keep it out of version control and do not share it. The source IP is the socket address; `X-Forwarded-For` and similar headers are deliberately ignored because clients can forge them (behind a reverse proxy every entry shows the proxy's address). One log file must be written by one instance only.
- With `opt.headless: false` and the system-level endpoints, input goes to whatever window has focus on the real desktop.

## Hardening checklist for operators

1. Keep the defaults (loopback, generated or file-based token, `evaluate` off).
2. Supply the token through a file (`SCREENCTL_TOKEN_FILE`) or an environment variable that only the service account can read; see `service/` for ready-made units.
3. Enable `/chrome/evaluate` only for sessions that need it.
4. Do not widen `allowedOrigins` to origins you do not control, and never to user-generated content hosts.
5. Run the service as a dedicated, low-privilege user where possible.
6. Leave the audit log on, review the `denied` entries from time to time, and start with `--no-system` (or `SCREENCTL_ENABLE_SYSTEM=0`) whenever mouse / keyboard / desktop-screenshot control is not needed.
