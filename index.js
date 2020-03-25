const path = require('path');

const RedisStore = require('rate-limit-redis');
const express = require('express');
const expressNunjucks = require('express-nunjucks');
const javascriptStringify = require('javascript-stringify').stringify;
const qs = require('qs');
const rateLimit = require('express-rate-limit');
const text2png = require('text2png');

const apiKeys = require('./api_keys');
const packageJson = require('./package.json');
const telemetry = require('./telemetry');
const { getPdfBufferFromPng, getPdfBufferWithText } = require('./lib/pdf');
const { logger } = require('./logging');
const { renderChart } = require('./lib/charts');
const { toChartJs } = require('./lib/google_image_charts');
const { renderQr, DEFAULT_QR_SIZE } = require('./lib/qr');

require('dotenv').config({
  path: __dirname + '/.env',
});

const app = express();

const isDev = app.get('env') === 'development' || app.get('env') === 'test';

app.set('query parser', str =>
  qs.parse(str, {
    decode(s) {
      // Default express implementation replaces '+' with space. We don't want
      // that. See https://github.com/expressjs/express/issues/3453
      return decodeURIComponent(s);
    },
  }),
);
app.set('views', `${__dirname}/templates`);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded());

/*
if (process.env.RATE_LIMIT_PER_MIN) {
  const limitMax = parseInt(process.env.RATE_LIMIT_PER_MIN, 10);
  logger.info('Enabling rate limit:', limitMax);

  let store = undefined;
  if (process.env.REDIS_URL) {
    logger.info(`Connecting to redis: ${process.env.REDIS_URL}`);
    store = new RedisStore({
      redisURL: process.env.REDIS_URL,
    });
  }

  const limiter = rateLimit({
    store,
    windowMs: 60 * 1000,
    max: limitMax,
    message:
      'Please slow down your requests! This is a shared public endpoint. Email support@quickchart.io or go to https://quickchart.io/pricing for rate limit exceptions or to purchase a commercial license.',
    onLimitReached: req => {
      logger.info('User hit rate limit!', req.ip);
    },
    skip: req => {
      // If user has a special key, bypass rate limiting.
      const ret = apiKeys.requestHasValidKey(req);
      if (ret) {
        apiKeys.countRequest(req);
      }
      return ret;
    },
    keyGenerator: req => {
      return req.headers['x-forwarded-for'] || req.ip;
    },
  });
  app.use('/chart', limiter);
}
*/

// expressNunjucks(app, {
//   watch: isDev,
//   noCache: isDev,
// });

// app.get('/', (req, res) => {
//   res.status(404).send('Not found');
// });

/*
app.get('/pricing', (req, res) => {
  res.render('pricing');
});

app.get('/documentation', (req, res) => {
  res.render('docs');
});

app.get('/documentation/migrating-from-google-image-charts', (req, res) => {
  res.render('google_image_charts_replacement');
});

app.get('/robots.txt', (req, res) => {
  res.sendFile(path.join(__dirname, './templates/robots.txt'));
});

app.post('/telemetry', (req, res) => {
  const chartCount = parseInt(req.body.chartCount, 10);
  const qrCount = parseInt(req.body.qrCount, 10);
  const pid = req.body.pid;

  if (chartCount && !isNaN(chartCount)) {
    telemetry.receive(pid, 'chartCount', chartCount);
  }
  if (qrCount && !isNaN(qrCount)) {
    telemetry.receive(pid, 'qrCount', qrCount);
  }

  res.send({ success: true });
});

app.get('/payment-success', (req, res) => {
  res.render('payment_success');
});

app.get('/api/account/:key', (req, res) => {
  const key = req.params.key;
  res.send({
    isValid: apiKeys.isValidKey(key),
    numRecentRequests: apiKeys.getNumRecentRequests(key),
  });
});
*/

function failPng(res, msg) {
  res.writeHead(500, {
    'Content-Type': 'image/png',
  });
  res.end(
    text2png(`Chart Error: ${msg}`, {
      padding: 10,
      backgroundColor: '#fff',
    }),
  );
}

async function failPdf(res, msg) {
  const buf = await getPdfBufferWithText(msg);
  res.writeHead(500, {
    'Content-Type': 'application/pdf',
  });
  res.end(buf);
}

function doRenderChart(req, res, opts) {
  opts.failFn = failPng;
  opts.onRenderHandler = buf => {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,

      // 1 week cache
      'Cache-Control': 'public, max-age=604800',
    });
    res.end(buf);
  };
  doRender(req, res, opts);
}

async function doRenderPdf(req, res, opts) {
  opts.failFn = failPdf;
  opts.onRenderHandler = async buf => {
    const pdfBuf = await getPdfBufferFromPng(buf);

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBuf.length,

      // 1 week cache
      'Cache-Control': 'public, max-age=604800',
    });
    res.end(pdfBuf);
  };
  doRender(req, res, opts);
}

function doRender(req, res, opts) {
  if (!opts.chart) {
    opts.failFn(res, 'You are missing variable `c` or `chart`');
    return;
  }

  let height = 300;
  let width = 500;
  if (opts.height) {
    const heightNum = parseInt(opts.height, 10);
    if (!Number.isNaN(heightNum)) {
      height = heightNum;
    }
  }
  if (opts.width) {
    const widthNum = parseInt(opts.width, 10);
    if (!Number.isNaN(widthNum)) {
      width = widthNum;
    }
  }

  // Choose retina resolution by default. This will cause images to be 2x size
  // in absolute terms.
  const devicePixelRatio = opts.devicePixelRatio || 2.0;

  let untrustedInput = opts.chart;
  if (opts.encoding === 'base64') {
    try {
      untrustedInput = Buffer.from(opts.chart, 'base64').toString('utf8');
    } catch (err) {
      logger.warn('base64 malformed', err);
      opts.failFn(res, err);
      return;
    }
  }

  const backgroundColor = opts.backgroundColor || 'transparent';

  renderChart(width, height, backgroundColor, devicePixelRatio, untrustedInput)
    .then(opts.onRenderHandler)
    .catch(err => {
      logger.warn('Chart error', err);
      opts.failFn(res, err);
    });
}

