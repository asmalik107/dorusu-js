'use strict';

var _ = require('lodash');
var app = require('../lib/app');
var clientLog = require('./util').clientLog;
var expect = require('chai').expect;
var http2 = require('http2');
var irreverser = require('./util').irreverser;
var insecureOptions = require('./util').insecureOptions;
var listenOnFreePort = require('./util').listenOnFreePort;
var reverser = require('./util').reverser;
var nurpc = require('../lib/nurpc');
var secureOptions = require('./util').secureOptions;
var server = require('../lib/server');
var serverLog = require('./util').serverLog;

var Stub = require('../lib/client').Stub;


// testTable is used to verify nurpc.makeDispatcher.
var testTable = {
  '/x': function xHandler(request, response) {
    request.once('data', function(data) {
      response.end('response from /x');
    });
  },
  '/y': function yHandler(request, response) {
    request.once('data', function(data) {
      response.end('response from /y');
    });
  }
};

// testApp is used to verify app handling
var testApp = new app.RpcApp(
  app.Service('test', [
    app.Method('do_echo', reverser, irreverser),
    app.Method('do_reverse', reverser),
    app.Method('do_irreverse', null, reverser)
  ])
);
testApp.register('/test/do_echo', function testHandler(request, response) {
  request.once('data', function(data) {
    response.end(data);
  });
});
testApp.register('/test/do_reverse', function testHandler(request, response) {
  request.once('data', function(data) {
    response.end(data);
  });
});
testApp.register('/test/do_irreverse', function testHandler(request, response) {
  request.once('data', function(data) {
    response.end(data);
  });
});

// Tests here can use the nurpc client as it's tests do not depend on RpcServer.
//
// Typically flow is:
// - start a RpcServer
// - send a request via the nurpc client
// - verify behaviour on the server without functions from ./codec.js
// - optionally verify what the client receives using the nurpc

