// @ts-nocheck
/*
 * Copyright © 2015-2020 Cask Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import { ping } from 'server/config/router-check';
import { extractUISettings } from 'server/config/parser';
import q from 'q';
import crypto from 'crypto';
import {
  constructUrl,
  isVerifiedMarketHost,
  getMarketUrls,
  REQUEST_ORIGIN_MARKET,
} from 'server/url-helper';
import url from 'url';
import helmet from 'helmet';
import proxy from 'express-http-proxy';
import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import finalhandler from 'finalhandler';
import serveFavicon from 'serve-favicon';
import request from 'request';
import uuidV4 from 'uuid/v4';
import bodyParser from 'body-parser';
import ejs from 'ejs';
import fs from 'fs';
import * as uiThemeWrapper from 'server/uiThemeWrapper';
import * as sessionToken from 'server/token';
import log4js from 'log4js';

/* global process, __dirname */

const DLL_PATH = path.normalize(__dirname + '/../public/dll'),
  DIST_PATH = path.normalize(__dirname + '/../public/dist'),
  LOGIN_DIST_PATH = path.normalize(__dirname + '/../public/login_dist'),
  CDAP_DIST_PATH = path.normalize(__dirname + '/../public/cdap_dist'),
  MARKET_DIST_PATH = path.normalize(__dirname + '/../public/common_dist'),
  CONFIG_PATH = path.normalize(__dirname + '/server/config');

ejs.delimiter = '_';
const log = log4js.getLogger('default');
const isModeDevelopment = () => process.env.NODE_ENV === 'development';
const isModeProduction = () => process.env.NODE_ENV === 'production';

const getExpressStaticConfig = () => {
  if (isModeDevelopment()) {
    return {};
  }
  return {
    index: false,
    maxAge: '1y',
  };
};

const removeBCookie = (req, res, cookieSettings) => {
  // BCookie is the browser cookie, that is generated and will live for a year.
  // This cookie is no longer needed and should be deleted.
  if (req.cookies.bcookie) {
    const date = new Date(0); // Expire in the past to delete
    res.cookie('bcookie', '', { ...cookieSettings, expires: date } );
  }
}

export const stripAuthHeadersInProxyMode = (cdapConfig, res) => {
  if (cdapConfig['security.authentication.mode'] === 'PROXY' && typeof res.headers === 'object') {
    delete res.headers.Authorization;
    delete res.headers[cdapConfig['security.authentication.proxy.user.identity.header']];
  }
  return res;
};