function handleGChart(req, res) {
  const converted = toChartJs(req.query);
  if (req.query.format === 'chartjs-config') {
    res.end(javascriptStringify(converted.chart, undefined, 2));
    return;
  }

  renderChart(
    converted.width,
    converted.height,
    converted.backgroundColor,
    undefined,
    converted.chart,
  ).then(buf => {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,

      // 1 week cache
      'Cache-Control': 'public, max-age=604800',
    });
    res.end(buf);
  });
  // TODO(ian): Telemetry.
}

app.get('/chart', (req, res) => {
  if (req.query.cht) {
    // This is a Google Image Charts-compatible request.
    return handleGChart(req, res);
  }

  const opts = {
    chart: req.query.c || req.query.chart,
    height: req.query.h || req.query.height,
    width: req.query.w || req.query.width,
    backgroundColor: req.query.backgroundColor || req.query.bkg,
    devicePixelRatio: req.query.devicePixelRatio,
    encoding: req.query.encoding || 'url',
  };

  const outputFormat = (req.query.f || req.query.format || '').toLowerCase();

  if (outputFormat === 'pdf') {
    doRenderPdf(req, res, opts);
  } else {
    doRenderChart(req, res, opts);
  }

  //telemetry.count('chartCount');
});

app.post('/chart', (req, res) => {
  const opts = {
    chart: req.body.c || req.body.chart,
    height: req.body.h || req.body.height,
    width: req.body.w || req.body.width,
    backgroundColor: req.body.backgroundColor || req.body.bkg,
    devicePixelRatio: req.body.devicePixelRatio,
    encoding: req.body.encoding || 'url',
  };
  const outputFormat = (req.body.f || req.body.format || '').toLowerCase();

  if (outputFormat === 'pdf') {
    doRenderPdf(req, res, opts);
  } else {
    doRenderChart(req, res, opts);
  }

  //telemetry.count('chartCount');
});

app.get('/qr', (req, res) => {
  if (!req.query.text) {
    failPng(res, 'You are missing variable `text`');
    return;
  }

  let format = 'png';
  if (req.query.format === 'svg') {
    format = 'svg';
  }

  const { mode } = req.query;

  const margin = typeof req.query.margin === 'undefined' ? 4 : parseInt(req.query.margin, 10);
  const ecLevel = req.query.ecLevel || undefined;
  const size = Math.min(3000, parseInt(req.query.size, 10)) || DEFAULT_QR_SIZE;
  const darkColor = req.query.dark || '000';
  const lightColor = req.query.light || 'fff';

  let qrData;
  try {
    qrData = decodeURIComponent(req.query.text);
  } catch (err) {
    logger.warn('URI malformed', err);
    failPng(res, 'URI malformed');
    return;
  }
  const qrOpts = {
    margin,
    width: size,
    errorCorrectionLevel: ecLevel,
    color: {
      dark: darkColor,
      light: lightColor,
    },
  };

  renderQr(format, mode, qrData, qrOpts)
    .then(buf => {
      res.writeHead(200, {
        'Content-Type': format === 'png' ? 'image/png' : 'image/svg+xml',
        'Content-Length': buf.length,

        // 1 week cache
        'Cache-Control': 'public, max-age=604800',
      });
      res.end(buf);
    })
    .catch(err => {
      failPng(res, err);
    });

  //telemetry.count('qrCount');
});

app.get('/gchart', handleGChart);

/*
app.get('/healthcheck', (req, res) => {
  // A lightweight healthcheck endpoint.
  res.send({ success: true, version: packageJson.version });
});

app.get('/healthcheck/chart', (req, res) => {
  // A heavier healthcheck endpoint that redirects to a unique chart.
  const labels = [...Array(5)].map(() => Math.random());
  const data = [...Array(5)].map(() => Math.random());
  const template = `
{
  type: 'bar',
  data: {
    labels: [${labels.join(',')}],
    datasets: [{
      data: [${data.join(',')}]
    }]
  }
}
`;
  res.redirect(`/chart?c=${template}`);
});
*/

const port = process.env.PORT || 3400;
const server = app.listen(port);

const timeout = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 1000;
server.setTimeout(timeout);
logger.info(`Setting request timeout: ${timeout} ms`);

logger.info(`NODE_ENV: ${process.env.NODE_ENV}`);
logger.info(`Listening on port ${port}`);

if (!isDev) {
  const gracefulShutdown = function gracefulShutdown() {
    logger.info('Received kill signal, shutting down gracefully.');
    server.close(() => {
      logger.info('Closed out remaining connections.');
      process.exit();
    });

    setTimeout(() => {
      logger.error('Could not close connections in time, forcefully shutting down');
      process.exit();
    }, 10 * 1000);
  };

  // listen for TERM signal .e.g. kill
  process.on('SIGTERM', gracefulShutdown);

  // listen for INT signal e.g. Ctrl-C
  process.on('SIGINT', gracefulShutdown);

  process.on('SIGABRT', () => {
    logger.info('Caught SIGABRT');
  });
}

module.exports = app;