describe('RpcServer', function() {
  var nonBinMd = {
    trailer1: 'value1',
    trailer2: 'value2'
  };
  var binMd = {
    bt1: new Buffer('\u00bd + \u00bc = \u00be'),
    bt2: ['notBin', new Buffer('\u00bd + \u00bc = \u00be')]
  };
  var binMdEx = {
    bt1: new Buffer('\u00bd + \u00bc = \u00be'),
    bt2: [new Buffer('notBin'), new Buffer('\u00bd + \u00bc = \u00be')]
  };
  var timeoutOpts = {
    'grpc-timeout': '10S'
  }
  var testStatusMsg = 'a test status message';
  var testCode = 10101;
  var path = '/x';
  var msg = 'hello';
  var reply = 'world';
  var testOptions = {
    secure: secureOptions,
    insecure: insecureOptions
  };
  _.forEach(testOptions, function(serverOptions, connType) {
    describe(connType + ': `server with an app', function() {
      it('should use the fallback on unknown routes', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', _.noop);
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('UNKNOWN')
              });
              expect(theError).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('UNKNOWN')
              });
              srv.close();
              done();
            });
          });
        };

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        var fallback = function fallback(request, response) {
          // use a different status code than unknown
          response.rpcCode = nurpc.rpcCode('UNKNOWN');
          response.end('');
        }
        // here, null === no requestListener fallback
        checkClientAndServer(thisClient, fallback, appOptions);
      });
      it('should use `nurpc.notFound` as the default fallback', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', _.noop);
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              expect(theError).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              srv.close();
              done();
            });
          });
        };

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        // here, null === no requestListener fallback
        checkClientAndServer(thisClient, null, appOptions);
      });
      it('should respond on registered handlers', function(done) {
        var thisClient = function(srv, stub) {
          stub.post('/test/do_echo', msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', function(data) {
              expect(data.toString()).to.eql(msg);
            });
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('OK')
              });
              expect(theError).to.be.undefined;
              srv.close();
              done();
            });
          });
        };

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
      it('should use the specified encoder on the response', function(done) {
        var thisClient = function(srv, stub) {
          stub.post('/test/do_reverse', msg, function(response) {
            var want = reverser(msg);
            response.on('data', function(data) {
              expect(data).to.eql(want);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        };

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
      it('should use the specified decoder on the request', function(done) {
        var thisClient = function(srv, stub) {
          var sent = reverser(msg).toString();
          stub.post('/test/do_irreverse', sent, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.eql(msg);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          });
        };

        var appOptions = _.clone(serverOptions);
        appOptions.app = testApp;
        checkClientAndServer(thisClient, _.noop, appOptions);
      });
    });
    describe(connType + ': `nurpc.makeDispatcher`', function() {
      it('should respond with rpcCode 404 for empty table', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', _.noop);
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              expect(theError).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              srv.close();
              done();
            });
          });
        };

        checkClientAndServer(thisClient, nurpc.makeDispatcher(), serverOptions);
      });
      it('should respond with rpcCode 404 for unknown routes', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', _.noop);
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              expect(theError).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              srv.close();
              done();
            });
          });
        };

        var table = _.clone(testTable);
        delete table['/x'];
        var dispatcher = nurpc.makeDispatcher(table);
        checkClientAndServer(thisClient, dispatcher, serverOptions);
      });
      it('should respond for configured routes', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', _.noop);
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('OK')
              });
              expect(theError).to.be.undefined;
              srv.close();
              done();
            });
          });
        };

        var dispatcher = nurpc.makeDispatcher(testTable);
        checkClientAndServer(thisClient, dispatcher, serverOptions);
      });
    })
    describe(connType + ': `nurpc.notFound`', function() {
      it('should respond with rpcCode 404', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', _.noop);
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              expect(theError).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('NOT_FOUND')
              });
              srv.close();
              done();
            });
          });
        };

        checkClientAndServer(thisClient, nurpc.notFound, serverOptions);
      });
    })
    describe(connType + ': simple request/response', function() {
      it('should work as expected', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': '',
                'code': nurpc.rpcCode('OK')
              });
              expect(theError).to.be.undefined;
              srv.close();
              done();
            });
          });
        };

        // thisTest checks that the expected text is decoded from the request
        // and that the response is successfully encoded.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should can receive status and status messages', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var theStatus;
            var theError;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('status', function(status) {
              theStatus = status;
            });
            response.on('error', function(err) {
              theError = err;
            });
            response.on('end', function() {
              expect(theStatus).to.deep.equal({
                'message': testStatusMsg,
                'code': testCode
              });
              expect(theStatus).to.deep.equal({
                'message': testStatusMsg,
                'code': testCode
              });
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive different status messages and
        // codes.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.rpcMessage = testStatusMsg;
            response.rpcCode = testCode;
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send non-binary trailers ok', function(done) {
        var want = _.clone(nonBinMd);
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            })
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive non-binary trailers.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.addTrailers(want);
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send non-binary headers ok', function(done) {
        var want = _.clone(nonBinMd);
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            })
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive non-binary headers.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            _.forEach(want, function(value, key) {
              response.setHeader(key, value);
            });
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send binary headers ok', function(done) {
        var want = _.clone(binMdEx);
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            })
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive binary headers.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            _.forEach(want, function(value, key) {
              response.setHeader(key, value);
            });
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should send binary trailers ok', function(done) {
        var want = _.clone(binMdEx);
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            var got;
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('metadata', function(md) {
              got = md;
            })
            response.on('end', function() {
              expect(got).to.deep.equal(want);
              srv.close();
              done();
            });
          });
        };

        // thisTest sets up the client to receive binary trailers.
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(data.toString()).to.equal(msg);
            response.addTrailers(want);
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive a good timeout OK', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            response.on('data', function(data) {
              expect(data.toString()).to.equal(reply);
            });
            response.on('end', function() {
              srv.close();
              done();
            });
          }, {headers: timeoutOpts});
        };
        // thisTest sets up the client to receive non-binary headers.
        var thisTest = function(request, response) {
          var want = timeoutOpts['grpc-timeout'];
          expect(request.url).to.equal(path);
          request.once('data', function(data) {
            expect(request.timeoutValue).to.equal(want);
            expect(data.toString()).to.equal(msg);
            response.end(reply);
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive non-binary headers OK', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            response.on('data', _.noop);
            response.on('end', function() { srv.close() });
          }, {headers: nonBinMd});
        };
        // thisTest checks that the server receives non-binary metadata
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.on('metadata', function(md) {
            expect(md).to.deep.equal(nonBinMd);
          });
          request.once('data', function(data) {
            response.end(reply);
            done();
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
      it('should receive binary headers OK', function(done) {
        var thisClient = function(srv, stub) {
          stub.post(path, msg, function(response) {
            response.on('data', _.noop);
            response.on('end', function() { srv.close() });
          }, {headers: binMd});
        };
        // thisTest checks that the server receives non-binary metadata
        var thisTest = function(request, response) {
          expect(request.url).to.equal(path);
          request.on('metadata', function(md) {
            expect(md).to.deep.equal(binMdEx);
          });
          request.once('data', function(data) {
            response.end(reply);
            done();
          });
        };
        checkClientAndServer(thisClient, thisTest, serverOptions);
      });
    });
  })
});

function makeRpcServer(opts, serverExpects) {
  opts = _.clone(opts);
  opts.log = serverLog;
  if (opts.plain) {
    return server.raw.createServer(opts, serverExpects);
  } else {
    return server.createServer(opts, serverExpects);
  }
};

function checkClientAndServer(clientExpects, serverExpects, opts) {
  var srv = makeRpcServer(opts, serverExpects);
  listenOnFreePort(srv, function(addr, server) {
    var stubOpts = {
      log: clientLog
    };
    _.merge(stubOpts, addr, opts);
    clientExpects(server, new Stub(stubOpts));
  });
}