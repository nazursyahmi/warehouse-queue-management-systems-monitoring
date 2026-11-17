const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(globals = {}) {
  const context = { ...globals };
  vm.createContext(context);
  for (const file of ['demo-data.js', 'dashboard.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/js', file), 'utf8'), context);
  }
  return context;
}

// A small document/timer adapter exercises our event handlers. It does not
// replace the separate Chrome rendering and offline checks.
function dashboardUi(reducedMotion = false) {
  const elements = new Map();
  const documentEvents = {};
  const timers = new Map();
  const frames = new Map();
  let nextId = 0;
  function addIds(html) {
    for (const match of html.matchAll(/id="([^"]+)"/g)) {
      const id = match[1];
      if (elements.has(id)) continue;
      const classes = new Set();
      let markup = '';
      elements.set(id, {
        value: id === 'simulation-interval' ? '1000' : '', textContent: '',
        style: {}, hidden: id === 'error', disabled: false, events: {}, attributes: {},
        classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
        get innerHTML() { return markup; },
        set innerHTML(value) { markup = value; addIds(value); },
        setAttribute(key, value) { this.attributes[key] = value; },
        addEventListener(name, callback) { this.events[name] = callback; },
        matches() { return ['search', 'operation', 'status', 'simulation-interval'].includes(id); }
      });
    }
  }
  addIds(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'));
  const doc = {
    hidden: false, activeElement: null, querySelector: () => null,
    getElementById: id => elements.get(id) || null,
    addEventListener(name, callback) { documentEvents[name] = callback; }
  };
  const media = { matches: reducedMotion, addEventListener() {} };
  const context = load({
    document: doc,
    window: { matchMedia: () => media, addEventListener() {} },
    setTimeout(fn) { timers.set(++nextId, fn); return nextId; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  documentEvents.DOMContentLoaded();
  return {
    doc, context, frames, media, elements,
    element: id => elements.get(id),
    event(id, name) { elements.get(id).events[name](); },
    tick() {
      const entry = timers.entries().next().value;
      assert.ok(entry, 'An automatic simulation step must be scheduled');
      timers.delete(entry[0]);
      entry[1]();
    },
    hasTimer: () => timers.size > 0,
    finishFrames() {
      for (const timestamp of [0, 425, 850]) {
        const pending = Array.from(frames.entries());
        frames.clear();
        pending.forEach(([, callback]) => callback(timestamp));
      }
    }
  };
}

test('dashboard auto-starts and keeps filters, refresh, pause and reset connected to its state', () => {
  const ui = dashboardUi();
  assert.equal(ui.element('error').hidden, true);
  assert.equal(ui.element('simulation-toggle').textContent, 'Pause simulation');
  assert.equal(ui.element('metric-0').textContent, '15');
  ui.tick();
  assert.match(ui.element('updated').textContent, /step 1$/);
  assert.equal(ui.element('metric-6').textContent, '0');
  ui.element('search').value = 'IN-006';
  ui.element('operation').value = 'Inbound';
  ui.event('search', 'input');
  assert.equal(ui.element('result-count').textContent, '1 of 15 trucks');
  for (let index = 0; index < 30; index++) { ui.tick(); ui.finishFrames(); }
  assert.equal(ui.element('search').value, 'IN-006');
  assert.equal(ui.element('operation').value, 'Inbound');
  assert.match(ui.element('queue-body').innerHTML, /BTH 4498/);
  const clock = ui.element('snapshot-time').textContent;
  ui.event('refresh', 'click');
  assert.equal(ui.element('snapshot-time').textContent, clock);
  assert.equal(ui.element('search').value, 'IN-006');
  ui.event('simulation-toggle', 'click');
  assert.equal(ui.hasTimer(), false);
  assert.equal(ui.element('simulation-toggle').textContent, 'Start simulation');
  ui.event('simulation-toggle', 'click');
  ui.tick();
  assert.notEqual(ui.element('snapshot-time').textContent, clock);
  ui.event('simulation-reset', 'click');
  assert.match(ui.element('updated').textContent, /step 0$/);
  assert.equal(ui.element('metric-0').textContent, '15');
  assert.equal(ui.element('metric-6').textContent, '1');
  assert.equal(ui.element('search').value, 'IN-006');
  assert.equal(ui.hasTimer(), true);
  assert.equal(ui.element('error').hidden, true);
});

test('hidden tabs and editing controls suspend time, and reduced motion avoids animation frames', () => {
  const ui = dashboardUi(true);
  const start = ui.element('snapshot-time').textContent;
  ui.doc.hidden = true;
  ui.tick();
  assert.equal(ui.element('snapshot-time').textContent, start);
  ui.doc.hidden = false;
  ui.doc.activeElement = ui.element('search');
  ui.tick();
  assert.equal(ui.element('snapshot-time').textContent, start);
  ui.doc.activeElement = null;
  ui.tick();
  assert.notEqual(ui.element('snapshot-time').textContent, start);
  for (let index = 0; index < 20; index++) ui.tick();
  assert.equal(ui.frames.size, 0);
  assert.equal(ui.element('error').hidden, true);
});

test('volume bars retain their elements and smoothly reach source proportions', () => {
  const ui = dashboardUi();
  const inbound = ui.element('inbound-bar');
  const initialWidth = parseFloat(inbound.style.width);
  ui.tick(); ui.tick(); ui.tick();
  assert.equal(ui.element('inbound-bar'), inbound);
  assert.ok(ui.frames.size > 0);
  ui.finishFrames();
  assert.notEqual(parseFloat(inbound.style.width), initialWidth);
  assert.equal(parseFloat(inbound.style.width), 9 / 16 * 100);
  ui.event('simulation-toggle', 'click');
  assert.equal(ui.frames.size, 0);
});

test('simulation progresses a truck through every status and releases its bay only on departure', () => {
  const { WqmsSimulation: engine, wqmsDemo: demo } = load();
  assert.equal(typeof engine?.create, 'function', 'Simulation engine must exist');
  const state = engine.create(demo);
  const truck = state.operations.find(item => item.id === 'OUT-005');
  engine.step(state);
  assert.equal(truck.status, 'Called');
  const bay = state.bays.find(item => item.id === truck.bayId);
  assert.equal(bay.operationId, truck.id);
  engine.step(state);
  assert.equal(truck.status, 'At Bay');
  assert.equal(truck.processingStartedAt, state.referenceAt);
  engine.step(state);
  assert.equal(truck.status, 'Loading / Unloading');
  for (let index = 0; index < 12 && truck.status !== 'Completed'; index++) engine.step(state);
  assert.equal(truck.status, 'Completed');
  assert.equal(truck.departedAt, null);
  assert.equal(bay.operationId, truck.id);
  engine.step(state);
  assert.equal(truck.departedAt, state.referenceAt);
  assert.notEqual(bay.operationId, truck.id);
  assert.ok(Date.parse(truck.arrivalAt) <= Date.parse(truck.processingStartedAt));
  assert.ok(Date.parse(truck.processingStartedAt) < Date.parse(truck.completedAt));
  assert.ok(Date.parse(truck.completedAt) < Date.parse(truck.departedAt));
});

test('controller pauses, resumes, changes interval and resets without duplicate timers', () => {
  let callback;
  let delay;
  let timers = 0;
  let suspended = false;
  const { WqmsSimulation: engine, wqmsDemo: demo } = load({
    setTimeout(fn, milliseconds) { callback = fn; delay = milliseconds; timers++; return 1; },
    clearTimeout() { callback = null; timers--; }
  });
  assert.equal(typeof engine.controller, 'function', 'Timer controller must exist');
  const simulation = engine.controller(demo, { shouldSuspend: () => suspended });
  function tick() { const next = callback; callback = null; timers--; next(); }
  simulation.start();
  simulation.start();
  assert.equal(timers, 1);
  assert.equal(delay, 1000);
  tick();
  assert.equal(simulation.getState().referenceAt, '2026-11-17T04:05:00.000Z');
  simulation.pause();
  assert.equal(callback, null);
  assert.equal(timers, 0);
  assert.equal(simulation.isRunning(), false);
  simulation.start();
  tick();
  assert.equal(simulation.getState().referenceAt, '2026-11-17T04:10:00.000Z');
  suspended = true;
  tick();
  assert.equal(simulation.getState().referenceAt, '2026-11-17T04:10:00.000Z');
  suspended = false;
  assert.equal(simulation.setIntervalMs(5000), true);
  assert.equal(delay, 5000);
  assert.equal(timers, 1);
  assert.equal(simulation.setIntervalMs(0), false);
  assert.equal(simulation.setIntervalMs(NaN), false);
  tick();
  assert.equal(simulation.getState().simulation.step, 3);
  simulation.reset();
  assert.equal(JSON.stringify(simulation.getState().operations), JSON.stringify(demo.operations));
  assert.equal(simulation.getState().referenceAt, demo.referenceAt);
  assert.equal(simulation.isRunning(), true);
  assert.equal(timers, 1);
  assert.equal(delay, 5000);
  simulation.pause();
  simulation.reset();
  assert.equal(simulation.isRunning(), true);
  assert.equal(timers, 1);
  simulation.pause();
});

test('reset creates independent original records without mutating the demonstration fixture', () => {
  const { WqmsSimulation: engine, wqmsDemo: demo } = load();
  const original = JSON.stringify(demo);
  const state = engine.create(demo);
  for (let index = 0; index < 20; index++) engine.step(state);
  const reset = engine.create(demo);
  assert.equal(JSON.stringify(demo), original);
  assert.equal(JSON.stringify(reset.operations), JSON.stringify(demo.operations));
  assert.equal(JSON.stringify(reset.bays), JSON.stringify(demo.bays));
  assert.equal(reset.referenceAt, demo.referenceAt);
});

test('the initial called truck already reserves its bay and cannot inflate available bay counts', () => {
  const { WqmsSimulation: engine, Wqms: dashboard, wqmsDemo: demo } = load();
  const state = engine.create(demo);
  const called = state.operations.find(truck => truck.status === 'Called');
  const bay = state.bays.find(item => item.id === called.bayId);
  assert.equal(bay.operationId, called.id);
  assert.equal(bay.status, 'Occupied');
  assert.equal(dashboard.summarize(state).available, 1);
});

test('waiting and turnaround use the simulation clock with missing times excluded', () => {
  const { WqmsSimulation: engine, Wqms: dashboard, wqmsDemo: demo } = load();
  const state = engine.create(demo);
  assert.equal(dashboard.summarize(state).averageWaiting, 425 / 14);
  assert.equal(dashboard.summarize(state).averageTurnaround, 83);
  engine.step(state);
  assert.equal(dashboard.summarize(state).averageWaiting, 455 / 14);
  assert.equal(dashboard.summarize(state).averageTurnaround, 83);
  engine.step(state);
  assert.equal(dashboard.summarize(state).averageTurnaround, 660 / 7);
  assert.equal(dashboard.waitingMinutes({ status: 'Completed', arrivalAt: state.referenceAt }, state.referenceAt), null);
  assert.equal(dashboard.minutesBetween(null, state.referenceAt), null);
  assert.equal(dashboard.minutesBetween('invalid', state.referenceAt), null);
  assert.equal(dashboard.minutesBetween(state.referenceAt, demo.referenceAt), null);
});

test('long sessions retain consistent timestamps, bounded history, exclusive bays and correct summaries', () => {
  const { WqmsSimulation: engine, Wqms: dashboard, wqmsDemo: demo } = load();
  const state = engine.create(demo);
  let arrivals = 0;
  let departures = 0;
  const allowed = {
    Waiting: ['Waiting', 'Called'], Called: ['Called', 'At Bay'],
    'At Bay': ['At Bay', 'Loading / Unloading'],
    'Loading / Unloading': ['Loading / Unloading', 'Completed'],
    Completed: ['Completed'], Cancelled: ['Cancelled']
  };
  for (let index = 0; index < 10000; index++) {
    const previous = new Map(state.operations.map(truck => [truck.id, { ...truck }]));
    engine.step(state);
    assert.ok(state.operations.length <= 200);
    assert.equal(new Set(state.operations.map(truck => truck.id)).size, state.operations.length);
    const assigned = new Set();
    for (const bay of state.bays) {
      if (!bay.operationId) continue;
      assert.equal(bay.status, 'Occupied');
      assert.ok(!assigned.has(bay.operationId));
      assigned.add(bay.operationId);
      const truck = state.operations.find(item => item.id === bay.operationId);
      assert.equal(truck.bayId, bay.id);
      assert.equal(truck.departedAt, null);
    }
    for (const truck of state.operations) {
      const before = previous.get(truck.id);
      if (!before) { arrivals++; assert.equal(truck.status, 'Waiting'); }
      else assert.ok(allowed[before.status].includes(truck.status), before.status + ' -> ' + truck.status);
      if (truck.departedAt && !before?.departedAt) departures++;
      if (['Called', 'At Bay', 'Loading / Unloading'].includes(truck.status) || (truck.status === 'Completed' && !truck.departedAt)) {
        assert.equal(state.bays.find(bay => bay.id === truck.bayId).operationId, truck.id);
      }
      if (truck.departedAt) assert.ok(Date.parse(truck.departedAt) <= Date.parse(state.referenceAt));
      const wait = dashboard.waitingMinutes(truck, state.referenceAt);
      assert.ok(wait === null || wait >= 0);
    }
    const today = state.operations.filter(truck => new Date(Date.parse(truck.arrivalAt) + 28800000).toISOString().slice(0, 10) === new Date(Date.parse(state.referenceAt) + 28800000).toISOString().slice(0, 10));
    const summary = dashboard.summarize(state);
    assert.equal(summary.total, today.length);
    assert.equal(summary.inbound + summary.outbound, summary.total);
    assert.equal(summary.completed, today.filter(truck => truck.status === 'Completed').length);
    assert.equal(summary.waiting, state.operations.filter(truck => truck.status === 'Waiting').length);
    assert.equal(summary.processing, state.operations.filter(truck => ['At Bay', 'Loading / Unloading'].includes(truck.status)).length);
    assert.equal(summary.available, state.bays.filter(bay => bay.status === 'Available' && !bay.operationId).length);
    assert.ok(dashboard.filterOperations(state.operations, '', 'Inbound', 'Waiting').every(truck => truck.operation === 'Inbound' && truck.status === 'Waiting'));
  }
  assert.ok(arrivals > 1000);
  assert.ok(departures > 1000);
});
