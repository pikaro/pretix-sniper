#!/usr/bin/env node
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const SAMPLES = 10;
const MAX_CALIBRATION_ATTEMPTS = SAMPLES + 3;
const IDLE_MS = 10_000;
const SALE_WARMUP_MS = 5_000;
const EXPECTED_WAIT_MS = 110;
const WAIT_TOLERANCE_MS = 25;
const ANSI = {
  plain: 0,
  bold: 1,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34
};

async function main() {
  const options = readOptions();
  if (options === null) {
    return;
  }

  const { url, port, targetMs, correctionMs, output } = options;
  const cdp = await connectToShop(url, port);

  try {
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');

    if (!output.json) {
      console.log(style('Reload timing - UTC', ANSI.bold, output));
    }

    const samples = await checkTiming(cdp, url, output);
    const offset = median(samples.map(sample => sample.render_offset_ms));
    reportCalibration(samples, offset, output);

    if (targetMs === null) {
      return;
    }

    const effectiveOffset = offset + correctionMs;
    const reloadMs = targetMs + effectiveOffset;
    const warmupMs = targetMs - SALE_WARMUP_MS;
    if (warmupMs <= now()) {
      throw new Error('Calibration finished too late for the T−5s warmup');
    }
    if (reloadMs <= warmupMs) {
      throw new Error('Corrected reload must be after the T−5s warmup');
    }

    console.error(`\n${style('Armed', ANSI.bold, output)}`);
    console.error(`  Target           ${style(timestamp(targetMs), ANSI.blue, output)}`);
    console.error(`  Correction       ${style(milliseconds(correctionMs, true), ANSI.blue, output)} ms`);
    console.error(`  Effective offset ${style(milliseconds(effectiveOffset, true), ANSI.blue, output)} ms`);
    console.error(`  Warmup           ${style(timestamp(warmupMs), ANSI.blue, output)}`);
    console.error(`  Reload           ${style(timestamp(reloadMs), ANSI.blue, output)}`);

    const warmup = await reload(cdp, url, 'sale-warmup', warmupMs);
    reportSample(warmup, samples, output);
    validateSample(warmup);

    const final = await reload(cdp, url, 'scheduled-reload', reloadMs);
    reportSample(final, samples, output);
    reportResult(final, targetMs, correctionMs, offset, output);
    if (!final.connection_reused) {
      console.error(style('Final connection: NEW — reload sent', ANSI.yellow, output));
    }
  } finally {
    cdp.close();
  }
}

/** A persistent connection to one Chrome tab. */
class CDP extends EventEmitter {
  #socket;
  #sequence = 0;
  #pending = new Map();

  /**
   * @param {WebSocket} socket
   */
  constructor(socket) {
    super();
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id === undefined) {
        this.emit('event', message.method, message.params);
        return;
      }

      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }

      this.#pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
    const disconnected = () => {
      const error = new Error('Chrome debugging connection closed');
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.emit('disconnected', error);
    };
    socket.addEventListener('close', disconnected);
    socket.addEventListener('error', disconnected);
  }

  /**
   * @param {string} url
   * @returns {Promise<CDP>}
   */
  static async connect(url) {
    const socket = new WebSocket(url);
    const cdp = new CDP(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to Chrome'));
      }, 5000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Cannot connect to Chrome debugging WebSocket'));
      }, { once: true });
    });
    return cdp;
  }

  /**
   * @param {string} method
   * @param {object} params
   * @returns {Promise<object>}
   */
  send(method, params = {}) {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.#socket.close();
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function queueUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Queue URL must be HTTP(S), without embedded credentials');
  }
  url.hash = '';
  return url.href;
}

/**
 * @param {string} html
 * @returns {number|null}
 */
