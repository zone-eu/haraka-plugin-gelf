'use strict';

const os = require('node:os');
const dgram = require('node:dgram');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const GELF_VERSION = '1.1';
const CHUNK_MAGIC_0 = 0x1e;
const CHUNK_MAGIC_1 = 0x0f;

exports.register = function () {
    this.cfg = this.load_gelf_config();

    // Initialize once per Haraka process.
    this.register_hook('init_master', 'init_gelf_sender');
    this.register_hook('init_child', 'init_gelf_sender');
};

exports.load_gelf_config = function () {
    const cfg = this.config.get('gelf_udp.ini', {
        booleans: [
            '+main.enabled',
            '+main.compress',
            '+main.chunk',
            '+main.log_errors',
        ],
    }) || {};

    cfg.main ||= {};

    return {
        enabled: cfg.main.enabled !== false,
        host: cfg.main.host || '127.0.0.1',
        port: Number(cfg.main.port || 12201),
        compress: cfg.main.compress !== false,
        chunk: cfg.main.chunk !== false,
        max_chunk_size: Number(cfg.main.max_chunk_size || 8192),
        facility: cfg.main.facility || 'haraka',
        hostname: cfg.main.hostname || os.hostname(),
        log_errors: cfg.main.log_errors !== false,
        default_level: Number(cfg.main.default_level || 6), // syslog INFO
    };
};

exports.init_gelf_sender = function (next) {
    if (!this.cfg.enabled) {
        this.loginfo('GELF UDP disabled');
        return next();
    }

    if (!this.server.notes) this.server.notes = {};

    // Avoid reinitializing if both init_master and init_child run in a context
    // where the helper already exists.
    if (this.server.notes.gelf_udp) {
        return next();
    }

    const socket = dgram.createSocket('udp4');
    const plugin = this;

    socket.on('error', (err) => {
        if (plugin.cfg.log_errors) {
            plugin.logerror(`gelf udp socket error: ${err.message}`);
        }
    });

    const sender = {
        send(message) {
            return sendGelf(plugin, socket, plugin.cfg, message);
        },

        debug(shortMessage, extra = {}) {
            return this.send({
                short_message: shortMessage,
                level: 7,
                ...extra,
            });
        },

        info(shortMessage, extra = {}) {
            return this.send({
                short_message: shortMessage,
                level: 6,
                ...extra,
            });
        },

        notice(shortMessage, extra = {}) {
            return this.send({
                short_message: shortMessage,
                level: 5,
                ...extra,
            });
        },

        warning(shortMessage, extra = {}) {
            return this.send({
                short_message: shortMessage,
                level: 4,
                ...extra,
            });
        },

        error(shortMessage, extra = {}) {
            return this.send({
                short_message: shortMessage,
                level: 3,
                ...extra,
            });
        },

        critical(shortMessage, extra = {}) {
            return this.send({
                short_message: shortMessage,
                level: 2,
                ...extra,
            });
        },

        close() {
            try {
                socket.close();
            }
            catch (err) {
                // ignore
            }
        },
    };

    this.server.notes.gelf_udp = sender;
    this.loginfo(`GELF UDP sender ready for ${this.cfg.host}:${this.cfg.port}`);
    next();
};

function sendGelf(plugin, socket, cfg, message) {
    const payload = normalizeMessage(cfg, message);

    let buffer = Buffer.from(JSON.stringify(payload), 'utf8');

    if (cfg.compress) {
        buffer = zlib.gzipSync(buffer);
    }

    if (buffer.length <= cfg.max_chunk_size) {
        socket.send(buffer, cfg.port, cfg.host, onSend(plugin));
        return;
    }

    if (!cfg.chunk) {
        if (cfg.log_errors) {
            plugin.logerror(
                `GELF payload too large (${buffer.length} bytes), chunking disabled`
            );
        }
        return;
    }

    sendChunked(plugin, socket, cfg, buffer);
}

function normalizeMessage(cfg, input) {
    const msg = { ...input };

    const out = {
        version: GELF_VERSION,
        host: stringify(msg.host || cfg.hostname),
        short_message: stringify(
            msg.short_message || msg.message || 'Haraka event'
        ),
        timestamp: normalizeTimestamp(msg.timestamp),
        level: normalizeLevel(msg.level, cfg.default_level),
        facility: stringify(msg.facility || cfg.facility),
    };

    if (msg.full_message != null) {
        out.full_message = stringify(msg.full_message);
    }

    // Preserve allowed top-level GELF fields if present.
    for (const key of [
        'file',
        'line',
        '_id', // Graylog ignores _id, but leave caller in control if they pass it.
    ]) {
        if (msg[key] != null) out[key] = msg[key];
    }

    // Convert all remaining custom fields to GELF additional fields (_foo).
    for (const [key, value] of Object.entries(msg)) {
        if (value == null) continue;

        if ([
            'version',
            'host',
            'short_message',
            'message',
            'full_message',
            'timestamp',
            'level',
            'facility',
            'file',
            'line',
        ].includes(key)) {
            continue;
        }

        const normalizedKey = key.startsWith('_') ? key : `_${key}`;
        out[normalizedKey] = sanitizeValue(value);
    }

    return out;
}

function normalizeTimestamp(value) {
    if (value == null) return Date.now() / 1000;

    if (value instanceof Date) return value.getTime() / 1000;

    if (typeof value === 'number') {
        // Heuristic: convert ms epoch to seconds if needed
        return value > 1e12 ? value / 1000 : value;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed / 1000;

    return Date.now() / 1000;
}

function normalizeLevel(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function sanitizeValue(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return value;
    }

    return safeJson(value);
}

function safeJson(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch (err) {
        return String(value);
    }
}

function stringify(value) {
    if (typeof value === 'string') return value;
    return String(value);
}

function sendChunked(plugin, socket, cfg, compressedPayload) {
    // GELF chunked UDP header:
    // 2 bytes magic + 8 bytes message id + 1 byte seq + 1 byte seq count
    const messageId = crypto.randomBytes(8);
    const headerSize = 12;
    const chunkDataSize = cfg.max_chunk_size - headerSize;

    if (chunkDataSize <= 0) {
        if (cfg.log_errors) {
            plugin.logerror(`invalid max_chunk_size=${cfg.max_chunk_size}`);
        }
        return;
    }

    const chunks = Math.ceil(compressedPayload.length / chunkDataSize);

    if (chunks > 128) {
        if (cfg.log_errors) {
            plugin.logerror(
                `GELF payload requires ${chunks} chunks, exceeds GELF UDP limit`
            );
        }
        return;
    }

    for (let seq = 0; seq < chunks; seq++) {
        const start = seq * chunkDataSize;
        const end = Math.min(start + chunkDataSize, compressedPayload.length);
        const part = compressedPayload.subarray(start, end);

        const packet = Buffer.allocUnsafe(headerSize + part.length);
        packet[0] = CHUNK_MAGIC_0;
        packet[1] = CHUNK_MAGIC_1;
        messageId.copy(packet, 2);
        packet[10] = seq;
        packet[11] = chunks;
        part.copy(packet, headerSize);

        socket.send(packet, cfg.port, cfg.host, onSend(plugin));
    }
}

function onSend(plugin) {
    return (err) => {
        if (err && plugin.cfg.log_errors) {
            plugin.logerror(`GELF UDP send failed: ${err.message}`);
        }
    };
}
