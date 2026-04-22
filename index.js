'use strict';

const os = require('node:os');
const dns  = require('node:dns');
const dgram = require('node:dgram');
const zlib = require('node:zlib');
const gzip = require('node:util').promisify(zlib.gzip);
const crypto = require('node:crypto');

const GELF_VERSION = '1.1';
const CHUNK_MAGIC_0 = 0x1e;
const CHUNK_MAGIC_1 = 0x0f;

const RESOLVE_TTL_MS = 60000;

const LogLevel = Object.freeze({
    EMERG:  0,
    ALERT:  1,
    CRIT:   2,
    ERROR:  3,
    WARN:   4,
    NOTICE: 5,
    INFO:   6,
    DEBUG:  7,
});

function toBool(value, defaultValue)
{
    if (typeof value === 'boolean') {
        return value;
    } else if (typeof value === 'string') {
        if (/^(true|yes|1)$/i.test(value)) {
            return true;
        } else if (/^(false|no|0)$/i.test(value)) {
            return false;
        }
    }

    return defaultValue;
}

function resolveConfig(plugin, name, main, ovr = {})
{
    const out = { ...main };

    if ('enabled' in ovr)        out.enabled = toBool(ovr.enabled, true);
    if ('url' in ovr)            out.url = ovr.url;
    if ('compress' in ovr)       out.compress = toBool(ovr.compress, true);
    if ('last' in ovr)           out.last = toBool(ovr.last, false);
    if ('max_chunk_size' in ovr) out.max_chunk_size = Number(ovr.max_chunk_size);
    if ('hostname' in ovr)       out.hostname = ovr.hostname;

    // Have some sane minimum limit and theoretical maximum limit for max_chunk_size.
    // Actual meaningful values depend on network MTU and Graylog components.
    if (out.max_chunk_size < 64 || out.max_chunk_size > 65475) {
        plugin.logerror(`${name}: invalid max_chunk_size=${out.max_chunk_size}`);
        out.enabled = false;
    }

    return out;
}

function stringify(value)
{
    if (typeof value === 'string') {
        return value;
    } else {
        return String(value);
    }
}

function jsonify(value)
{
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return stringify(value);
    }
}

function sanitizeValue(value)
{
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

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    return jsonify(value);
}

function normalizeTimestamp(value)
{
    if (value instanceof Date) {
        return value.getTime() / 1000;
    } else {
        return Date.now() / 1000;
    }
}

function createMessage(cfg, msg)
{
    const out = {
        version: GELF_VERSION,
        host: stringify(msg.host || cfg.hostname),
        short_message: stringify(msg.short_message),
        full_message: (msg.full_message !== undefined ? stringify(msg.full_message) : undefined),
        timestamp: normalizeTimestamp(msg.timestamp),
        level: Number(msg.level),
        facility: (msg.facility !== undefined ? stringify(msg.facility) : undefined),
        file: (msg.file !== undefined ? stringify(msg.file) : undefined),
        line: (msg.line !== undefined ? Number(msg.line) : undefined),
    };

    // Convert all remaining custom fields to GELF additional fields (_foo).
    for (const [key, value] of Object.entries(msg)) {
        const additional_key = key.startsWith('_') ? key : `_${key}`;
        if (out[additional_key.slice(1)] !== undefined || value === null || value === undefined) {
            continue;
        }
        out[additional_key] = sanitizeValue(value);
    }

    return out;
}

async function sendGelf(plugin, socket, cfg, message)
{
    const payload = createMessage(cfg, message);

    let buffer = Buffer.from(JSON.stringify(payload), 'utf8');

    if (cfg.compress) {
        buffer = await gzip(buffer);
    }

    if (buffer.length <= cfg.max_chunk_size) {
        socket.send(buffer, (err) => {
            if (err) {
                // Do not use Haraka logger to avoid log loop
                console.error(`GELF UDP send failed: ${err.message}`);
            }
        });
        return cfg.last;
    }

    // GELF chunked UDP header:
    // 2 bytes magic + 8 bytes message id + 1 byte seq + 1 byte seq count
    const messageId = crypto.randomBytes(8);
    const headerSize = 12;
    const chunkDataSize = cfg.max_chunk_size - headerSize;

    if (chunkDataSize <= 0) {
        return cfg.last;
    }

    const chunks = Math.ceil(buffer.length / chunkDataSize);

    if (chunks > 128) {
        // Do not use Haraka logger to avoid log loop
        console.error(`GELF payload requires ${chunks} chunks, exceeds GELF UDP limit`);
        return cfg.last;
    }

    for (let seq = 0; seq < chunks; seq++) {
        const start = seq * chunkDataSize;
        const end = Math.min(start + chunkDataSize, buffer.length);
        const part = buffer.subarray(start, end);

        const packet = Buffer.allocUnsafe(headerSize + part.length);
        packet[0] = CHUNK_MAGIC_0;
        packet[1] = CHUNK_MAGIC_1;
        messageId.copy(packet, 2);
        packet[10] = seq;
        packet[11] = chunks;
        part.copy(packet, headerSize);

        socket.send(packet, (err) => {
            if (err) {
                // Do not use Haraka logger to avoid log loop
                console.error(`GELF UDP chunk send failed: ${err.message}`);
            }
        });
    }

    return cfg.last;
}