function serverRenderTime(html) {
  const body = html.match(/<body\b[^>]*>/i)?.[0];
  const value = body?.match(/\sdata-now\s*=\s*(["'])(\d+(?:\.\d+)?)\1/i)?.[2];
  const timestampMs = value === undefined ? NaN : Number(value) * 1000;
  return Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : null;
}

const now = () => performance.timeOrigin + performance.now();

/**
 * @param {number} deadlineMs
 * @returns {Promise<void>}
 */
async function waitUntil(deadlineMs) {
  while (deadlineMs - now() > 2) {
    await sleep(Math.min(deadlineMs - now() - 2, 1000));
  }

  // Keep the last 2 ms out of the timer queue.
  while (now() < deadlineMs) {
  }
}

/**
 * Map Chrome's monotonic network timings to its request's epoch clock.
 * @param {RequestSent} request Network.requestWillBeSent parameters
 * @param {Response} response Network.Response
 * @param {number|null} finished Monotonic loadingFinished timestamp, or null on redirect
 * @param {number} commandMs Local epoch timestamp immediately before Page.reload
 * @param {number} deadlineMs Scheduled local epoch timestamp
 * @returns {Measurement}
 */
function measure(request, response, finished, commandMs, deadlineMs) {
  const timing = response.timing;
  if (!timing || !Number.isFinite(timing.requestTime) || !Number.isFinite(request.wallTime) ||
    !Number.isFinite(request.timestamp) ||
    !['sendStart', 'sendEnd', 'receiveHeadersStart', 'receiveHeadersEnd'].every(
      key => Number.isFinite(timing[key]) && timing[key] >= 0)) {
    throw new Error('Chrome did not supply complete network timing');
  }

  const baseMs = (request.wallTime - request.timestamp + timing.requestTime) * 1000;
  let finishedEpochMs = null;
  let receivingMs = null;

  if (finished !== null) {
    const durationMs = (finished - timing.requestTime) * 1000;
    finishedEpochMs = baseMs + durationMs;
    receivingMs = durationMs - timing.receiveHeadersEnd;
  }

  return {
    deadline_epoch_ms: deadlineMs,
    command_epoch_ms: commandMs,
    request_epoch_ms: request.wallTime * 1000,
    send_epoch_ms: baseMs + timing.sendStart,
    send_end_epoch_ms: baseMs + timing.sendEnd,
    first_byte_epoch_ms: baseMs + timing.receiveHeadersStart,
    headers_epoch_ms: baseMs + timing.receiveHeadersEnd,
    finished_epoch_ms: finishedEpochMs,
    dispatch_ms: baseMs + timing.sendStart - commandMs,
    scheduling_late_ms: commandMs - deadlineMs,
    waiting_ms: timing.receiveHeadersStart - timing.sendEnd,
    receiving_ms: receivingMs,
    connection_reused: response.connectionReused,
    connection_id: response.connectionId,
    protocol: response.protocol,
    status: response.status,
    cached:
      Boolean(response.fromDiskCache || response.fromServiceWorker || response.fromPrefetchCache),
    server_render_epoch_ms: null,
    render_offset_ms: null,
  };
}

/**
 * Reload the selected document once and measure its first HTTP response.
 * Redirects are recorded without issuing any additional reload.
 * @param {CDP} cdp
 * @param {string} url
 * @param {string} label
 * @param {number|undefined} deadlineMs
 * @returns {Promise<Measurement & {label: string}>}
 */
async function reload(cdp, url, label, deadlineMs) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { id: frameId, loaderId, url: currentUrl } = frameTree.frame;
  if (queueUrl(currentUrl) !== url) {
    throw new Error('Selected tab left the queue URL');
  }

  if (deadlineMs !== undefined) {
    if (deadlineMs <= now()) {
      throw new Error(`${label}: reload deadline has passed`);
    }
    await waitUntil(deadlineMs);
  }

  return new Promise((resolve, reject) => {
    let request;
    let response;
    let commandMs;

    const cleanup = () => {
      clearTimeout(timer);
      cdp.off('event', onEvent);
      cdp.off('disconnected', fail);
    };

    const fail = error => {
      cleanup();
      reject(error);
    };

    const finish = async finished => {
      const result = { label, ...measure(request, response, finished, commandMs, deadlineMs) };
      cleanup();
      if (finished !== null && response.status >= 200 && response.status < 300) {
        // Read this request's response, so a later DOM update cannot change the timestamp.
        const content = await cdp.send('Network.getResponseBody', { requestId: request.requestId });
        let html = content.body;
        if (content.base64Encoded) {
          html = Buffer.from(content.body, 'base64').toString('utf8');
        }

        result.server_render_epoch_ms = serverRenderTime(html);
        if (result.server_render_epoch_ms !== null) {
          result.render_offset_ms = commandMs - result.server_render_epoch_ms;
        }
      }
      resolve(result);
    };

    const onEvent = (method, params) => {
      try {
        if (method === 'Network.requestWillBeSent' && params.frameId === frameId &&
          params.type === 'Document') {
          if (!request) {
            if (queueUrl(params.request.url) !== url || params.request.method !== 'GET') {
              throw new Error('Reload did not issue a GET for the queue URL');
            }
            request = params;
            return;
          }

          if (params.requestId !== request.requestId || !params.redirectResponse) {
            throw new Error('Another navigation interrupted the measured reload');
          }
          response = params.redirectResponse;
          finish(null).catch(fail);
          return;
        }

        if (!request || params.requestId !== request.requestId) {
          return;
        }

        switch (method) {
          case 'Network.responseReceived':
            response = params.response;
            break;
          case 'Network.loadingFinished':
            if (response) {
              finish(params.timestamp).catch(fail);
            }
            break;
          case 'Network.loadingFailed':
            throw new Error(params.errorText);
        }
      } catch (error) {
        fail(error);
      }
    };
    const timer =
      setTimeout(() => fail(new Error(`${label}: reload measurement timed out`)), 15_000);
    cdp.on('event', onEvent);
    cdp.once('disconnected', fail);
    commandMs = now();
    deadlineMs ??= commandMs;
    // loaderId prevents a delayed command from reloading a page navigated by the user.
    cdp.send('Page.reload', { ignoreCache: true, loaderId }).catch(fail);
  });
}

/**
 * @param {Measurement} sample
 * @returns {asserts sample is CalibrationSample}
 */
function validateSample(sample) {
  if (sample.status < 200 || sample.status >= 300 || sample.cached ||
    sample.server_render_epoch_ms === null || sample.render_offset_ms === null) {
    throw new Error('Calibration requires a fresh 2xx shop response with body[data-now]');
  }
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/**
 * @param {string} value
 * @param {number} code
 * @param {OutputOptions} output
 * @returns {string}
 */
function style(value, code, output) {
  return output.color ? `\x1b[${code}m${value}\x1b[0m` : value;
}

/**
 * @param {number|null} deltaMs
 * @returns {number}
 */
function deviationColor(deltaMs) {
  if (deltaMs === null) {
    return ANSI.plain;
  }
  if (Math.abs(deltaMs) <= 5) {
    return ANSI.green;
  }
  if (Math.abs(deltaMs) <= 15) {
    return ANSI.yellow;
  }
  return ANSI.red;
}

/**
 * @param {number|null} value
 * @returns {string}
 */
function timestamp(value) {
  return value === null ? 'unavailable' : new Date(Math.round(value)).toISOString();
}

/**
 * @param {number|null} value
 * @param {boolean} signed
 * @returns {string}
 */
function milliseconds(value, signed = false) {
  return value === null ? '—' : `${signed && value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

/**
 * @param {Measurement & {label: string}} sample
 * @param {Measurement[]} baseline Accepted warm samples, excluding the sample being displayed.
 * @param {OutputOptions} output
 */
function reportSample(sample, baseline, output) {
  if (output.json) {
    console.log(JSON.stringify(sample));
    return;
  }
  let heading = 'Final reload';
  if (sample.label === 'idle-check') {
    heading = `Calibration ${baseline.length + 1}/${SAMPLES}`;
  } else if (sample.label === 'initial-warmup') {
    heading = 'Initial warmup';
  } else if (sample.label === 'sale-warmup') {
    heading = 'Sale warmup';
  }

  console.log(`\n${style(heading, ANSI.bold, output)}`);

  const goodResponse = sample.status >= 200 && sample.status < 300 && !sample.cached;
  const statusText = `HTTP ${sample.status}${sample.cached ? ' - cached' : ''}`;
  const statusColor = goodResponse ? ANSI.green : ANSI.red;
  const connectionText =
    `${sample.connection_reused ? 'reused' : 'new'} connection ${sample.connection_id}`;
  let connectionColor = ANSI.green;
  if (!sample.connection_reused) {
    connectionColor = sample.label === 'scheduled-reload' ? ANSI.red : ANSI.yellow;
  }

  const status = style(statusText, statusColor, output);
  const connection = style(connectionText, connectionColor, output);
  console.log(`  ${status} - ${connection} - ${sample.protocol}`);

  console.log(
    style('  Stage           Timestamp (UTC)             Elapsed ms  Expected ms       Δ ms',
      ANSI.bold,
      output));
  /** @type {[string, TimestampKey, TimestampKey][]} */
  const stages = [
    ['RPC command', 'command_epoch_ms', 'deadline_epoch_ms'],
    ['Request', 'request_epoch_ms', 'command_epoch_ms'],
    ['Send start', 'send_epoch_ms', 'request_epoch_ms'],
    ['Send complete', 'send_end_epoch_ms', 'send_epoch_ms'],
    ['First byte', 'first_byte_epoch_ms', 'send_end_epoch_ms'],
    ['Headers', 'headers_epoch_ms', 'first_byte_epoch_ms'],
    ['Body complete', 'finished_epoch_ms', 'headers_epoch_ms'],
    ['RPC → render', 'server_render_epoch_ms', 'command_epoch_ms'],
  ];

  for (const [name, end, start] of stages) {
    const actualTime = sample[end];
    const startTime = sample[start];
    const elapsed = actualTime === null || startTime === null ? null : actualTime - startTime;
    const durations = baseline.flatMap(value => {
      const endTime = value[end];
      const startTime = value[start];
      return endTime === null || startTime === null ? [] : [endTime - startTime];
    });
    let expected = durations.length ? median(durations) : null;
    if (end === 'command_epoch_ms') {
      expected = 0;
    }
    const delta = elapsed === null || expected === null ? null : elapsed - expected;
    const color = deviationColor(delta);

    const columns = [
      name.padEnd(15),
      style(timestamp(actualTime).padEnd(24), color, output),
      style(milliseconds(elapsed).padStart(11), color, output),
      milliseconds(expected).padStart(12),
      style(milliseconds(delta, true).padStart(10), color, output),
    ];
    console.log('  ' + columns.join(' '));
  }

  const expectedDispatch =
    baseline.length ? median(baseline.map(value => value.dispatch_ms)) : null;
  const dispatchError = expectedDispatch === null ? null : sample.dispatch_ms - expectedDispatch;
  const dispatchText = milliseconds(sample.dispatch_ms) + ' ms';
  const dispatch = style(dispatchText, deviationColor(dispatchError), output);

  console.log();
  console.log(`  RPC → send  ${dispatch}`);
  console.log(`  Expected    ${style(milliseconds(expectedDispatch), ANSI.blue, output)} ms`);
}

/**
 * @param {CalibrationSample[]} samples
 * @param {number} offset
 * @param {OutputOptions} output
 */
function reportCalibration(samples, offset, output) {
  const durations = samples.map(sample => -sample.render_offset_ms);
  const waitingTimes = samples.map(sample => sample.waiting_ms);
  const dispatchTimes = samples.map(sample => sample.dispatch_ms);
  const slowestWait = Math.max(...waitingTimes);
  const slowestIndex = samples.findIndex(sample => sample.waiting_ms === slowestWait);
  const withoutSlowest = samples.filter((_, index) => index !== slowestIndex);

  const summary = {
    label: 'calibration-summary',
    sample_count: samples.length,
    offset_ms: offset,
    render_min_ms: Math.min(...durations),
    render_median_ms: -offset,
    render_max_ms: Math.max(...durations),
    faster_side_spread_ms: -offset - Math.min(...durations),
    waiting_min_ms: Math.min(...waitingTimes),
    waiting_median_ms: median(waitingTimes),
    waiting_max_ms: slowestWait,
    dispatch_min_ms: Math.min(...dispatchTimes),
    dispatch_median_ms: median(dispatchTimes),
    dispatch_max_ms: Math.max(...dispatchTimes),
    offset_shift_without_slowest_wait_ms:
      median(withoutSlowest.map(sample => sample.render_offset_ms)) - offset,
  };

  if (output.json) {
    console.log(JSON.stringify(summary));
    return;
  }

  console.log(`\n${style('Calibration result', ANSI.bold, output)}`);
  const header = [
    'Metric'.padEnd(22),
    'Min ms'.padStart(12),
    'Median ms'.padStart(12),
    'Max ms'.padStart(12),
  ];
  console.log(style('  ' + header.join(' '), ANSI.bold, output));

  /** @type {[string, number, number, number][]} */
  const ranges = [
    ['RPC → send', summary.dispatch_min_ms, summary.dispatch_median_ms, summary.dispatch_max_ms],
    ['Waiting', summary.waiting_min_ms, summary.waiting_median_ms, summary.waiting_max_ms],
    ['Command → render', summary.render_min_ms, summary.render_median_ms, summary.render_max_ms],
  ];

  for (const [label, min, median, max] of ranges) {
    const columns =
      [min, median, max].map(value => style(milliseconds(value).padStart(12), ANSI.blue, output));
    console.log(`  ${label.padEnd(22)} ${columns.join(' ')}`);
  }
  console.log();

  /** @type {[string, number, boolean][]} */
  const values = [
    ['Offset', offset, true],
    ['Median − fastest', summary.faster_side_spread_ms, false],
    ['Slowest-wait influence', summary.offset_shift_without_slowest_wait_ms, true],
  ];

  for (const [label, value, signed] of values) {
    const cell = style(milliseconds(value, signed).padStart(12), ANSI.blue, output);
    console.log(`  ${label.padEnd(22)} ${cell} ms`);
  }
}

/**
 * @param {Measurement} sample
 * @param {number} targetMs
 * @param {number} correctionMs
 * @param {number} offset
 * @param {OutputOptions} output
 */
function reportResult(sample, targetMs, correctionMs, offset, output) {
  const actual = sample.server_render_epoch_ms;
  const targetError = actual === null ? null : actual - targetMs;
  const expectedError = actual === null ? null : actual - (targetMs + correctionMs);
  const duration = sample.render_offset_ms === null ? null : -sample.render_offset_ms;

  const result = {
    label: 'timing-result',
    target_epoch_ms: targetMs,
    expected_render_epoch_ms: targetMs + correctionMs,
    actual_render_epoch_ms: actual,
    render_vs_target_ms: targetError,
    render_vs_expected_ms: expectedError,
    estimated_admission_epoch_ms: actual === null ? null : actual - correctionMs,
    scheduling_late_ms: sample.scheduling_late_ms,
    calibrated_command_to_render_ms: -offset,
    actual_command_to_render_ms: duration,
    duration_error_ms: duration === null ? null : duration + offset,
    correction_ms: correctionMs,
    connection_reused: sample.connection_reused,
    status: sample.status,
    cached: sample.cached,
  };

  if (output.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`\n${style('Final timing result', ANSI.bold, output)}`);
  const timeHeader = [
    'Stage'.padEnd(20),
    'Expected (UTC)'.padEnd(24),
    'Actual (UTC)'.padEnd(24),
    'Δ ms'.padStart(10),
  ];
  console.log(style('  ' + timeHeader.join(' '), ANSI.bold, output));

  /** @type {[string, number, number|null][]} */
  const events = [
    ['Admission (est.)', targetMs, result.estimated_admission_epoch_ms],
    ['Server render', result.expected_render_epoch_ms, actual],
  ];

  for (const [label, expectedTime, actualTime] of events) {
    const actualColor = actualTime === null ? ANSI.yellow : ANSI.blue;
    const errorColor = deviationColor(expectedError);
    const columns = [
      label.padEnd(20),
      style(timestamp(expectedTime).padEnd(24), ANSI.blue, output),
      style(timestamp(actualTime).padEnd(24), actualColor, output),
      style(milliseconds(expectedError, true).padStart(10), errorColor, output),
    ];
    console.log('  ' + columns.join(' '));
  }

  console.log();
  const metricHeader = [
    'Metric'.padEnd(22),
    'Actual ms'.padStart(12),
    'Expected ms'.padStart(12),
    'Δ ms'.padStart(10),
  ];
  console.log(style('  ' + metricHeader.join(' '), ANSI.bold, output));

  /** @type {[string, number|null, number|null][]} */
  const metrics = [
    ['Command → render', duration, -offset],
    ['Scheduler error', sample.scheduling_late_ms, 0],
    ['Correction', correctionMs, null],
  ];

  for (const [label, value, expectedValue] of metrics) {
    const delta = value === null || expectedValue === null ? null : value - expectedValue;
    const color = deviationColor(delta);
    const columns = [
      label.padEnd(22),
      style(milliseconds(value).padStart(12), ANSI.blue, output),
      style(milliseconds(expectedValue).padStart(12), ANSI.blue, output),
      style(milliseconds(delta, true).padStart(10), color, output),
    ];
    console.log('  ' + columns.join(' '));
  }
}

/**
 * @param {CDP} cdp
 * @param {string} url
 * @param {OutputOptions}
 *     output
 * @returns {Promise<CalibrationSample[]>}
 */
async function checkTiming(cdp, url, output) {
  const warmup = await reload(cdp, url, 'initial-warmup');

  reportSample(warmup, [], output);
  validateSample(warmup);

  /** @type {CalibrationSample[]} */
  const samples = [];

  for (let attempt = 0; attempt < MAX_CALIBRATION_ATTEMPTS && samples.length < SAMPLES; ++attempt) {
    const sample = await reload(cdp, url, 'idle-check', now() + IDLE_MS);
    reportSample(sample, samples, output);
    validateSample(sample);
    if (sample.connection_reused !== true) {
      console.error(`Skipping sample from a new connection - ${samples.length}/${SAMPLES} warm samples collected.`);
      continue;
    }
    samples.push(sample);
  }

  if (samples.length < SAMPLES) {
    throw new Error(`Only ${samples.length}/${SAMPLES} warm samples after ${MAX_CALIBRATION_ATTEMPTS} attempts`);
  }

  const waitMs = median(samples.map(sample => sample.waiting_ms));
  if (Math.abs(waitMs - EXPECTED_WAIT_MS) > WAIT_TOLERANCE_MS) {
    console.error(`\nWaiting time of ${waitMs}ms differs from ${EXPECTED_WAIT_MS} ± ${WAIT_TOLERANCE_MS} ms`);
  }

  return samples;
}

/**
 * Read command-line options, printing help when requested.
 * @returns {Options|null}
 */
function readOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'correction-ms': { type: 'string' },
      port: { type: 'string', default: '9222' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return null;
  }

  if (positionals.length !== (values.check ? 1 : 2)) {
    throw new Error('Supply URL and either --check or a timezone-qualified target');
  }

  if (values.check && values['correction-ms'] !== undefined) {
    throw new Error('--correction-ms cannot be used with --check');
  }

  const correctionText = values['correction-ms'] ?? '0';
  const correctionMs = Number(correctionText);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(correctionText) || !Number.isFinite(correctionMs)) {
    throw new Error('--correction-ms must be a finite number of milliseconds');
  }

  const url = queueUrl(positionals[0]);
  const forceColor = Boolean(process.env.FORCE_COLOR) && process.env.FORCE_COLOR !== '0';
  const output = {
    json: values.json,
    color:
      !values.json && !('NO_COLOR' in process.env) && (Boolean(process.stdout.isTTY) || forceColor),
  };

  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
    throw new Error('Port must be an integer from 1 through 65535');
  }

  let targetMs = null;
  if (!values.check) {
    const target = positionals[1];
    const targetPattern =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
    if (!targetPattern.test(target)) {
      throw new Error('Target must be an ISO timestamp with seconds and timezone');
    }

    targetMs = Date.parse(target);
    const [year, month, day] = target.slice(0, 10).split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (!Number.isFinite(targetMs) || month < 1 || month > 12 || day < 1 || day > daysInMonth) {
      throw new Error('Invalid target timestamp');
    }

    if (targetMs - ((MAX_CALIBRATION_ATTEMPTS * IDLE_MS) + SALE_WARMUP_MS) <= now()) {
      throw new Error('Target is too soon or has passed');
    }
  }

  return { url, port: values.port, targetMs, correctionMs, output };
}

/**
 * @param {string} url
 * @param {string} port
 * @returns {Promise<CDP>}
 */
async function connectToShop(url, port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Chrome discovery returned HTTP ${response.status}`);
  }

  const tabs = await response.json();
  const matches = tabs.filter(
    tab => tab.type === 'page' && /^https?:/.test(tab.url) && queueUrl(tab.url) === url);
  if (matches.length !== 1) {
    throw new Error(`Expected one Chrome tab matching ${url}; found ${matches.length}`);
  }
  return CDP.connect(matches[0].webSocketDebuggerUrl);
}

const HELP = `Usage: node snipe.mjs URL --check [--port 9222]
       node snipe.mjs URL ISO_TARGET [--correction-ms 50] [--port 9222]

Pretix shop sniper

Options:
  --check          Only check the timing of a single reload, without a target
  --correction-ms  Milliseconds to add to the measured offset (default: 0)
  --port           Chrome remote debugging port (default: 9222)
  --json           Output JSON instead of human-readable text
  -h, --help       Show this help message
`;

/**
 * @typedef {object} RequestSent
 * @property {string} requestId
 * @property {string} frameId
 * @property {string} type
 * @property {number} timestamp
 * @property {number} wallTime
 * @property {{url: string, method: string}} request
 */

/**
 * @typedef {object} ResourceTiming
 * @property {number} requestTime
 * @property {number} sendStart
 * @property {number} sendEnd
 * @property {number} receiveHeadersStart
 * @property {number} receiveHeadersEnd
 */

/**
 * @typedef {object} Response
 * @property {Record<string, string>} headers
 * @property {ResourceTiming} [timing]
 * @property {number} status
 * @property {boolean} connectionReused
 * @property {number} connectionId
 * @property {string} protocol
 * @property {boolean} [fromDiskCache]
 * @property {boolean} [fromServiceWorker]
 * @property {boolean} [fromPrefetchCache]
 */

/**
 * @typedef {object} Measurement
 * @property {number} deadline_epoch_ms
 * @property {number} command_epoch_ms
 * @property {number} request_epoch_ms
 * @property {number} send_epoch_ms
 * @property {number} send_end_epoch_ms
 * @property {number} first_byte_epoch_ms
 * @property {number} headers_epoch_ms
 * @property {number|null} finished_epoch_ms
 * @property {number} dispatch_ms
 * @property {number} scheduling_late_ms
 * @property {number} waiting_ms
 * @property {number|null} receiving_ms
 * @property {boolean} connection_reused
 * @property {number} connection_id
 * @property {string} protocol
 * @property {number} status
 * @property {boolean} cached
 * @property {number|null} server_render_epoch_ms
 * @property {number|null} render_offset_ms
 */

/**
 * @typedef {object} OutputOptions
 * @property {boolean} json
 * @property {boolean} color
 */

/**
 * @typedef {object} Options
 * @property {string} url
 * @property {string} port
 * @property {number|null} targetMs
 * @property {number} correctionMs
 * @property {OutputOptions} output
 */

/**
 * @typedef {Measurement & {server_render_epoch_ms: number, render_offset_ms: number}}
 * CalibrationSample
 * @typedef {'deadline_epoch_ms'|'command_epoch_ms'|'request_epoch_ms'|'send_epoch_ms'|
 *   'send_end_epoch_ms'|'first_byte_epoch_ms'|'headers_epoch_ms'|'finished_epoch_ms'|
 *   'server_render_epoch_ms'} TimestampKey
 */

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
