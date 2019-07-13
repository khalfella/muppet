/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */
var vasync = require('vasync');
var helper = require('./helper.js');
var lbm = require('../lib/lb_manager.js');
var path = require('path');
var fs = require('fs');
var jsdiff = require('diff');
var tap = require('tap');

///--- Globals
//var test = helper.test;
var log = helper.createLogger();

// The good file to test against
var haproxy_good = path.resolve(__dirname, 'haproxy.cfg.good');

// Files that have a bad config in some way
var haproxy_no_listener = path.resolve(__dirname, 'haproxy.cfg.no-listener');
var haproxy_empty_error = path.resolve(__dirname, 'haproxy.cfg.empty');
var haproxy_parse_error = path.resolve(__dirname, 'haproxy.cfg.parse-error');
var haproxy_no_frontend = path.resolve(__dirname, 'haproxy.cfg.no-frontend');

// Input file to use for writeHaproxyConfig and reload
var haproxy_config_in = fs.readFileSync(path.resolve(__dirname,
                                                     'haproxy.cfg.in'),
                                        'utf8');

// File for writeHaproxyConfig to write out
var updConfig_out = path.resolve(__dirname, 'haproxy.cfg.out');
// File for the above to check against
var updConfig_out_chk = path.resolve(__dirname, 'haproxy.cfg.out-check');

// Files that the successful reload test will write out
var haproxy_file = path.resolve(__dirname, '../etc/haproxy.cfg');
var haproxy_file_tmp = path.resolve(__dirname, '../etc/haproxy.cfg.tmp');

var haproxy_exec = path.resolve(__dirname, '../deps/haproxy-1.8/haproxy');


///--- Tests

tap.test('test good config file', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFileOut: haproxy_good};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.equal(null, err);
        t.done();
    });
});

tap.test('test no-listener config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFileOut: haproxy_no_listener};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

tap.test('test empty config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFileOut: haproxy_empty_error};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

tap.test('test parse error config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFileOut: haproxy_parse_error};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

tap.test('test no-frontend config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFileOut: haproxy_no_frontend};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

tap.test('test writeHaproxyConfig', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        servers: {
	    'foo.joyent.us': { address: '127.0.0.1' },
	    'bar.joyent.us': { address: '127.0.0.2' }
	},
        configFileOut: updConfig_out,
        haproxyExec: haproxy_exec,
        log: helper.createLogger()
    };
    lbm.writeHaproxyConfig(opts, function (err, data) {
        t.equal(null, err);
        var test_txt = fs.readFileSync(updConfig_out, 'utf8');
        var check_txt = fs.readFileSync(updConfig_out_chk, 'utf8');

        var diff = jsdiff.diffTrimmedLines(test_txt, check_txt);

        diff.forEach(function (part) {
            if (part.added) {
                if (! part.value.includes('log-send-hostname')) {
                    t.equal(null, part.value);
                }
            } else if (part.removed) {
                if ((! part.value.includes('log-send-hostname')) &&
                    // the input cfg is commented
                    (! part.value.startsWith('#'))) {
                    t.equal(null, part.value);
                }
            }
        });
        fs.unlinkSync(updConfig_out);
        t.done();
    });
});

tap.test('test writeHaproxyConfig bad config (should error)', function (t) {
    // haproxy shouldn't like empty servers
    var opts = {
        trustedIP: '',
        untrustedIPs: [],
        servers: {},
        configFileOut: updConfig_out,
        configFileIn: haproxy_config_in,
        haproxyExec: haproxy_exec,
        log: helper.createLogger()
    };

    vasync.pipeline({ arg: opts, funcs: [
        lbm.writeHaproxyConfig,
        lbm.checkHaproxyConfig
    ]}, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

tap.test('test reload', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        // This must resolve, so pick something public
        servers: { 'google.com': { 'address': '8.8.8.8' } },
        reload: '/bin/true',
        configFileIn: haproxy_config_in,
        haproxyExec: haproxy_exec,
        log: helper.createLogger()
    };

    lbm.reload(opts, function (err, data) {
        t.equal(null, err);
        t.doesNotThrow(function () {
            // Check if reload created the proper file
            // this will throw if the file doesn't exist
            fs.statSync(haproxy_file);
            // remove files that a successful reload
            // would have created
            fs.unlinkSync(haproxy_file);
        });
        t.done();
    });
});

tap.test('test reload bad config (should error)', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        servers: {},
        reload: '/bin/true',
        configFileIn: haproxy_config_in,
        haproxyExec: haproxy_exec,
        log: helper.createLogger()
    };

    lbm.reload(opts, function (err, data) {
        t.notEqual(null, err);
        t.done();
    });
});

tap.test('test dueling reloads', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        servers: {
            'google.com': { 'address': '8.8.8.8' },
            'google2.com': { 'address': '8.8.4.4' }
        },
        reload: '/bin/sleep 2',
        configFileIn: haproxy_config_in,
        haproxyExec: haproxy_exec,
        log: helper.createLogger()
    };

    var opts2 = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        // This must resolve, so pick something public
        servers: { 'google.com': { 'address': '8.8.8.8' } },
        reload: '/bin/true',
        configFileIn: haproxy_config_in,
        haproxyExec: haproxy_exec,
        log: helper.createLogger()
    };

    // Reload twice, calling the functions as fast as possible
    // Using a /bin/sleep call to make sure the first one is still
    // busy for the second call.
    lbm.reload(opts, function (err, data) {
        t.equal(null, err);
    });

    lbm.reload(opts2, function (err, data) {
        t.equal(null, err);
        t.done();
    });
});
