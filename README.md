# haraka-plugin-gelf

A [Haraka](https://haraka.github.io/) plugin that forwards log messages to a [Graylog](https://graylog.org/) server via GELF UDP.

## Features

- Forwards all Haraka log messages to Graylog in GELF format
- UDP transport with automatic IPv4/IPv6 detection
- Chunked UDP support for large messages
- Optional gzip compression
- Background DNS re-resolution with configurable TTL
- Per-plugin log routing with independent configuration
- Exposes a `loggelf` API on `server.notes` for other plugins to send structured GELF messages directly

## Installation

```
npm install haraka-plugin-gelf
```

Add to `config/plugins`:

```
gelf
```

## Configuration

Create `config/gelf.ini`:

```ini
[main]
; Enable or disable the plugin
enabled = true

; GELF UDP endpoint
; Supports udp://, udp4://, udp6:// schemes
url = udp://graylog.example.com:12201

; Compress messages with gzip
compress = true

; Maximum UDP packet/chunk size in bytes (64–65475)
; Set to 1420 for standard Ethernet MTU, 8192 for jumbo frames
max_chunk_size = 1420

; Override the hostname reported in GELF messages
; Defaults to os.hostname()
; hostname = mail.example.com

; If true, no further log plugins will be called after this one
last = false
```

### Per-plugin routing

You can override any `[main]` setting for a specific Haraka plugin by adding a section named after the plugin:

```ini
[plugins.karma]
url = udp://graylog-karma.example.com:12201
last = true

[plugins.rspamd]
enabled = false
```

Plugin names match the value of `plugin.name` in Haraka (e.g. `karma`, `dkim`, `rcpt_to.in_host_list`).

## URL scheme

The `url` setting controls both the transport endpoint and the preferred address family:

| Scheme   | Behaviour                                      |
|----------|------------------------------------------------|
| `udp://` | Resolves hostname, uses system address preference (IPv4 or IPv6) |
| `udp4://`| Forces IPv4                                    |
| `udp6://`| Forces IPv6                                    |

When a hostname resolves to multiple addresses of the same family, each message is sent to a randomly selected address, providing basic load distribution.

DNS is re-resolved in the background every 60 seconds. Sends are never delayed waiting for re-resolution — the previous addresses remain in use until the new resolution completes.

## API for other plugins

When the plugin is loaded, it exposes `server.notes.loggelf` which other plugins can use to send structured GELF messages.

### Sending a structured message

```javascript
exports.hook_queue = async function (next, connection) {
    const gelf = connection.server.notes.loggelf;
    if (!gelf) return next();

    gelf.message(this, {
        short_message: 'Mail queued',
        level: 6, // INFO
        _recipient: connection.transaction.rcpt_to.toString(),
        _sender: connection.transaction.mail_from.toString(),
    });

    next(OK);
};
```

### Convenience log methods

All methods accept `(callerPlugin, shortMessage, extraFields)`:

```javascript
const gelf = connection.server.notes.loggelf;

gelf.emergency(this, 'System failure', { _component: 'queue' });
gelf.alert(this, 'Disk almost full');
gelf.critical(this, 'Database unreachable');
gelf.error(this, 'Delivery failed', { _recipient: 'user@example.com' });
gelf.warning(this, 'Rate limit approached');
gelf.notice(this, 'New connection', { _ip: connection.remote.ip });
gelf.info(this, 'Message accepted');
gelf.debug(this, 'Processing step', { _detail: 'some value' });
```

### Getting a scoped sender

For plugins that send many messages, obtain a scoped sender once and reuse it:

```javascript
exports.hook_connect = async function (next, connection) {
    const gelf = connection.server.notes.loggelf;
    if (!gelf) return next();

    // Sender is scoped to this plugin's configuration
    const sender = await gelf.getSender(this);

    sender.message({
        short_message: 'Client connected',
        level: 6,
        _ip: connection.remote.ip,
    });

    next();
};
```

### Additional fields

Any extra fields passed to `message()` or the log convenience methods are included in the GELF message as additional fields (prefixed with `_`). Fields already prefixed with `_` are passed through as-is.

| Type      | Behaviour                                      |
|-----------|------------------------------------------------|
| `string`  | Passed as-is                                   |
| `number`  | Passed as-is                                   |
| `boolean` | Passed as-is                                   |
| `Date`    | Converted to ISO 8601 string                   |
| `Error`   | Expanded to `{ name, message, stack }`         |
| Other     | JSON round-tripped                             |

## GELF message format

Messages are sent as GELF 1.1 JSON over UDP. The following standard GELF fields are supported:

| Field           | Source                                      |
|-----------------|---------------------------------------------|
| `version`       | Always `"1.1"`                              |
| `host`          | `msg.host`, `cfg.hostname`, or `os.hostname()` |
| `short_message` | Required                                    |
| `full_message`  | Optional                                    |
| `timestamp`     | `msg.timestamp` (Date) or current time      |
| `level`         | Syslog severity level (0–7)                 |
| `facility`      | Optional                                    |
| `file`          | Optional                                    |
| `line`          | Optional                                    |

## Syslog levels

| Level | Value |
|-------|-------|
| EMERG | 0 |
| ALERT | 1 |
| CRIT  | 2 |
| ERROR | 3 |
| WARN  | 4 |
| NOTICE| 5 |
| INFO  | 6 |
| DEBUG | 7 |

## License

MIT
