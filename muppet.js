/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var fs = require('fs');
var assert = require('assert-plus');
var backoff = require('backoff');
var bunyan = require('bunyan');
var dashdash = require('dashdash');
var forkexec = require('forkexec');
var net = require('net');
var once = require('once');
var VError = require('verror');
var zkstream = require('zkstream');
var core = require('./lib');


///--- Helper functions

function getUntrustedIPs(cfg, callback) {
    // Allow hardcoding addresses in the configuration.
    if (cfg.hasOwnProperty('untrustedIPs')) {
        callback();
        return;
    }

    cfg.untrustedIPs = [];

    const args = [ '/usr/sbin/mdata-get', 'sdc:nics' ];
    cfg.log.info({ cmd: args }, 'Loading NIC information');
    forkexec.forkExecWait({
        argv: args
    }, function (err, info) {
        if (err) {
            cfg.log.error(info, 'Failed to load NIC information');
            setImmediate(callback,
                new VError(err, 'Fetching untrusted IPs failed'));
            return;
        }

        const nics = JSON.parse(info.stdout);
        assert.array(nics, 'nics');

        cfg.log.info({ nics: nics }, 'Looked up NICs');

        nics.forEach(function (nic) {
            // Skip NICs on trusted networks.
            if (nic.nic_tag === 'admin' || nic.nic_tag === 'manta') {
                return;
            }

            if (nic.hasOwnProperty('ips')) {
                nic.ips.forEach(function (addr) {
                    const ip = addr.split('/')[0];
                    if (net.isIPv4(ip) || net.isIPv6(ip)) {
                        cfg.untrustedIPs.push(ip);
                    }
                });
            } else if (nic.hasOwnProperty('ip')) {
                if (net.isIPv4(nic.ip)) {
                    cfg.untrustedIPs.push(nic.ip);
                }
            } else {
                cfg.log.warn({ nic: nic }, 'NIC has no IP addresses');
            }
        });

        callback();
    });
}


///--- CLI Functions

function configure() {
    const cli_options = [
        {
            names: ['help', 'h'],
            type: 'bool',
            help: 'Print this help and exit.'
        },
        {
            names: ['verbose', 'v'],
            type: 'arrayOfBool',
            help: 'Verbose output. Use multiple times for more verbose.'
        },
        {
            names: ['file', 'f'],
            type: 'string',
            help: 'File to process',
            helpArg: 'FILE'
        }
    ];
    var parser = new dashdash.Parser({options: cli_options});

    var opts;
    var log = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: 'muppet',
        stream: process.stdout,
        serializers: {
            err: bunyan.stdSerializers.err
        }
    });

    try {
        opts = parser.parse(process.argv);
        assert.object(opts, 'options');
    } catch (e) {
        log.fatal(e, 'invalid options');
        process.exit(1);
    }

    if (opts.help)
        usage();

    var cfg;
    try {
        const _f = opts.file || __dirname + '/etc/config.json';
        cfg = JSON.parse(fs.readFileSync(_f, 'utf8'));
    } catch (e) {
        log.fatal(e, 'unable to parse %s', _f);
        process.exit(1);
    }

    assert.string(cfg.name, 'config.name');
    assert.string(cfg.trustedIP, 'config.trustedIP');
    assert.object(cfg.zookeeper, 'config.zookeeper');
    assert.optionalArrayOfString(cfg.untrustedIPs,
        'config.untrustedIPs');

    if (cfg.logLevel)
        log.level(cfg.logLevel);

    if (opts.verbose) {
        opts.verbose.forEach(function () {
            log.level(Math.max(bunyan.TRACE, (log.level() - 10)));
        });
    }

    if (log.level() <= bunyan.DEBUG)
        log = log.child({src: true});

    cfg.log = log;
    cfg.zookeeper.log = log;

    return (cfg);
}