exports.register = function ()
{
    const plugin = this;

    plugin.load_gelf_config();

    // Initialize once per Haraka process.
    plugin.register_hook('init_master', 'init_gelf_sender');
    plugin.register_hook('init_child', 'init_gelf_sender');
};

exports.load_gelf_config = function ()
{
    const plugin = this;

    const cfg = plugin.config.get(
        'gelf.ini',
        {
            booleans: [
                '+main.enabled',
                '+main.compress',
                '-main.last',
            ],
        },
        () => {
            plugin.load_gelf_config();
        }
    ) || {};

    // Pass through resolveConfig() for validation
    cfg.main = resolveConfig(plugin, 'main', {
        enabled: toBool(cfg.main?.enabled, true),
        url: cfg.main?.url || 'udp://localhost:12201',
        compress: toBool(cfg.main?.compress, true),
        last: toBool(cfg.main?.last, false),
        max_chunk_size: Number(cfg.main?.max_chunk_size || 1420),
        hostname: cfg.main?.hostname || os.hostname(),
    });

    const plugins = {};
    for (const [pluginName, pluginCfg] of Object.entries(cfg.plugins || {})) {
        if (!pluginCfg || typeof pluginCfg !== 'object') {
            continue;
        }
        plugins[pluginName] = resolveConfig(plugin, `plugins.${pluginName}`, cfg.main, pluginCfg);
    }
    cfg.plugins = plugins;

    plugin.cfg = cfg;

    plugin.loginfo("config ok");
};

