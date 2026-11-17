/* Calculations use exact source timestamps, never animated display values. */
var Wqms = (function () {
  function minutesBetween(start, end) {
    if (!start || !end) return null;
    var difference = Date.parse(end) - Date.parse(start);
    return Number.isFinite(difference) && difference >= 0 ? difference / 60000 : null;
  }

  function waitingMinutes(truck, referenceAt) {
    if (truck.status === 'Cancelled') return null;
    if (truck.processingStartedAt) return minutesBetween(truck.arrivalAt, truck.processingStartedAt);
    if (truck.status === 'Waiting' || truck.status === 'Called') return minutesBetween(truck.arrivalAt, referenceAt);
    return null;
  }

  function malaysiaDate(timestamp) {
    var value = Date.parse(timestamp);
    return Number.isFinite(value) ? new Date(value + 8 * 3600000).toISOString().slice(0, 10) : null;
  }

  function mean(values) {
    var valid = values.filter(function (value) { return value !== null; });
    if (!valid.length) return null;
    return valid.reduce(function (total, value) { return total + value; }, 0) / valid.length;
  }

  function summarize(snapshot) {
    var today = snapshot.operations.filter(function (truck) {
      return malaysiaDate(truck.arrivalAt) === malaysiaDate(snapshot.referenceAt);
    });
    return {
      total: today.length,
      inbound: today.filter(function (truck) { return truck.operation === 'Inbound'; }).length,
      outbound: today.filter(function (truck) { return truck.operation === 'Outbound'; }).length,
      waiting: snapshot.operations.filter(function (truck) { return truck.status === 'Waiting'; }).length,
      processing: snapshot.operations.filter(function (truck) { return truck.status === 'At Bay' || truck.status === 'Loading / Unloading'; }).length,
      completed: today.filter(function (truck) { return truck.status === 'Completed'; }).length,
      available: snapshot.bays.filter(function (bay) { return bay.status === 'Available'; }).length,
      averageWaiting: mean(today.map(function (truck) { return waitingMinutes(truck, snapshot.referenceAt); })),
      averageTurnaround: mean(today.filter(function (truck) { return truck.status === 'Completed'; }).map(function (truck) { return minutesBetween(truck.arrivalAt, truck.departedAt); }))
    };
  }

  function filterOperations(operations, search, operation, status) {
    var query = search.trim().toLowerCase().replace(/\s+/g, '');
    return operations.filter(function (truck) {
      var matchesSearch = (truck.queueNumber + ' ' + truck.registration).toLowerCase().replace(/\s+/g, '').includes(query);
      return matchesSearch && (!operation || truck.operation === operation) && (!status || truck.status === status);
    });
  }

  return { minutesBetween: minutesBetween, waitingMinutes: waitingMinutes, summarize: summarize, filterOperations: filterOperations };
}());

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function () {
    var snapshot;
    var simulation;
    var summaryReady = false;
    var previousTrucks = {};
    var previousBays = {};
    var animationFrames = {};
    var animateUpdates = false;
    var byId = function (id) { return document.getElementById(id); };
    var formatTime = new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false });
    var formatDate = new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric' });
    var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var digitalTwin = typeof WqmsTwin !== 'undefined' ? WqmsTwin.create(byId('digital-twin')) : null;

    function highlight(element) {
      if (!animateUpdates || reducedMotion.matches) return;
      element.classList.remove('is-updated');
      // Restart a short, non-flashing highlight only on changed values.
      void element.offsetWidth;
      element.classList.add('is-updated');
    }

    function updateText(id, value) {
      var element = byId(id);
      value = String(value);
      if (element.textContent === value) return;
      element.textContent = value;
      highlight(element);
    }

    function animateBar(id, target) {
      var element = byId(id);
      if (animationFrames[id]) cancelAnimationFrame(animationFrames[id]);
      var start = parseFloat(element.style.width) || 0;
      if (!animateUpdates || reducedMotion.matches || start === target) {
        element.style.width = target + '%';
        return;
      }
      var startedAt;
      function frame(timestamp) {
        if (startedAt === undefined) startedAt = timestamp;
        var progress = Math.min((timestamp - startedAt) / 850, 1);
        if (reducedMotion.matches) progress = 1;
        element.style.width = (start + (target - start) * (1 - Math.pow(1 - progress, 3))) + '%';
        if (progress < 1) animationFrames[id] = requestAnimationFrame(frame);
        else delete animationFrames[id];
      }
      animationFrames[id] = requestAnimationFrame(frame);
    }

    function stopAnimations() {
      Object.keys(animationFrames).forEach(function (id) { cancelAnimationFrame(animationFrames[id]); });
      animationFrames = {};
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, function (character) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
      });
    }

    function duration(value) {
      return value === null ? '—' : Math.round(value) + ' min';
    }

    function statusClass(status) {
      if (status === 'Loading / Unloading' || status === 'At Bay') return 'processing';
      return status.toLowerCase();
    }

    function renderQueue() {
      var rows = Wqms.filterOperations(snapshot.operations, byId('search').value, byId('operation').value, byId('status').value);
      byId('result-count').textContent = rows.length + ' of ' + snapshot.operations.length + ' trucks';
      byId('queue-body').innerHTML = rows.length ? rows.map(function (truck) {
        var bay = snapshot.bays.find(function (item) { return item.id === truck.bayId; });
        var arrival = Number.isFinite(Date.parse(truck.arrivalAt)) ? formatTime.format(new Date(truck.arrivalAt)) : '—';
        var signature = truck.status + '|' + truck.bayId + '|' + truck.departedAt;
        var changed = animateUpdates && previousTrucks[truck.id] !== signature;
        var departure = truck.departedAt ? '<span class="departure-note">Departed ' + formatTime.format(new Date(truck.departedAt)) + '</span>' : truck.status === 'Completed' ? '<span class="departure-note">Awaiting departure</span>' : '';
        var arrivalDate = Number.isFinite(Date.parse(truck.arrivalAt)) ? '<span class="departure-note">' + formatDate.format(new Date(truck.arrivalAt)) + '</span>' : '';
        return '<tr' + (changed ? ' class="is-updated"' : '') + '><td>' + escapeHtml(truck.queueNumber) + '</td><td>' + escapeHtml(truck.registration) + '</td><td><span class="operation-label">' + escapeHtml(truck.operation) + '</span></td><td>' + arrival + arrivalDate + '</td><td>' + (bay ? escapeHtml(bay.name) : '—') + '</td><td><span class="status status-' + statusClass(truck.status) + '">' + escapeHtml(truck.status) + '</span>' + departure + '</td><td>' + duration(Wqms.waitingMinutes(truck, snapshot.referenceAt)) + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="empty-cell">No trucks match these filters. Try another search or clear filters.</td></tr>';
    }

    function renderSummary() {
      var totals = Wqms.summarize(snapshot);
      var cards = [
        ['Total trucks today', totals.total, 'Arrivals on simulation date', '↔', '#e56a73'],
        ['Inbound trucks', totals.inbound, 'Deliveries to warehouse', '↙', '#a6b9d5'],
        ['Outbound trucks', totals.outbound, 'Dispatch operations', '↗', '#a6b9d5'],
        ['Trucks waiting', totals.waiting, 'Called trucks excluded', '◷', '#f0bf62'],
        ['Being processed', totals.processing, 'At bay or loading / unloading', '▤', '#a8c6f7'],
        ['Completed trucks', totals.completed, 'Operations finished', '✓', '#53d8a1'],
        ['Available bays', totals.available, 'Of ' + snapshot.bays.length + ' loading bays', '▥', '#53d8a1'],
        ['Average waiting', duration(totals.averageWaiting), 'All non-cancelled arrivals', '◴', '#f0bf62']
      ];
      if (!summaryReady) {
        byId('summary').innerHTML = cards.map(function (card, index) {
          return '<article class="metric" style="--accent:' + card[4] + '"><div class="metric-top"><span>' + card[0] + '</span><span class="metric-icon" aria-hidden="true">' + card[3] + '</span></div><div class="metric-value" id="metric-' + index + '"></div><div class="metric-detail">' + card[2] + '</div></article>';
        }).join('');
        byId('operations').innerHTML = '<div class="volume-row"><div class="volume-label"><span>↙ Inbound volume</span><strong id="inbound-volume"></strong></div><div class="volume-track" aria-hidden="true"><div id="inbound-bar" class="volume-fill"></div></div></div><div class="volume-row"><div class="volume-label"><span>↗ Outbound volume</span><strong id="outbound-volume"></strong></div><div class="volume-track" aria-hidden="true"><div id="outbound-bar" class="volume-fill outbound"></div></div></div><div class="report-values"><div><strong id="report-waiting"></strong><span>Average waiting</span></div><div><strong id="report-turnaround"></strong><span>Average turnaround</span></div></div><p class="report-note">Daily figures use arrivals on the simulation date. Turnaround: arrival to departure for completed trucks. Missing times and cancellations are excluded from time averages. Volume includes cancelled arrivals.</p>';
        summaryReady = true;
      }
      cards.forEach(function (card, index) { updateText('metric-' + index, card[1]); });
      updateText('inbound-volume', totals.inbound + ' trucks');
      updateText('outbound-volume', totals.outbound + ' trucks');
      updateText('report-waiting', duration(totals.averageWaiting));
      updateText('report-turnaround', duration(totals.averageTurnaround));
      animateBar('inbound-bar', totals.total ? totals.inbound / totals.total * 100 : 0);
      animateBar('outbound-bar', totals.total ? totals.outbound / totals.total * 100 : 0);
    }

    function renderBays() {
      byId('bay-count').textContent = snapshot.bays.filter(function (bay) { return bay.status === 'Occupied'; }).length + ' occupied or reserved / ' + snapshot.bays.length + ' total';
      byId('bays').innerHTML = snapshot.bays.map(function (bay) {
        var truck = snapshot.operations.find(function (item) { return item.id === bay.operationId; });
        var occupied = bay.status === 'Occupied';
        var illustration = '<svg viewBox="0 0 160 90" fill="none" aria-hidden="true"><path d="M25 78V12h110v66M18 78h124M38 25h84M38 35h84M38 45h84M38 55h84M38 65h84" stroke="currentColor" stroke-width="3" opacity=".5"/>';
        if (occupied && (!truck || truck.status !== 'Called')) illustration += '<rect x="45" y="32" width="68" height="41" rx="3" fill="#1c232d" stroke="currentColor" stroke-width="3"/><path d="M79 33v38M48 43h61M48 62h61" stroke="currentColor" stroke-width="2"/><rect x="49" y="73" width="12" height="7" rx="2" fill="currentColor"/><rect x="97" y="73" width="12" height="7" rx="2" fill="currentColor"/>';
        if (bay.status === 'Unavailable') illustration += '<path d="m59 29 42 40m0-40L59 69" stroke="currentColor" stroke-width="5"/>';
        illustration += '</svg>';
        var called = snapshot.operations.find(function (item) { return item.bayId === bay.id && item.status === 'Called'; });
        var signature = bay.status + '|' + bay.operationId + '|' + (truck ? truck.status : '');
        var changed = animateUpdates && previousBays[bay.id] !== signature;
        var description = truck ? truck.queueNumber + ' · ' + (truck.status === 'Called' ? 'Reserved · Called' : truck.status === 'Completed' ? 'Awaiting departure' : truck.status) : called ? called.queueNumber + ' called · not at bay' : 'No assigned truck';
        return '<article class="bay bay-' + bay.status.toLowerCase() + (changed ? ' is-updated' : '') + '"><div class="bay-heading"><span>' + escapeHtml(bay.name) + '</span><span class="bay-state">' + (truck && truck.status === 'Called' ? 'Reserved' : escapeHtml(bay.status)) + '</span></div>' + illustration + '<strong>' + (truck ? escapeHtml(truck.registration) : occupied ? 'Assignment unknown' : bay.status === 'Available' ? 'Ready for truck' : 'Not in service') + '</strong><small>' + escapeHtml(description) + '</small></article>';
      }).join('');
    }

    function shouldSuspend() {
      return document.hidden || (document.activeElement && document.activeElement.matches('input, select, textarea')) || Boolean(document.querySelector('dialog[open]'));
    }

    function updateControls() {
      var running = simulation && simulation.isRunning();
      if (digitalTwin) digitalTwin.setPaused(!running || shouldSuspend());
      byId('simulation-toggle').textContent = running ? 'Pause simulation' : 'Start simulation';
      byId('simulation-toggle').setAttribute('aria-pressed', String(Boolean(running)));
      byId('simulation-status').textContent = running ? shouldSuspend() ? 'Auto-paused · tab hidden or editing controls' : 'Running · accelerated demo' : 'Paused · demo clock stopped';
    }

    function refresh(automatic) {
      animateUpdates = automatic === true;
      byId('refresh').disabled = true;
      try {
        if (typeof wqmsDemo === 'undefined' || !Array.isArray(wqmsDemo.operations) || !Array.isArray(wqmsDemo.bays)) throw new Error('Demonstration data could not be loaded. Check that assets/js/demo-data.js is present, then refresh.');
        if (!simulation) {
          simulation = WqmsSimulation.controller(wqmsDemo, {
            onChange: function (state, automaticUpdate) { refresh(automaticUpdate); },
            shouldSuspend: function () { updateControls(); return shouldSuspend(); },
            onError: function (error) {
              updateControls();
              byId('error').textContent = 'Simulation stopped: ' + error.message;
              byId('error').hidden = false;
            }
          });
        }
        snapshot = simulation.getState();
        renderSummary();
        renderBays();
        renderQueue();
        if (digitalTwin) {
          digitalTwin.update(snapshot, {
            animate: animateUpdates,
            running: simulation.isRunning(),
            suspended: shouldSuspend(),
            intervalMs: Number(byId('simulation-interval').value),
            reducedMotion: reducedMotion.matches
          });
        }
        previousTrucks = {};
        previousBays = {};
        snapshot.operations.forEach(function (truck) { previousTrucks[truck.id] = truck.status + '|' + truck.bayId + '|' + truck.departedAt; });
        snapshot.bays.forEach(function (bay) {
          var truck = snapshot.operations.find(function (item) { return item.id === bay.operationId; });
          previousBays[bay.id] = bay.status + '|' + bay.operationId + '|' + (truck ? truck.status : '');
        });
        byId('snapshot-time').textContent = formatDate.format(new Date(snapshot.referenceAt)) + ', ' + formatTime.format(new Date(snapshot.referenceAt)) + ' MYT';
        updateControls();
        byId('error').hidden = true;
        byId('updated').textContent = 'Last refreshed: ' + formatTime.format(new Date()) + ' MYT · simulation step ' + snapshot.simulation.step;
      } catch (error) {
        stopAnimations();
        if (digitalTwin) digitalTwin.clear();
        summaryReady = false;
        byId('error').textContent = error.message;
        byId('error').hidden = false;
        byId('summary').innerHTML = '<p class="muted">Summary unavailable</p>';
        byId('queue-body').innerHTML = '<tr><td colspan="7" class="empty-cell">Queue data unavailable</td></tr>';
        byId('bays').textContent = 'Bay states unknown — no data available.';
        byId('operations').textContent = 'Operational summary unavailable.';
        byId('updated').textContent = 'Refresh failed';
      } finally {
        byId('refresh').disabled = false;
      }
    }

    ['search', 'operation', 'status'].forEach(function (id) {
      byId(id).addEventListener(id === 'search' ? 'input' : 'change', function () {
        animateUpdates = false;
        if (snapshot) renderQueue();
      });
    });
    byId('clear').addEventListener('click', function () {
      ['search', 'operation', 'status'].forEach(function (id) { byId(id).value = ''; });
      animateUpdates = false;
      if (snapshot) renderQueue();
    });
    byId('refresh').addEventListener('click', refresh);
    byId('simulation-toggle').addEventListener('click', function () {
      if (!simulation) return;
      if (simulation.isRunning()) simulation.pause();
      else simulation.start();
    });
    byId('simulation-reset').addEventListener('click', function () {
      if (simulation) simulation.reset();
    });
    byId('simulation-interval').addEventListener('change', function () {
      if (simulation) simulation.setIntervalMs(Number(byId('simulation-interval').value));
      if (snapshot) refresh(false);
    });
    document.addEventListener('visibilitychange', function () {
      stopAnimations();
      if (snapshot) refresh(false);
    });
    document.addEventListener('focusin', updateControls);
    document.addEventListener('focusout', updateControls);
    reducedMotion.addEventListener('change', function () {
      stopAnimations();
      if (snapshot) refresh(false);
    });
    var resumeOnShow = false;
    window.addEventListener('pagehide', function () {
      resumeOnShow = simulation && simulation.isRunning();
      if (simulation) simulation.pause();
      stopAnimations();
    });
    window.addEventListener('pageshow', function () {
      if (resumeOnShow && simulation) simulation.start();
      resumeOnShow = false;
    });
    refresh();
    if (simulation) simulation.start();
  });
}