function makeApp(authAddress, cdapConfig, uiSettings) {
  var app = express();
  const serverNonce = crypto.randomUUID();
  const isSecure = cdapConfig['ssl.external.enabled'] === 'true';
  const cookieSettings = { secure: isSecure, httpOnly: true, sameSite: 'strict' };

  /**
   * Express template setup
   */
  app.engine('html', ejs.renderFile);
  app.set('view engine', 'html');
  app.set('views', [
    `${CDAP_DIST_PATH}/cdap_assets`,
    `${LOGIN_DIST_PATH}/login_assets`,
    DLL_PATH,
    DIST_PATH,
    MARKET_DIST_PATH,
  ]);

  /**
   * Adding favicon to serveFavicon middleware
   */
  let uiThemeConfig = {};
  try {
    uiThemeConfig = uiThemeWrapper.extractUIThemeWrapper(cdapConfig);
  } catch (e) {
    // This means there was error reading the theme file.
    // We can ignore this as the extract theme takes care of it.
  }
  const faviconPath = uiThemeWrapper.getFaviconPath(uiThemeConfig);

  // middleware
  try {
    app.use(serveFavicon(faviconPath));
  } catch (e) {
    log.error('Favicon missing! Please run `gulp build`');
  }

  app.use(compression());
  app.use(
    '/api',
    proxy(constructUrl.bind(null, cdapConfig), {
      parseReqBody: false,
      limit: '500gb',
    })
  );
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(cookieParser());

  if (!isModeDevelopment()) {
    const proxyBaseUrl = cdapConfig['dashboard.proxy.base.url'];
    const hstsSettings = {
       maxAge: parseInt(cdapConfig["hsts.max.age"]),
       includeSubDomains: cdapConfig["hsts.include.sub.domains"] === 'true',
       preload: cdapConfig["hsts.preload"] === 'true',
    }
    let cspWhiteListUrls = [];
    if (proxyBaseUrl) {
      cspWhiteListUrls.push(proxyBaseUrl);
    }
    cspWhiteListUrls = cspWhiteListUrls
      .concat(getMarketUrls(cdapConfig))
      .map((urlString) => url.parse(urlString))
      .map((marketUrl) => `${marketUrl.protocol}//${marketUrl.host}`)
      .join(' ');

    /**
     * Adding nonce to every response pipe.
     */
    app.use((req, res, next) => {
      res.locals.nonce = uuidV4();
      next();
    });
    // Set security headers, including CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
    // Referrer-Policy, etc.
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            imgSrc: [`'self' data: ${cspWhiteListUrls}`, 'www.googletagmanager.com', 'https://www.gstatic.com', 'https://ssl.gstatic.com', 'https://www.google-analytics.com'],
            connectSrc: [`'self'`, 'https://www.google-analytics.com', 'https://ampcid.google.com'],
            fontSrc: [`'self'`, `'unsafe-inline'`, 'https://fonts.gstatic.com', 'data:'],
            scriptSrc: [
              (req, res) => `'nonce-${res.locals.nonce}'`,
              `'unsafe-inline'`,
              `nonce-${serverNonce}`,
              `'unsafe-eval'`,
              `'strict-dynamic' https: http:`,
              'https://tagmanager.google.com',
              'https://www.googletagmanager.com',
              'https://ssl.google-analytics.com',
              'https://www.google-analytics.com'
            ],
            baseUri: [`'self'`],
            styleSrc: [`'self'`, `'unsafe-inline'`,
            'https://tagmanager.google.com', 'https://fonts.googleapis.com'],
            objectSrc: [`'none'`],
            workerSrc: [`'self' blob:`],
            reportUri: `https://csp.withgoogle.com/csp/cdap`,
            upgradeInsecureRequests: null,
          },
        },
        hsts: cdapConfig["hsts.enabled"] === 'true' && hstsSettings,
        // Hub icons are cross-origin but don't supply CORS headers
        // TODO credentialless will also work but isn't supported by FF and Safari
        crossOriginEmbedderPolicy: false
      })
    );
  }

  /**
   * Adding default 500 error handler
   */
  app.use(function(err, req, res, next) {
    log.error(err);
    res.status(500).send(err);
    next(err);
  });

  app.get('/analytics.js', (req, res) => {
    /**
     * Add Google analytics tag manager if ui.GTM is present in the config
     */
    const GTM = cdapConfig['ui.GTM'];
    if (GTM) {
      res.header({
        'Content-Type': 'text/javascript',
        'Cache-Control': 'no-store, must-revalidate',
      });
      res.send(`
        let gaHeaderScript = document.createElement('script');
        gaHeaderScript.setAttribute('nonce', '${serverNonce}');
        gaHeaderScript.setAttribute('type', 'text/javascript');
        gaHeaderScript.innerHTML = "(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;var n=d.querySelector('[nonce]');n&&j.setAttribute('nonce',n.nonce||n.getAttribute('nonce'));f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM}');"
        document.head.appendChild(gaHeaderScript);
      `);
    } else {
      res.sendStatus(404);
    }
  });

  // serve the config file
  app.get('/config.js', function(req, res) {
    uiSettings.ui.externalLinks = cdapConfig.externalLinks;
    var data = JSON.stringify({
      // the following will be available in angular via the "MY_CONFIG" injectable

      cdap: {
        standaloneWebsiteSDKDownload:
          uiSettings['standalone.website.sdk.download'] === 'true' || false,
        uiDebugEnabled: uiSettings['ui.debug.enabled'] === 'true' || false,
        mode: process.env.NODE_ENV,
        proxyBaseUrl: cdapConfig['dashboard.proxy.base.url'],
        maxRecordsPreview: cdapConfig['preview.max.num.records'],
        ui: uiSettings['ui'],
        k8sWorkloadIdentityEnabled: cdapConfig['master.environment.k8s.workload.identity.enabled'],
        k8sWorkloadIdentityPool:cdapConfig['credential.provider.system.properties.gcp-wi-credential-provider.k8s.workload.identity.pool'],
        namespaceCreationHookEnabled: cdapConfig['namespaces.creation.hook.enabled'],
        hstsEnabled: cdapConfig['hsts.enabled'],
        hstsMaxAge: cdapConfig['hsts.max.age'],
        hstsIncludeSubDomains: cdapConfig['hsts.include.sub.domains'],
        hstsPreload: cdapConfig['hsts.preload'],
      },
      hydrator: {
        previewEnabled: cdapConfig['enable.preview'] === 'true',
        defaultCheckpointDir: cdapConfig['data.streams.default.checkpoint.directory'] || false,
      },
      delta: {
        defaultCheckpointDir: cdapConfig['delta.default.checkpoint.directory'] || false,
      },
      marketUrls: getMarketUrls(cdapConfig),
      securityEnabled: authAddress.enabled,
      securityMode: cdapConfig['security.authentication.mode'],
      isEnterprise: isModeProduction(),
      sandboxMode: process.env.NODE_ENV,
      authRefreshURL: cdapConfig['dashboard.auth.refresh.path'] || false,
      instanceMetadataId: cdapConfig['instance.metadata.id'],
      sslEnabled: isSecure,
      featureFlags: cdapConfig.featureFlags,
      analyticsTag: cdapConfig['ui.analyticsTag'],
      googleTagManager: cdapConfig['ui.GTM'],
      cookieBannerText: cdapConfig['ui.cookieBannerText'],
      cookieBannerLink: cdapConfig['ui.cookieBannerLink']

    });

    res.header({
      'Content-Type': 'text/javascript',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.send('window.CDAP_CONFIG = ' + data + ';');
  });

  app.get('/ui-config.js', function(req, res) {
    // var path = __dirname + '/config/cdap-ui-config.json';
    var path = CONFIG_PATH + '/cdap-ui-config.json';

    var fileConfig = {};

    fileConfig = fs.readFileSync(path, 'utf8');
    res.header({
      'Content-Type': 'text/javascript',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.send('window.CDAP_UI_CONFIG = ' + fileConfig + ';');
  });

  app.get('/ui-theme.js', function(req, res) {
    res.header({
      'Content-Type': 'text/javascript',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.send(`window.CDAP_UI_THEME = ${JSON.stringify(uiThemeConfig)};`);
  });

  /**
   * This is used to stream content from Market directly to CDAP
   * ie. download app from market, and publish to CDAP
   *
   * Query parameters:
   *    source: Link to the content to forward
   *    sourceMethod: HTTP method to obtain content (default to GET)
   *    target: CDAP API
   *    targetMethod: HTTP method for the CDAP API (default to POST)
   **/
  app.get('/forwardMarketToCdap', function(req, res) {
    var sourceLink = req.query.source,
      targetLink = req.query.target,
      sourceMethod = req.query.sourceMethod || 'GET',
      targetMethod = req.query.targetMethod || 'POST';
    let authToken = req.headers.authorization;
    if (
      !req.headers['session-token'] ||
      (req.headers['session-token'] &&
        !sessionToken.validateToken(req.headers['session-token'], cdapConfig, log, authToken))
    ) {
      return res.status(500).send('Unable to validate session');
    }
    if (!isVerifiedMarketHost(cdapConfig, sourceLink)) {
      return res.status(403).send('Invalid source link');
    }
    sourceLink = constructUrl(cdapConfig, sourceLink, REQUEST_ORIGIN_MARKET);
    targetLink = constructUrl(cdapConfig, targetLink);
    var forwardRequestObject = {
      url: targetLink,
      method: targetMethod,
      headers: req.headers,
    };

    request({
      url: sourceLink,
      method: sourceMethod,
    })
      .on('error', function(e) {
        log.error('Error', e);
      })
      .pipe(request(forwardRequestObject))
      .on('response', function(resFromBackend) {
        var strippedResponse = stripAuthHeadersInProxyMode(cdapConfig, resFromBackend);
        var newHeaders = strippedResponse.headers;
        res.set(newHeaders);
      })
      .on('error', function(e) {
        log.error('Error', e);
      })
      .pipe(res);
  });

  /**
   * This is used to send GET requests to the market endpoint to,
   * for example, show the plugins available on the Hub.
   *
   * Query parameters:
   *   source: Link to the market resource to retrieve
   */
  app.get('/market', function(req, res) {
    const sourceLink = req.query['source'];

    log.debug('[REQUEST]: (method: ' + req.method + ', url: ' + sourceLink + ')');

    // early out if market place url is invalid. The server won't attempt to request the specified url.
    if (!isVerifiedMarketHost(cdapConfig, sourceLink)) {
      const errorMsg = 'invalid market request';
      log.error('[ERROR]: (url: ' + sourceLink + ') ' + errorMsg);
      return res.status(403).send(errorMsg);
    }

    request(
      {
        method: 'GET',
        url: sourceLink,
        agent: false,
      },
      function(err, marketResponse) {
        if (err) {
          log.error(
            '[ERROR] Market request to url: ' + sourceLink + ' responded with error: ' + err
          );
          res.status((marketResponse && marketResponse.statusCode) || 502).send(err);
        } else {
          res.status(marketResponse.statusCode).send(marketResponse.body);
        }
      }
    ).on('error', function(err) {
      log.error('[ERROR] Market request had error: (url: ' + sourceLink + ') ' + err.message);
      res.status(502).send(err.message);
    });
  });

  app.get('/downloadLogs', function(req, res) {
    var url = constructUrl(cdapConfig, decodeURIComponent(req.query.backendPath));
    var method = req.query.method || 'GET';
    log.info('Download Logs Start: ', url);
    var customHeaders;
    var requestObject = {
      method: method,
      url: url,
      rejectUnauthorized: false,
      requestCert: true,
      agent: false,
    };

    if (req.cookies && req.cookies['CDAP_Auth_Token']) {
      customHeaders = {
        authorization: 'Bearer ' + req.cookies['CDAP_Auth_Token'],
      };
    }

    if (req.headers.authorization) {
      customHeaders = {
        authorization: req.headers.authorization,
      };
      if (cdapConfig['security.authentication.mode'] === 'PROXY') {
        const userIdProperty = cdapConfig['security.authentication.proxy.user.identity.header'];
        customHeaders[userIdProperty] = req.headers[userIdProperty];
      }
    }

    if (customHeaders) {
      requestObject.headers = customHeaders;
    }

    var type = req.query.type;
    var responseHeaders = {
      'Cache-Control': 'no-cache, no-store',
    };

    try {
      request(requestObject)
        .on('error', function(e) {
          log.error('Error request logs: ', e);
        })
        .on('response', function(response) {
          // This happens when use tries to access the link directly when
          // no autorization token present
          if (response.statusCode === 200) {
            if (type === 'download') {
              var filename = req.query.filename;
              responseHeaders['Content-Disposition'] = 'attachment; filename=' + filename;
            } else {
              responseHeaders['Content-Type'] = 'text/plain';
            }
            let strippedResponse = stripAuthHeadersInProxyMode(cdapConfig, {
              headers: responseHeaders,
            });
            responseHeaders = strippedResponse.headers;
            res.set(responseHeaders);
          }
        })
        .pipe(res)
        .on('error', function(e) {
          log.error('Error downloading logs: ', e);
        });
    } catch (e) {
      log.error('Downloading logs failed, ', e);
    }
  });

  /*
    For now both login and accessToken APIs do the same thing.
    This is only for semantic differntiation. In the future ideally
    these endpoints will vary based on success failure conditions.
    (A 404 vs warning for login vs token)

  */
  app.post('/login', authentication);

  app.post('/accessToken', authentication);

  /*
    Handle POST requests made outside of the websockets from front-end.
    For now it handles file upload POST /namespaces/:namespace/apps API
  */
  app.post('/namespaces/:namespace/:path(*)', function(req, res) {
    var headers = {};
    if (req.headers) {
      headers = req.headers;
    }
    let authToken = req.headers.authorization;
    if (
      !req.headers['session-token'] ||
      (req.headers['session-token'] &&
        !sessionToken.validateToken(req.headers['session-token'], cdapConfig, log, authToken))
    ) {
      return res.status(500).send('Unable to validate session');
    }
    const constructedPath = `/v3/namespaces/${req.param('namespace')}/${req.param('path')}`;
    var opts = {
      method: 'POST',
      url: constructUrl(cdapConfig, constructedPath),
      headers: {
        'Content-Type': headers['content-type'],
      },
    };

    req
      .on('error', function(e) {
        log.error(e);
      })
      .pipe(request.post(opts))
      .on('response', function(newRes) {
        var strippedResponse = stripAuthHeadersInProxyMode(cdapConfig, newRes);
        var newHeaders = strippedResponse.headers;
        res.set(newHeaders);
      })
      .on('error', function(e) {
        log.error(e);
      })
      .pipe(res)
      .on('error', function(e) {
        log.error(e);
      });
  });
  // serve static assets
  app.use('/assets', [
    express.static(DIST_PATH + '/assets'),
    function(req, res) {
      finalhandler(req, res)(false); // 404
    },
  ]);
  app.use('/cdap_assets', [
    express.static(CDAP_DIST_PATH + '/cdap_assets', getExpressStaticConfig()),
    function(req, res) {
      finalhandler(req, res)(false); // 404
    },
  ]);
  app.use('/dll_assets', [
    express.static(DLL_PATH, getExpressStaticConfig()),
    function(req, res) {
      finalhandler(req, res)(false);
    },
  ]);
  app.use('/login_assets', [
    express.static(LOGIN_DIST_PATH + '/login_assets', getExpressStaticConfig()),
    function(req, res) {
      finalhandler(req, res)(false); // 404
    },
  ]);
  app.use('/common_assets', [
    express.static(MARKET_DIST_PATH, {
      index: false,
    }),
    function(req, res) {
      finalhandler(req, res)(false); // 404
    },
  ]);
  app.get('/robots.txt', [
    function(req, res) {
      res.type('text/plain');
      res.send('User-agent: *\nDisallow: /');
    },
  ]);

  function authentication(req, res) {
    var opts = {
      auth: {
        user: req.body.username,
        password: req.body.password,
      },
      url: authAddress.get(),
    };
    request(opts, function(nerr, nres, nbody) {
      if (nerr || nres.statusCode !== 200) {
        var statusCode = (nres ? nres.statusCode : 500) || 500;
        res.status(statusCode).send(nbody);
      } else {
        const jsonBody = JSON.parse(nbody);
        jsonBody.isSecure = isSecure;
        res.send(JSON.stringify(jsonBody));
      }
    });
  }

  // CDAP-678, CDAP-8260 This is added for health check on node proxy.
  app.get('/status', function(req, res) {
    res.send(200, 'OK');
  });

  app.get('/login', [
    function(req, res) {
      if (!authAddress.get() || req.headers.authorization) {
        res.redirect('/');
        return;
      }
      res.render('login', { nonceVal: res.locals.nonce });
    },
  ]);

  app.get('/sessionToken', function(req, res) {
    let authToken = req.headers.authorization || '';
    const sToken = sessionToken.generateToken(cdapConfig, log, authToken);
    res.send(sToken);
  });

  /*
    For now both login and accessToken APIs do the same thing.
    This is only for semantic differntiation. In the future ideally
    these endpoints will vary based on success failure conditions.
    (A 404 vs warning for login vs token)

  */
  app.post('/login', authentication);

  app.get('/backendstatus', [
    function(req, res) {
      var protocol, port;
      if (isSecure) {
        protocol = 'https://';
      } else {
        protocol = 'http://';
      }

      if (isSecure) {
        port = cdapConfig['router.ssl.server.port'];
      } else {
        port = cdapConfig['router.server.port'];
      }

      var link = [protocol, cdapConfig['router.server.address'], ':', port, '/v3/namespaces'].join(
        ''
      );

      // FIXME: The reason for doing this is here: https://issues.cask.co/browse/CDAP-9059
      // TL;DR - The source of this issue is because of large browser urls
      // which gets added to headers while making /backendstatus http call.
      // That is the reason we are temporarily stripping out referer from the headers.
      var headers = req.headers;
      delete headers.referer;
      request(
        {
          method: 'GET',
          url: link,
          rejectUnauthorized: false,
          requestCert: true,
          agent: false,
          headers: headers,
        },
        function(err, response) {
          if (err) {
            log.info('Server responded with error: ' + err + ' for API : "/v3/namespaces"');
            res.status((response && response.statusCode) || 502).send(err);
          } else {
            res.status(response.statusCode).send('OK');
          }
        }
      ).on('error', function(err) {
        // If an error hasn't already been sent, send it here
        if (!res.headersSent) {
          try {
            res.status(502).send(err);
          } catch (e) {
            log.error('Failed sending exception to client', e);
          }
          log.error(err);
        }
      });
    },
  ]);

  /**
   * This is right now purely for testing purposes. This helps us
   * update the theme from API and test different theming scenarios.
   *
   * This won't be for production as we don't persist this state anywhere.
   * In the future if we alow the user to change the theme from UI this API could
   * be used and we need to persist this information somewhere.
   */
  app.post('/updateTheme', function(req, res) {
    let authToken = req.headers.authorization;
    if (
      !req.headers['session-token'] ||
      (req.headers['session-token'] &&
        !sessionToken.validateToken(req.headers['session-token'], cdapConfig, log, authToken))
    ) {
      return res.status(500).send('Unable to validate session');
    }
    const uiThemePath = req.body.uiThemePath;
    if (!uiThemePath) {
      return res.status(500).send('UnKnown theme file. Please make sure the path is valid');
    }
    try {
      uiThemeConfig = uiThemeWrapper.extractUITheme(cdapConfig, uiThemePath);
    } catch (e) {
      return res
        .status(500)
        .send(
          'Error parsing theme file. Please make sure the path and the file contents are valid'
        );
    }
    res.send('Theme updated');
  });

  // any other path, serve index.html
  app.all(
    ['/pipelines', '/pipelines/*'],
    [
      function(req, res) {
        removeBCookie(req, res, cookieSettings);
        res.render('hydrator', { nonceVal: res.locals.nonce });
      },
    ]
  );

  app.all(
    ['/', '/cdap', '/cdap/*'],
    [
      function(req, res) {
        removeBCookie(req, res, cookieSettings);
        res.render('cdap', { nonceVal: `${res.locals.nonce}` });
      },
    ]
  );

  return app;
}

export function getApp(cdapConfig) {
  return q
    .all([
      // router check also fetches the auth server address if security is enabled
      ping(),
      Promise.resolve(cdapConfig),
      extractUISettings(),
    ])
    .spread(makeApp);
}
