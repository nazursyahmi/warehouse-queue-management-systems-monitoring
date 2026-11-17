/* Stable fictional records. No warehouse system is connected. */
var wqmsDemo = (function () {
  function time(clock) {
    return clock ? '2026-11-17T' + clock + ':00+08:00' : null;
  }

  function truck(queue, registration, operation, status, arrival, start, completed, departed, bay) {
    return {
      id: queue, queueNumber: queue, registration: registration,
      operation: operation, status: status, arrivalAt: time(arrival),
      processingStartedAt: time(start), completedAt: time(completed),
      departedAt: time(departed), bayId: bay || null
    };
  }

  return {
    source: 'DEMO DATA',
    referenceAt: time('12:00'),
    operations: [
      truck('IN-001', 'BQR 4821', 'Inbound', 'Completed', '07:00', '07:20', '08:05', '08:15', 'B01'),
      truck('OUT-001', 'VKL 7392', 'Outbound', 'Completed', '07:15', '07:45', '08:30', '08:45', 'B03'),
      truck('IN-002', 'JTU 9054', 'Inbound', 'Completed', '08:00', '08:15', '09:00', '09:10', 'B02'),
      truck('OUT-002', 'PNA 6218', 'Outbound', 'Completed', '08:30', '09:00', '09:45', '10:00', 'B04'),
      truck('IN-003', 'WXY 3186', 'Inbound', 'Completed', '09:00', '09:25', '10:15', '10:30', 'B01'),
      truck('OUT-003', 'BSP 2567', 'Outbound', 'Loading / Unloading', '10:00', '10:35', null, null, 'B03'),
      truck('IN-004', 'NDF 8743', 'Inbound', 'Loading / Unloading', '10:15', '10:40', null, null, 'B01'),
      truck('OUT-004', 'VCD 1942', 'Outbound', 'At Bay', '10:45', '11:30', null, null, 'B04'),
      truck('IN-005', 'JWE 5620', 'Inbound', 'Called', '11:00', null, null, null, 'B02'),
      truck('OUT-005', 'PKR 7031', 'Outbound', 'Waiting', '11:10'),
      truck('IN-006', 'BTH 4498', 'Inbound', 'Waiting', '11:20'),
      truck('OUT-006', 'WVB 6825', 'Outbound', 'Waiting', '11:35'),
      truck('IN-007', 'VAM 9270', 'Inbound', 'Waiting', '11:45'),
      truck('OUT-007', 'JQS 3109', 'Outbound', 'Waiting', '11:50'),
      truck('IN-008', 'PBL 1584', 'Inbound', 'Cancelled', '09:30')
    ],
    bays: [
      { id: 'B01', name: 'Bay 01', operation: 'Inbound', status: 'Occupied', operationId: 'IN-004' },
      { id: 'B02', name: 'Bay 02', operation: 'Inbound', status: 'Occupied', operationId: 'IN-005' },
      { id: 'B03', name: 'Bay 03', operation: 'Outbound', status: 'Occupied', operationId: 'OUT-003' },
      { id: 'B04', name: 'Bay 04', operation: 'Outbound', status: 'Occupied', operationId: 'OUT-004' },
      { id: 'B05', name: 'Bay 05', operation: 'Shared', status: 'Available', operationId: null },
      { id: 'B06', name: 'Bay 06', operation: 'Shared', status: 'Unavailable', operationId: null }
    ]
  };
}());

