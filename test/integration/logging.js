'use strict';

require('../test_helper');

var _ = require('lodash'),
    async = require('async'),
    Curler = require('curler').Curler,
    Factory = require('factory-lady'),
    request = require('request');

describe('logging', function() {
  shared.runServer({
    apis: [
      {
        _id: 'down',
        frontend_host: 'localhost',
        backend_host: 'localhost',
        servers: [
          {
            host: '127.0.0.1',
            port: 9450,
          },
        ],
        url_matches: [
          {
            frontend_prefix: '/down',
            backend_prefix: '/down',
          },
        ],
      },
      {
        _id: 'wildcard-frontend-host',
        frontend_host: '*',
        backend_host: 'localhost',
        servers: [
          {
            host: '127.0.0.1',
            port: 9444,
          },
        ],
        url_matches: [
          {
            frontend_prefix: '/wildcard-info/',
            backend_prefix: '/info/',
          },
        ],
      },
      {
        _id: 'example',
        frontend_host: 'localhost',
        backend_host: 'localhost',
        servers: [
          {
            host: '127.0.0.1',
            port: 9444,
          },
        ],
        url_matches: [
          {
            frontend_prefix: '/',
            backend_prefix: '/',
          },
        ],
      },
    ],
  });

  function generateUniqueQueryId() {
    return process.hrtime().join('-') + '-' + Math.random();
  }

  beforeEach(function createUser(done) {
    this.uniqueQueryId = generateUniqueQueryId();
    Factory.create('api_user', { settings: { rate_limit_mode: 'unlimited' } }, function(user) {
      this.user = user;
      this.apiKey = user.api_key;
      this.options = {
        headers: {
          'X-Api-Key': this.apiKey,
          'X-Disable-Router-Connection-Limits': 'yes',
          'X-Disable-Router-Rate-Limits': 'yes',
        },
        qs: {
          'unique_query_id': this.uniqueQueryId,
        },
        agentOptions: {
          maxSockets: 500,
        },
      };

      done();
    }.bind(this));
  });

  function waitForLog(uniqueQueryId, options, done) {
    if(!done && _.isFunction(options)) {
      done = options;
      options = null;
    }

    if(!uniqueQueryId) {
      return done('waitForLog must be passed a uniqueQueryId parameter. Passed: ' + uniqueQueryId);
    }

    options = options || {};
    options.timeout = options.timeout || 8500;
    options.minCount = options.minCount || 1;

    var response;
    var timedOut = false;
    setTimeout(function() {
      timedOut = true;
    }, options.timeout);

    async.doWhilst(function(callback) {
      global.elasticsearch.search({
        q: 'request_query.unique_query_id:"' + uniqueQueryId + '"',
      }, function(error, res) {
        if(error) {
          callback(error);
        } else {
          if(res && res.hits && res.hits.total >= options.minCount) {
            response = res;
            callback();
          } else {
            setTimeout(callback, 50);
          }
        }
      });
    }, function() {
      return (!response && !timedOut);
    }, function(error) {
      if(timedOut) {
        return done((new Date()) + ': Timed out fetching log for request_query.unique_query_id:' + uniqueQueryId);
      }

      if(error) {
        return done('Error fetching log for request_query.unique_query_id:' + uniqueQueryId + ': ' + error);
      }

      if(!response || (options.minCount === 1 && response.hits.total !== 1)) {
        return done('Unexpected log response for ' + uniqueQueryId + ': ' + response);
      }

      var hit = response.hits.hits[0];
      var record = hit._source;
      done(error, response, hit, record);
    });
  }

  function itLogsBaseFields(record, uniqueQueryId, user) {
    record.request_at.should.match(/^\d{13}$/);
    record.request_hierarchy.should.be.an('array');
    record.request_hierarchy.length.should.be.gte(1);
    record.request_host.should.eql('localhost:9080');
    record.request_ip.should.match(/^\d+\.\d+\.\d+\.\d+$/);
    record.request_method.should.eql('GET');
    record.request_path.should.be.a('string');
    record.request_path.length.should.be.gte(1);
    record.request_query.should.be.a('object');
    Object.keys(record.request_query).length.should.be.gte(1);
    record.request_query.unique_query_id.should.eql(uniqueQueryId);
    record.request_scheme.should.eql('http');
    record.request_size.should.be.a('number');
    record.request_url.should.be.a('string');
    record.request_url.should.match(/^http:\/\/localhost:9080\//);
    record.response_size.should.be.a('number');
    record.response_status.should.be.a('number');
    record.response_time.should.be.a('number');
    record.internal_gatekeeper_time.should.be.a('number');
    record.proxy_overhead.should.be.a('number');

    if(user) {
      record.api_key.should.eql(user.api_key);
      record.user_email.should.eql(user.email);
      record.user_id.should.eql(user.id);
      record.user_registration_source.should.eql('web');
    }
  }

  function itLogsBackendFields(record) {
    record.backend_response_time.should.be.a('number');
  }

  function itDoesNotLogBackendFields(record) {
    should.not.exist(record.backend_response_time);
  }

  it('logs all the expected response fileds (for a non-chunked, non-gzipped response)', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      headers: {
        'Accept': 'text/plain; q=0.5, text/html',
        'Accept-Encoding': 'compress, gzip',
        'Connection': 'close',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'http://foo.example',
        'User-Agent': 'curl/7.37.1',
        'Referer': 'http://example.com',
        'X-Forwarded-For': '1.2.3.4, 4.5.6.7, 10.10.10.11, 10.10.10.10, 192.168.12.0, 192.168.13.255',
      },
      auth: {
        user: 'basic-auth-username-example',
        pass: 'my-secret-password',
      },
    });

    delete options.qs;

    var requestUrl = 'http://localhost:9080/logging-example/foo/bar/?unique_query_id=' + this.uniqueQueryId + '&url1=http%3A%2F%2Fexample.com%2F%3Ffoo%3Dbar%26foo%3Dbar%20more+stuff&url2=%ED%A1%BC&url3=https%3A//example.com/foo/%D6%D0%B9%FA%BD%AD%CB%D5%CA%A1%B8%D3%D3%DC%CF%D8%D2%BB%C2%A5%C5%CC%CA%C0%BD%F5%BB%AA%B3%C7200%D3%E0%D2%B5%D6%F7%B9%BA%C2%F2%B5%C4%C9%CC%C6%B7%B7%BF%A3%AC%D2%F2%BF%AA%B7%A2%C9%CC%C5%DC%C2%B7%D2%D1%CD%A3%B9%A420%B8%F6%D4%C2%A3%AC%D2%B5%D6%F7%C4%C3%B7%BF%CE%DE%CD%FB%C8%B4%D0%E8%BC%CC%D0%F8%B3%A5%BB%B9%D2%F8%D0%D0%B4%FB%BF%EE%A1%A3%CF%F2%CA%A1%CA%D0%CF%D8%B9%FA%BC%D2%D0%C5%B7%C3%BE%D6%B7%B4%D3%B3%BD%FC2%C4%EA%CE%DE%C8%CB%B4%A6%C0%ED%A1%A3%D4%DA%B4%CB%B0%B8%D6%D0%A3%AC%CE%D2%C3%C7%BB%B3%D2%C9%D3%D0%C8%CB%CA%A7%D6%B0%E4%C2%D6%B0/sites/default/files/googleanalytics/ga.js';
    request.get(requestUrl, options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);

      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        var fields = _.keys(record).sort();

        // Varnish randomly turns some non-chunked responses into chunked
        // responses, so these header may crop up, but we'll ignore these for
        // this test's purposes.
        // See: https://www.varnish-cache.org/trac/ticket/1506
        // TODO: Remove if Varnish changes its behavior.
        fields = _.without(fields, 'response_transfer_encoding', 'response_content_length');

        fields.should.eql([
          'api_key',
          'backend_response_time',
          'internal_gatekeeper_time',
          'proxy_overhead',
          'request_accept',
          'request_accept_encoding',
          'request_at',
          'request_basic_auth_username',
          'request_connection',
          'request_content_type',
          'request_hierarchy',
          'request_host',
          'request_ip',
          'request_method',
          'request_origin',
          'request_path',
          'request_query',
          'request_referer',
          'request_scheme',
          'request_size',
          'request_url',
          'request_user_agent',
          'request_user_agent_family',
          'request_user_agent_type',
          'response_age',
          'response_content_type',
          'response_server',
          'response_size',
          'response_status',
          'response_time',
          'user_email',
          'user_id',
          'user_registration_source',
        ]);

        record.api_key.should.eql(this.apiKey);
        record.backend_response_time.should.be.a('number');
        record.internal_gatekeeper_time.should.be.a('number');
        record.proxy_overhead.should.be.a('number');
        record.request_accept.should.eql('text/plain; q=0.5, text/html');
        record.request_accept_encoding.should.eql('compress, gzip');
        record.request_at.should.match(/^\d{13}$/);
        record.request_basic_auth_username.should.eql('basic-auth-username-example');
        record.request_connection.should.eql('close');
        record.request_content_type.should.eql('application/x-www-form-urlencoded');
        record.request_hierarchy.should.eql([
          '0/localhost:9080/',
          '1/localhost:9080/logging-example/',
          '2/localhost:9080/logging-example/foo/',
          '3/localhost:9080/logging-example/foo/bar',
        ]);
        record.request_host.should.eql('localhost:9080');
        record.request_ip.should.eql('10.10.10.11');
        record.request_method.should.eql('GET');
        record.request_origin.should.eql('http://foo.example');
        record.request_path.should.eql('/logging-example/foo/bar/');
        Object.keys(record.request_query).sort().should.eql([
          'unique_query_id',
          'url1',
          'url2',
          'url3',
        ]);
        record.request_query.unique_query_id.should.eql(this.uniqueQueryId);
        record.request_query.url1.should.eql('http://example.com/?foo=bar&foo=bar more stuff');
        (new Buffer(record.request_query.url2)).toString('base64').should.eql('77+9');
        (new Buffer(record.request_query.url3)).toString('base64').should.eql('aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28vw5bQuc+owr3CrcOLw5XKocK4w5PDk8Ocw4/DmNK7wqXDhcOMw4o9PcOHMjAww5PDoNK1w5bPnMK5wrrDgsekwrXDhMOJw4zGt8K3wr/Co8Ksw5LDksKiw4nDjMOFw5zCt8OSw5HNo8K5wqQyMMK4w7bDlMKjwqzStcOWw7fDhMO3wr/DjsOew43Du8i0w5DDqMK8w4zDkMOQw5LDuMOQ0LTHtsK/7qGjw4/Dssqhw4rDkMOP2LnHtMK8w5LDkMW3w77Wt8K007PCvcO8MsOEw6rDjsOew4jLtMKmw4Dvv73DlNq0y7DCuMOW0KPCrMOOw5LDg8e7wrPDksOJw5PDkMOIw4vKp9aww6TDgtawL3NpdGVzL2RlZmF1bHQvZmlsZXMvZ29vZ2xlYW5hbHl0aWNzL2dhLmpz');
        record.request_referer.should.eql('http://example.com');
        record.request_scheme.should.eql('http');
        record.request_size.should.be.a('number');
        record.request_url.should.eql(requestUrl);
        record.request_user_agent.should.eql('curl/7.37.1');
        record.request_user_agent_family.should.eql('cURL');
        record.request_user_agent_type.should.eql('Library');
        record.response_age.should.eql(20);
        record.response_content_type.should.eql('text/plain; charset=utf-8');
        record.response_server.should.eql('openresty');
        record.response_size.should.be.a('number');
        record.response_status.should.eql(200);
        record.response_time.should.be.a('number');
        record.user_email.should.eql(this.user.email);
        record.user_id.should.eql(this.user.id);
        record.user_registration_source.should.eql('web');

        // Handle the edge-case that Varnish randomly turns non-chunked
        // responses into chunked responses.
        if(record.response_content_length) {
          record.response_content_length.should.eql(5);
        } else {
          record.response_transfer_encoding.should.eql('chunked');
        }

        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs the extra expected fields for chunked or gzip responses', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      gzip: true,
    });

    request.get('http://localhost:9080/compressible-delayed-chunked/5', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);

      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.response_content_encoding.should.eql('gzip');
        record.response_transfer_encoding.should.eql('chunked');

        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs the accept-encoding header prior to normalization', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      headers: {
        'Accept-Encoding': 'compress, gzip',
      },
    });

    request.get('http://localhost:9080/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_accept_encoding.should.eql('compress, gzip');
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs the external connection header and not the one used internally', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      headers: {
        'Connection': 'close',
      },
    });

    request.get('http://localhost:9080/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_connection.should.eql('close');
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs the host used to access the site for a wildcard api', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      headers: {
        'Host': 'unknown.foo',
      },
    });

    request.get('http://localhost:9080/wildcard-info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_host.should.eql('unknown.foo');
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs request scheme when hit directly', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      strictSSL: false,
    });

    request.get('https://localhost:9081/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_scheme.should.eql('https');
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs request scheme when forwarded from an external load balancer via X-Forwarded-Proto', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      headers: {
        'X-Forwarded-Proto': 'https',
      },
    });

    request.get('http://localhost:9080/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_scheme.should.eql('https');
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs headers that contain quotes (to account for json escaping in nginx logs)', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      headers: {
        'Referer': 'http://example.com/"foo\'bar',
        'Content-Type': 'text"\x22plain\'\\x22',
      },
      auth: {
        user: '"foo\'bar',
        pass: 'bar"foo\'',
      },
    });

    request.get('http://localhost:9080/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_referer.should.eql('http://example.com/"foo\'bar');
        record.request_content_type.should.eql('text""plain\'\\x22');
        record.request_basic_auth_username.should.eql('"foo\'bar');
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs headers that contain special characters', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      headers: {
        'Referer': 'http://example.com/!\\*^%#[]',
      },
    });

    request.get('http://localhost:9080/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_referer.should.eql('http://example.com/!\\*^%#[]');
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs requests with utf8 characters in the URL', function(done) {
    this.timeout(4500);

    // Use curl and not request for these tests, since the request library
    // calls url.parse which has a bug that causes backslashes to become
    // forward slashes https://github.com/joyent/node/pull/8459
    var curl = new Curler();
    var args = 'utf8=✓&utf8_url_encoded=%E2%9C%93&more_utf8=¬¶ªþ¤l&more_utf8_hex=\xAC\xB6\xAA\xFE\xA4l&more_utf8_hex_lowercase=\xac\xb6\xaa\xfe\xa4l&actual_backslash_x=\\xAC\\xB6\\xAA\\xFE\\xA4l';
    curl.request({
      method: 'GET',
      url: 'http://localhost:9080/info/utf8/✓/encoded_utf8/%E2%9C%93/?api_key=' + this.apiKey + '&unique_query_id=' + this.uniqueQueryId + '&' + args,
    }, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_query.utf8.should.eql('✓');
        record.request_query.utf8_url_encoded.should.eql('✓');
        record.request_query.more_utf8.should.eql('¬¶ªþ¤l');
        record.request_query.more_utf8_hex.should.eql('¬¶ªþ¤l');
        record.request_query.more_utf8_hex_lowercase.should.eql('¬¶ªþ¤l');
        record.request_query.actual_backslash_x.should.eql('\\xAC\\xB6\\xAA\\xFE\\xA4l');
        record.request_path.should.eql('/info/utf8/✓/encoded_utf8/%E2%9C%93/');
        record.request_url.should.contain(record.request_path);
        record.request_url.should.endWith(args);
        done();
      });
    }.bind(this));
  });

  it('logs requests with backslashes and slashes', function(done) {
    this.timeout(4500);

    // Use curl and not request for these tests, since the request library
    // calls url.parse which has a bug that causes backslashes to become
    // forward slashes https://github.com/joyent/node/pull/8459
    var curl = new Curler();
    curl.request({
      method: 'GET',
      url: 'http://localhost:9080/info/extra//slash/some\\backslash/encoded%5Cbackslash/encoded%2Fslash?api_key=' + this.apiKey + '&unique_query_id=' + this.uniqueQueryId + '&forward_slash=/slash&encoded_forward_slash=%2F&back_slash=\\&encoded_back_slash=%5C',
    }, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_query.forward_slash.should.eql('/slash');
        record.request_query.encoded_forward_slash.should.eql('/');
        record.request_query.back_slash.should.eql('\\');
        record.request_query.encoded_back_slash.should.eql('\\');
        record.request_path.should.eql('/info/extra//slash/some\\backslash/encoded%5Cbackslash/encoded%2Fslash');
        record.request_url.should.contain(record.request_path);
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs the request_at field as a date', function(done) {
    this.timeout(4500);

    request.get('http://localhost:9080/info/', this.options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);

      waitForLog(this.options.qs.unique_query_id, function(error, response, hit) {
        should.not.exist(error);

        global.elasticsearch.indices.getMapping({
          index: hit['_index'],
          type: hit['_type'],
          field: 'request_at',
        }, function(error, res) {
          should.not.exist(error);

          res[hit['_index']].mappings[hit['_type']].properties.request_at.should.eql({
            type: 'date',
            format: 'dateOptionalTime',
          });

          done();
        });
      });
    }.bind(this));
  });

  it('successfully logs query strings when the field first indexed was a date, but later queries are not (does not attempt to map fields into dates)', function(done) {
    this.timeout(15000);

    var options = _.merge({}, this.options, {
      qs: {
        'unique_query_id': generateUniqueQueryId(),
        'date_field': '2010-05-01',
      },
    });

    request.get('http://localhost:9080/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);

      waitForLog(options.qs.unique_query_id, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_query.date_field.should.eql('2010-05-01');

        options.qs.unique_query_id = generateUniqueQueryId();
        options.qs.date_field = '2010-05-0';
        request.get('http://localhost:9080/info/', options, function(error, response) {
          should.not.exist(error);
          response.statusCode.should.eql(200);

          waitForLog(options.qs.unique_query_id, function(error, response, hit, record) {
            should.not.exist(error);
            record.request_query.date_field.should.eql('2010-05-0');

            options.qs.unique_query_id = generateUniqueQueryId();
            options.qs.date_field = 'foo';
            request.get('http://localhost:9080/info/', options, function(error, response) {
              should.not.exist(error);
              response.statusCode.should.eql(200);

              waitForLog(options.qs.unique_query_id, function(error, response, hit, record) {
                should.not.exist(error);
                record.request_query.date_field.should.eql('foo');
                done();
              });
            });
          });
        });
      });
    });
  });

  it('successfully logs query strings when the field first indexed was a number, but later queries are not (does not attempt to map fields into numbers)', function(done) {
    this.timeout(15000);

    var options = _.merge({}, this.options, {
      qs: {
        'unique_query_id': generateUniqueQueryId(),
        'number_field': '123',
      },
    });

    request.get('http://localhost:9080/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(200);

      waitForLog(options.qs.unique_query_id, function(error, response, hit, record) {
        should.not.exist(error);
        record.request_query.number_field.should.eql('123');

        options.qs.unique_query_id = generateUniqueQueryId();
        options.qs.number_field = 'foo';
        request.get('http://localhost:9080/info/', options, function(error, response) {
          should.not.exist(error);
          response.statusCode.should.eql(200);

          waitForLog(options.qs.unique_query_id, function(error, response, hit, record) {
            should.not.exist(error);
            record.request_query.number_field.should.eql('foo');
            done();
          });
        });
      });
    });
  });

  it('logs requests that time out before responding', function(done) {
    this.timeout(90000);
    request.get('http://localhost:9080/delay/65000', this.options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(504);

      waitForLog(this.uniqueQueryId, { timeout: 10000 }, function(error, response, hit, record) {
        should.not.exist(error);
        record.response_status.should.eql(504);
        itLogsBaseFields(record, this.uniqueQueryId, this.user);
        record.response_time.should.be.greaterThan(58000);
        record.response_time.should.be.lessThan(62000);
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs requests that are canceled before completing', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      timeout: 500,
    });

    request.get('http://localhost:9080/delay/2000', options, function() {
      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.response_status.should.eql(499);
        itLogsBaseFields(record, this.uniqueQueryId, this.user);
        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs requests that are cached', function(done) {
    this.timeout(10000);

    async.timesSeries(3, function(index, callback) {
      request.get('http://localhost:9080/cacheable-expires/test', this.options, function(error) {
        setTimeout(function() {
          callback(error);
        }, 1050);
      });
    }.bind(this), function() {
      waitForLog(this.uniqueQueryId, { minCount: 3 }, function(error, response) {
        should.not.exist(error);

        var cachedHits = 0;
        async.eachSeries(response.hits.hits, function(hit, callback) {
          var record = hit._source;
          record.response_status.should.eql(200);
          record.response_age.should.be.a('number');
          if(record.response_age >= 1) {
            cachedHits++;
          }
          itLogsBaseFields(record, this.uniqueQueryId, this.user);
          callback();
        }.bind(this), function() {
          cachedHits.should.eql(2);
          done();
        });
      }.bind(this));
    }.bind(this), done);
  });

  it('logs requests denied by the gatekeeper', function(done) {
    this.timeout(4500);
    var options = _.merge({}, this.options, {
      headers: {
        'X-Api-Key': 'INVALID_KEY',
      },
    });

    request.get('http://localhost:9080/info/', options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(403);

      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.response_status.should.eql(403);
        itLogsBaseFields(record, this.uniqueQueryId);
        itDoesNotLogBackendFields(record);
        record.api_key.should.eql('INVALID_KEY');
        record.gatekeeper_denied_code.should.eql('api_key_invalid');
        should.not.exist(record.user_email);
        should.not.exist(record.user_id);
        should.not.exist(record.user_registration_source);

        done();
      }.bind(this));
    }.bind(this));
  });

  it('logs requests when the api backend is down', function(done) {
    this.timeout(4500);
    request.get('http://localhost:9080/down', this.options, function(error, response) {
      should.not.exist(error);
      response.statusCode.should.eql(502);

      waitForLog(this.uniqueQueryId, function(error, response, hit, record) {
        should.not.exist(error);
        record.response_status.should.eql(502);
        itLogsBaseFields(record, this.uniqueQueryId, this.user);
        itLogsBackendFields(record);
        done();
      }.bind(this));
    }.bind(this));
  });
});
