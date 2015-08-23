#!/usr/bin/env node
'use strict';

var _ = require('lodash');
var async = require('async');
var child_process = require('child_process');
var fs = require('fs-extra');
var path = require('path');
var os = require('os');

/**
 * nurpc/interop/go_interop_agent provides a class GoAgent that supports
 * running the Go interop tests in test cases.
 *
 * It can also be run as a script that install, launches and runs the GoAgent
 * server.  This might be useful to do as a precursor to running the Go interop
 * tests.
 */

/**
 * Internal constants
 */

var SKIP_REASON = 'Go interop tests are not needed';
var PKG_NAME = 'google.golang.org/grpc';
var PKGS = Object.freeze([
  PKG_NAME,
  'golang.org/x/oauth2',
  'golang.org/x/oauth2/google',
  'golang.org/x/oauth2/jwt'
]);
var CLIENT_PATH = PKG_NAME + '/interop/client';
var SERVER_PATH = PKG_NAME + '/interop/server';
var SERVER_PORT = 50443;
var DEFAULT_TEST_ROOT = path.join(os.tmpdir(), 'nurpc_tests');

/**
 * Is Go available ?
 */
var isThereGo = function isThereGo() {
  try {
    child_process.execFileSync('go', 'version');
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Is the process with pid alive ?
 */
var isPidAlive = function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Stops a process
 */
var stopProcess = function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (e) {
    return false;
  }
};

exports.GoAgent = GoAgent;

/**
 * GoAgent runs the Go interop tests
 */
function GoAgent(opts) {
  opts = opts || {};
  this.port = opts.port || SERVER_PORT;
  this._log = opts.log;
  this.otherServerPids = [];
  this.serverPid = null;
  this.testRoot = opts.testRoot
               || process.env.NURPC_TEST_ROOT
               || DEFAULT_TEST_ROOT;
  this.forceRun = false;

  /**
   * testDir is the Go specific test directory.
   */
  Object.defineProperty(this, 'testDir', {
    get: function() { return path.join(this.testRoot, 'go') }
  });

  /**
   * testServerDir is the directory of the Go server binary.
   */
  Object.defineProperty(this, 'testServerDir', {
    get: function() { return path.join(this.testDir, 'src', SERVER_PATH) }
  });

  /**
   * testEnv are the process environment variables to use when
   * invoking the test client or server.
   */
  Object.defineProperty(this, 'testEnv', {
    get: function() { return _.merge({'GOPATH': this.testDir}, process.env) }
  });

  /**
   * testClientDir is the directory of the Go client binary.
   */
  Object.defineProperty(this, 'testClientDir', {
    get: function() { return path.join(this.testDir, 'src', CLIENT_PATH) }
  });

  /**
   * shouldRun determines if the Go interop test should run?
   */
  Object.defineProperty(this, 'shouldRun', {
    get: function() { return this.forceRun || isThereGo() }
  });

  /**
   * isServerRunning indicates if the interop server is already running.
   */
  Object.defineProperty(this, 'isServerRunning', {
    get: function() {
      return !_.isNull(this.serverPid) && isPidAlive(this.serverPid)
    }
  });
}
GoAgent.prototype =
  Object.create(Object.prototype, { constructor: { value: GoAgent } });

GoAgent.prototype._setupAndInstall =
  function _setupAnInstall(installDir, done) {
    fs.mkdirsSync(this.testDir);
    var tasks = [];
    var that = this;
    PKGS.forEach(function(p) {
      tasks.push(
        child_process.execFile.bind(
          child_process, 'go', ['get', p], {env: that.testEnv}));
    });
    tasks.push(
      child_process.execFile.bind(child_process, 'go', ['install'], {
        cwd: installDir,
        env: that.testEnv
      })
    );
    async.series(tasks, done);
  }

GoAgent.prototype.startServer = function startServer(secure, onError) {
  if (this.isServerRunning) {
    return;
  }
  this.serverPid = null;
  var use_tls = secure ? 'true' : 'false';
  var args = [
    'run', 'server.go',
    '--use_tls=' + use_tls,
    '--port=' + this.port
  ]
  var job = child_process.spawn('go', args, {
    cwd: this.testServerDir,
    env: this.testEnv
  });
  job.on('error', function(err) {
    onError(err);
  });
  this.serverPid = job.pid;
  if (this._log) {
    this._log.info("Started Go interop server", {
      pid: this.serverPid,
      port: this.port,
      running: this.isServerRunning});
  }
}

GoAgent.prototype.stopServer = function stopServer() {
  if (!this.isServerRunning) {
    return;
  }
  stopProcess(this.serverPid);
}

GoAgent.prototype.runInteropTest =
  function runInteropTest(testCase, opts, next) {
    opts = opts || {};
    opts.port = opts.port || this.port || SERVER_PORT;
    if (_.isUndefined(opts.secure)) {
      opts.secure = true;
    }
    var useTls = opts.secure ? 'true' : 'false';
    var args = [
      'run', 'client.go',
      '--use_tls=' + useTls,
      '--server_host_override=foo.test.google.fr',
      '--server_host=localhost',
      '--server_port=' + opts.port,
      '--test_case=' + testCase
    ];
    if (this._log) {
      this._log.info('Running interop test', args);
    }
    child_process.execFile('go', args, {
      cwd: this.testClientDir,
      env: this.testEnv
    }, next);
  };

var main = function main() {
  var agent = new GoAgent();
  console.log('Agent client dir is ', agent.testClientDir);
  agent._setupAndInstall(
    agent.testServerDir,
    function(err) {
      if (err) {
        console.log("Setup in", agent.testServerDir, "failed", err);
      } else {
        console.log("Setup in", agent.testServerDir, "succeeded");
      }
      agent.startServer(false, function(err) {
        console.log("Start server failed:", err);
      });
    }
  );
};

if (require.main === module) {
  main();
}