/* One shared, accelerated demo clock. No timers or browser APIs in this engine. */
var WqmsSimulation = (function () {
  var minutesPerStep = 5;
  var maxRecords = 200;
  var arrivalEverySteps = 3;

  function create(original) {
    var state = JSON.parse(JSON.stringify(original));
    state.simulation = { step: 0, nextSequence: 9 };
    return state;
  }

  function step(state) {
    state.simulation.step++;
    state.referenceAt = new Date(Date.parse(state.referenceAt) + minutesPerStep * 60000).toISOString();
    var now = state.referenceAt;

    state.operations.forEach(function (truck) {
      var bay = state.bays.find(function (item) { return item.id === truck.bayId; });
      if (truck.status === 'Called' && bay && bay.status !== 'Unavailable' && (!bay.operationId || bay.operationId === truck.id)) {
        bay.status = 'Occupied';
        bay.operationId = truck.id;
        truck.status = 'At Bay';
        truck.processingStartedAt = now;
      } else if (truck.status === 'At Bay') {
        truck.status = 'Loading / Unloading';
        truck.loadingStartedAt = now;
      } else if (truck.status === 'Loading / Unloading') {
        var loadingStartedAt = truck.loadingStartedAt || truck.processingStartedAt;
        var processingMinutes = truck.processingMinutes || 30;
        if (Date.parse(now) - Date.parse(loadingStartedAt) >= processingMinutes * 60000) {
          truck.status = 'Completed';
          truck.completedAt = now;
        }
      } else if (truck.status === 'Completed' && !truck.departedAt) {
        truck.departedAt = now;
        if (bay && bay.operationId === truck.id) {
          bay.operationId = null;
          bay.status = 'Available';
        }
      }
    });

    // Reserve bays in arrival order, before adding new arrivals. Called trucks own
    // their bay until departure, so another truck can never receive the same bay.
    var waiting = state.operations.filter(function (truck) { return truck.status === 'Waiting'; });
    waiting.sort(function (first, second) { return Date.parse(first.arrivalAt) - Date.parse(second.arrivalAt); });
    state.bays.forEach(function (bay) {
      if (bay.status !== 'Available' || bay.operationId || !waiting.length) return;
      var waitingIndex = waiting.findIndex(function (truck) {
        return !bay.operation || bay.operation === 'Shared' || bay.operation === truck.operation;
      });
      if (waitingIndex === -1) return;
      var truck = waiting.splice(waitingIndex, 1)[0];
      truck.status = 'Called';
      truck.calledAt = now;
      truck.bayId = bay.id;
      bay.status = 'Occupied';
      bay.operationId = truck.id;
    });

    if (state.simulation.step % arrivalEverySteps === 0) {
      // Drop only terminal history, never active trucks or bay assignments.
      while (state.operations.length >= maxRecords) {
        var terminalIndex = state.operations.findIndex(function (truck) {
          return Boolean(truck.departedAt) || truck.status === 'Cancelled';
        });
        if (terminalIndex === -1) break;
        state.operations.splice(terminalIndex, 1);
      }
      if (state.operations.length < maxRecords) {
        var sequence = state.simulation.nextSequence++;
        var inbound = sequence % 2 === 1;
        var queue = (inbound ? 'IN-' : 'OUT-') + String(sequence).padStart(3, '0');
        state.operations.push({
          id: queue, queueNumber: queue, registration: 'BDX ' + String(1000 + sequence),
          operation: inbound ? 'Inbound' : 'Outbound', status: 'Waiting',
          arrivalAt: now, processingStartedAt: null, completedAt: null,
          departedAt: null, bayId: null, processingMinutes: 20 + sequence % 4 * 5
        });
      }
    }
    return state;
  }

  function controller(original, options) {
    options = options || {};
    var state = create(original);
    var running = false;
    var timer = null;
    var intervalMs = 1000;

    function notify(automatic) {
      if (options.onChange) options.onChange(state, automatic);
    }

    function cancelTimer() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }

    function schedule() {
      if (!running) return;
      timer = setTimeout(function () {
        timer = null;
        try {
          if (!options.shouldSuspend || !options.shouldSuspend()) {
            step(state);
            notify(true);
          }
        } catch (error) {
          running = false;
          if (options.onError) options.onError(error);
        }
        schedule();
      }, intervalMs);
    }

    return {
      getState: function () { return state; },
      isRunning: function () { return running; },
      start: function () {
        if (running) return;
        running = true;
        notify(false);
        schedule();
      },
      pause: function () {
        running = false;
        cancelTimer();
        notify(false);
      },
      reset: function () {
        cancelTimer();
        state = create(original);
        running = true;
        notify(false);
        schedule();
      },
      setIntervalMs: function (value) {
        if (!Number.isFinite(value) || value < 1000 || value > 30000) return false;
        intervalMs = value;
        cancelTimer();
        schedule();
        return true;
      }
    };
  }

  return { create: create, step: step, controller: controller };
}());