function usage(msg) {
    if (msg)
        console.error(msg);

    var str = 'usage: ' + require('path').basename(process.argv[1]);
    str += '[-v] [-f file]';
    console.error(str);
    process.exit(msg ? 1 : 0);
}



///--- Internal Functions

function startWatch(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.config, 'options.config');
    assert.object(opts.config.log, 'options.config.log');
    assert.object(opts.zk, 'options.zk');
    assert.func(cb, 'callback');

    cb = once(cb);

    function _start(_, _cb) {
        _cb = once(_cb);

        const cfg = opts.config;
        var watch = new core.createWatch({
            domain: cfg.name,
            log: cfg.log,
            zk: opts.zk
        });
        watch.start(function onStart(startErr) {
            if (startErr) {
                _cb(startErr);
                return;
            }

            // ZooKeeper errors should redrive here.
            watch.on('error', function (err) {
                cfg.log.error(err, 'watch failed; stopping watch.');
                watch.stop();
            });

            watch.on('hosts', function onHosts(hosts) {
                var _opts = {
                    trustedIP: cfg.trustedIP,
                    untrustedIPs: cfg.untrustedIPs,
                    hosts: hosts || [],
                    log: cfg.log.child({component: 'lb_manager'}),
                    restart: cfg.restart
                };
                core.restartLB(_opts, function (err) {
                    if (err) {
                        cfg.log.error({
                            hosts: hosts,
                            err: err
                        }, 'lb restart failed');
                        return;
                    }

                    cfg.log.info({
                        hosts: hosts
                    }, 'lb restarted');
                });
            });

            _cb(null, watch);
        });
    }

    function start() {
        const retry = backoff.call(_start, {}, cb);
        retry.failAfter(Infinity);
        retry.setStrategy(new backoff.ExponentialStrategy());

        retry.on('backoff', function (num, delay, err) {
            opts.config.log.warn({
                err: err,
                num_attempts: num,
                delay: delay
            }, 'failed to start ZooKeeper watch');
        });

        retry.start();
    }

    start();
}

function zookeeper(cfg) {
    assert.object(cfg, 'cfg');
    assert.object(cfg.log, 'cfg.log');

    core.createZKClient(cfg, function (err, zk_client) {
        if (err) {
            cfg.log.error(err, 'unable to create ZooKeeper client');
            process.exit(1);
        }

        zk_client.on('session', function onSession() {
            cfg.log.info('ZooKeeper session started');
            // TODO: put watch init here or connect?
        });

        zk_client.on('connect', function onConnect() {
            cfg.log.info('ZooKeeper successfully connected');
        });

        zk_client.on('close', function onClose() {
            cfg.log.warn('ZooKeeper connection closed');
        });

        zk_client.on('expire', function onClose() {
            cfg.log.warn('ZooKeeper connection expired');
            // TODO: handle?
        });

        zk_client.on('failed', function onFailed(err) {
            cfg.log.error(err, 'ZooKeeper: error');
            process.exit(1);
        });
    }
}

function watcher(cfg) {
//     startWatch({
//         config: cfg,
//         zk: zk
//     }, function (_dummy2, watcher) {
//         zk.on('error', function onError(err) {
//             cfg.log.error(err, 'ZooKeeper: error');
//             if (watcher)
//                 watcher.stop();

//             zk.close();

//             zk.removeAllListeners('connect');
//             zk.removeAllListeners('error');

//             process.nextTick(zookeeper);
//         });
//     });
// });

}




///--- Mainline

(function main() {
    const cfg = configure();

    getUntrustedIPs(cfg, function (err) {
        if (err) {
            // We failed to load our IPs: abort.
            cfg.log.fatal(err, 'Failed to look up any IPs');
            process.exit(1);
        }

        cfg.log.info({
            trustedIP: cfg.trustedIP,
            untrustedIPs: cfg.untrustedIPs
        }, 'Selected IPs for untrusted networks');

        zookeeper(cfg);
    });
})();