exports.init_gelf_sender = function (next, server)
{
    const plugin = this;

    if (!server.notes) {
        server.notes = {};
    }

    if (server.notes.loggelf) {
        // Already initialized
        return next();
    }

    const sockets = new Map();

    const getConfig = (pluginName) =>
    {
        if (plugin.cfg.plugins[pluginName]) {
            return plugin.cfg.plugins[pluginName];
        } else {
            return plugin.cfg.main;
        }
    };

    const lookup = (hostname, family, cb) =>
    {
        dns.lookup(hostname, { all: true, family: family, order: 'verbatim' }, (err, addresses) =>
        {
            if (err || !addresses || !addresses.length) {
                cb(new Error(`GELF UDP host lookup failed: ${hostname}: ${err?.message}`));
                return;
            }

            // Use the family of the first address as the preferred family.
            // When there was no preferred family by the configuration, system preference is used by lookup.
            // For confused configurations like 'udp6://127.0.0.1', the actual IP address family is used.
            const resolvedFamily = addresses[0].family;
            const resolvedAddresses = addresses.filter(a => a.family === resolvedFamily).map(a => a.address);

            cb(null, resolvedFamily, resolvedAddresses);
        });
    };

    const resolveUrl = (url) =>
    {
        return new Promise((resolve, reject) =>
        {
            const { protocol: scheme, hostname, port } = new URL(url);

            const protocol = (scheme ?? 'udp:').slice(0, -1);

            // Find preferred address family by configuration
            let cfgFamily = 0;
            if (protocol === "udp4") {
                cfgFamily = 4;
            } else if (protocol === "udp6") {
                cfgFamily = 6;
            } else if (protocol !== "udp") {
                reject(new Error(`Invalid protocol: ${protocol}`));
                return;
            }

            const createSocket = (family) =>
            {
                const socket = dgram.createSocket((family === 6 ? 'udp6' : 'udp4'));
                socket.on('error', (err) => {
                    // Do not use Haraka logger to avoid log loop
                    console.error(`GELF UDP socket error: ${url}: ${err.message}`);
                });
                return socket;
            };

            lookup(hostname, cfgFamily, (err, resolvedFamily, resolvedAddresses) =>
            {
                if (err) {
                    reject(err);
                    return;
                }

                try {
                    const conn = {
                        family: resolvedFamily,
                        addresses : resolvedAddresses,
                        port: (port ? parseInt(port) : 12201),
                        socket: createSocket(resolvedFamily),
                        resolvedAt: Date.now(),
                        send(packet, callback) {
                            if (this.socket) {
                                this.socket.send(packet, this.port, this.addresses[Math.floor(Math.random() * this.addresses.length)], callback);
                            }
                        },
                        refresh() {
                            if (Math.abs(Date.now() - this.resolvedAt) < RESOLVE_TTL_MS) {
                                return;
                            }

                            // Mark as fresh immediately to prevent concurrent re-resolves
                            this.resolvedAt = Date.now();

                            lookup(hostname, cfgFamily, (err, newFamily, newAddresses) =>
                            {
                                if (err) {
                                    console.error(`GELF UDP host lookup failed: ${hostname}: ${err?.message}`);
                                    return;
                                }

                                try {
                                    // Check is socket still exists (it may have been closed while lookup was running)
                                    if (this.socket) {
                                        if (this.family !== newFamily) {
                                            try {
                                                this.socket.close();
                                            } catch (e) {
                                                // Ignore
                                            }
                                            this.socket = createSocket(newFamily);
                                            this.family = newFamily;
                                        }
                                        this.addresses = newAddresses;
                                    }
                                } catch (e) {
                                    console.error(`GELF createSocket failed: ${url}: ${e?.message}`);
                                    return;
                                }
                            });
                        },
                    };
                    resolve(conn);
                } catch (e) {
                    reject(new Error(`GELF createSocket failed: ${url}: ${e?.message}`));
                    return;
                }
            });
        });
    };

    const getSocket = (url) =>
    {
        if (sockets.has(url)) {
            return sockets.get(url);
        }

        const promise = resolveUrl(url);

        sockets.set(url, promise);

        return promise;
    };

    const getScopedSender = async (pluginCfg) =>
    {
        const socket = await getSocket(pluginCfg.url);

        socket.refresh();

        return {
            async message(msg) {
                return await sendGelf(plugin, socket, pluginCfg, msg);
            },
        };
    };

    server.notes.loggelf = {

        getSender(callerPlugin)
        {
            return getScopedSender(getConfig(callerPlugin.name));
        },

        message(callerPlugin, msg)
        {
            const pluginCfg = getConfig(callerPlugin.name);

            getScopedSender(pluginCfg)
                .then(sender => sender.message(msg))
                // Do not use Haraka logger to avoid log loop
                .catch(err => console.error(err.message));

            return pluginCfg.last;
        },

        log(callerPlugin, level, shortMessage, extra = {})
        {
            return this.message(callerPlugin, {
                ...extra,
                short_message: shortMessage,
                level,
            });
        },

        emergency(callerPlugin, shortMessage, extra = {}) {
            return this.log(callerPlugin, LogLevel.EMERG, shortMessage, extra);
        },

        alert(callerPlugin, shortMessage, extra = {}) {
            return this.log(callerPlugin, LogLevel.ALERT, shortMessage, extra);
        },

        critical(callerPlugin, shortMessage, extra = {}) {
            return this.log(callerPlugin, LogLevel.CRIT, shortMessage, extra);
        },

        error(callerPlugin, shortMessage, extra = {}) {
            return this.log(callerPlugin, LogLevel.ERROR, shortMessage, extra);
        },

        warning(callerPlugin, shortMessage, extra = {}) {
            return this.log(callerPlugin, LogLevel.WARN, shortMessage, extra);
        },

        notice(callerPlugin, shortMessage, extra = {}) {
            return this.log(callerPlugin, LogLevel.NOTICE, shortMessage, extra);
        },

        info(callerPlugin, shortMessage, extra = {}) {
            return this.log(callerPlugin, LogLevel.INFO, shortMessage, extra);
        },

        debug(callerPlugin, shortMessage, extra = {}) {
            return this.log(callerPlugin, LogLevel.DEBUG, shortMessage, extra);
        },

        async close() {
            for (const promise of sockets.values()) {
                promise
                    .then((conn) => {
                        try {
                            conn.socket.close();
                        } catch (err) {
                            plugin.logerror(`socket.close(): ${err.message}`);
                        } finally {
                            conn.socket = null;
                        }
                    })
                    .catch(err => console.error(err.message));
            }
            sockets.clear();
        },

    };

    plugin.loggelf = server.notes.loggelf;

    plugin.loginfo('GELF UDP sender ready');

    next();
};

exports.hook_log = function (next, logger, log)
{
    const plugin = this;

    if (!plugin.loggelf) {
        return next();
    }

    const msg = {
        level: LogLevel[log.level.toUpperCase()] ?? LogLevel.DEBUG,
        short_message: null,
        _transaction: null,
        _logger: null,
    };

    // Get transaction UUID and caller plugin name from log message
    const match = log.data.match(/^\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] (.+)$/);
    if (match) {
        if (match[2] !== '-') {
            msg._transaction = match[2];
        }
        if (match[3] !== '-') {
            msg._logger = match[3];
        }
        // Remove log level, but keep UUID and plugin name
        msg.short_message = `[${match[2]}] [${match[3]}] ${match[4]}`;
    } else {
        msg.short_message = log.data;
    }

    const is_last = plugin.loggelf.message(logger, msg);

    if (is_last) {
        // Skip all following logger plugins
        return next(OK);
    } else {
        return next();
    }
};
