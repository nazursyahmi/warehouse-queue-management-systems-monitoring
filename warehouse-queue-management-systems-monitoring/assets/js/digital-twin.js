/* Schematic positions only. The existing simulation owns all operational data. */
var WqmsTwin = (function () {
  var svgNamespace = 'http://www.w3.org/2000/svg';

  function svgElement(tag, attributes, text) {
    var element = document.createElementNS(svgNamespace, tag);
    Object.keys(attributes || {}).forEach(function (key) { element.setAttribute(key, attributes[key]); });
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function create(root) {
    var find = function (id) { return root.querySelector('#' + id); };
    var map = find('twin-map');
    var truckLayer = find('twin-truck-layer');
    var bayLayer = find('twin-bay-layer');
    var views = new Map();
    var bayViews = new Map();
    var snapshot = null;
    var selectedId = null;
    var frameId = null;
    var lastFrameAt = null;
    var paused = true;
    var reducedMotion = false;
    var movementDuration = 850;
    var mapHeight = 860;
    var parkingRows = 0;

    function setText(id, value) {
      var element = find(id);
      if (element.textContent !== value) element.textContent = value;
    }

    function showSelection() {
      var truck = snapshot && snapshot.operations.find(function (item) { return item.id === selectedId; });
      find('twin-truck-details').hidden = !truck;
      find('twin-clear-selection').hidden = !truck;
      find('twin-selection-hint').hidden = Boolean(truck);
      setText('twin-details-title', truck ? truck.queueNumber : 'Select a truck');
      if (!truck) {
        setText('twin-selection-hint', selectedId ? 'This truck is no longer in retained history. Select another truck.' : 'Click a truck on the map, or focus it and press Enter. Details follow the simulation automatically.');
      } else {
        var bay = snapshot.bays.find(function (item) { return item.id === truck.bayId; });
        var view = views.get(truck.id);
        setText('twin-registration', truck.registration);
        setText('twin-queue', truck.queueNumber);
        setText('twin-operation', truck.operation);
        setText('twin-status', truck.status + (truck.departedAt ? ' · Departed' : ''));
        setText('twin-assigned-bay', bay ? bay.name + (truck.departedAt ? ' · previous assignment' : '') : 'Not assigned');
        setText('twin-location', view ? view.motion ? view.routeLabel : view.location : truck.departedAt ? 'Outside warehouse' : 'Not on yard map');
      }
      views.forEach(function (view, id) {
        view.element.classList.toggle('is-selected', id === selectedId);
        view.element.setAttribute('aria-pressed', String(id === selectedId));
      });
    }

    function selectTruck(id) {
      selectedId = id;
      showSelection();
    }

    find('twin-clear-selection').addEventListener('click', function () { selectTruck(null); });

    function paintTruck(view) {
      view.element.setAttribute('transform', 'translate(' + view.x + ' ' + view.y + ')');
      view.body.setAttribute('transform', 'rotate(' + view.angle + ')');
    }

    function makeTruck(truck, position) {
      var group = svgElement('g', { class: 'twin-truck', role: 'button', tabindex: '0', 'aria-pressed': 'false' });
      var title = svgElement('title');
      var body = svgElement('g');
      // The cab points right; only the vehicle body rotates, keeping labels readable.
      body.innerHTML = '<rect class="twin-selection-ring" x="-55" y="-23" width="110" height="46" rx="9"/>' +
        '<rect class="twin-wheel" x="-37" y="-20" width="14" height="8" rx="2"/><rect class="twin-wheel" x="-37" y="12" width="14" height="8" rx="2"/>' +
        '<rect class="twin-wheel" x="29" y="-20" width="12" height="8" rx="2"/><rect class="twin-wheel" x="29" y="12" width="12" height="8" rx="2"/>' +
        '<rect class="twin-trailer" x="-48" y="-15" width="70" height="30" rx="3"/>' +
        '<path class="twin-trailer-lines" d="M-35-11V11M-23-11V11M-11-11V11M1-11V11"/>' +
        '<path class="twin-cab" d="M25-14H43L50-7V7L43 14H25Z"/>' +
        '<path class="twin-window" d="M39-10H43L47-6V6L43 10H39Z"/>';
      var label = svgElement('text', { y: '39', 'text-anchor': 'middle', class: 'twin-truck-label' }, truck.queueNumber);
      group.append(title, body, label);
      group.addEventListener('click', function () { selectTruck(truck.id); });
      group.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectTruck(truck.id);
        }
      });
      truckLayer.appendChild(group);
      var view = {
        element: group, title: title, body: body, x: position.x, y: position.y,
        angle: 0, target: null, motion: null, slot: null, location: '', routeLabel: ''
      };
      views.set(truck.id, view);
      paintTruck(view);
      return view;
    }

    function removeTruck(id) {
      var view = views.get(id);
      if (!view) return;
      if (document.activeElement === view.element) find('twin-clear-selection').focus();
      view.element.remove();
      views.delete(id);
    }

    function stopFrames() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      lastFrameAt = null;
    }

    function setPaused(value) {
      paused = Boolean(value);
      root.classList.toggle('twin-paused', paused);
      if (paused) stopFrames();
      else scheduleFrame();
    }

    // Move a fixed distance along successive road segments instead of cutting
    // diagonally across buildings. This never changes a truck's queue status.
    function startMotion(view, points, leaving) {
      var lengths = [];
      var total = 0;
      for (var index = 1; index < points.length; index++) {
        var length = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
        lengths.push(length);
        total += length;
      }
      view.motion = { points: points, lengths: lengths, total: total, elapsed: 0, duration: movementDuration, leaving: leaving };
    }

    function finishMotion(view, id) {
      var motion = view.motion;
      var end = motion.points[motion.points.length - 1];
      view.x = end.x;
      view.y = end.y;
      view.angle = 0;
      view.motion = null;
      if (motion.leaving) removeTruck(id);
      else paintTruck(view);
    }

    function frame(timestamp) {
      frameId = null;
      if (paused) return;
      var elapsed = lastFrameAt === null ? 0 : Math.max(0, timestamp - lastFrameAt);
      lastFrameAt = timestamp;
      views.forEach(function (view, id) {
        var motion = view.motion;
        if (!motion) return;
        motion.elapsed += elapsed;
        var progress = Math.min(1, motion.elapsed / motion.duration);
        if (progress === 1 || reducedMotion || motion.total === 0) {
          finishMotion(view, id);
          return;
        }
        var remaining = progress * motion.total;
        for (var index = 0; index < motion.lengths.length; index++) {
          var length = motion.lengths[index];
          if (remaining > length) { remaining -= length; continue; }
          var start = motion.points[index];
          var end = motion.points[index + 1];
          var fraction = length ? remaining / length : 1;
          view.x = start.x + (end.x - start.x) * fraction;
          view.y = start.y + (end.y - start.y) * fraction;
          view.angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
          paintTruck(view);
          break;
        }
      });
      scheduleFrame();
      if (frameId === null) { lastFrameAt = null; showSelection(); }
    }

    function scheduleFrame() {
      if (paused || frameId !== null) return;
      var moving = Array.from(views.values()).some(function (view) { return Boolean(view.motion); });
      if (moving) frameId = requestAnimationFrame(frame);
    }

    function bayPosition(bayId) {
      var index = snapshot.bays.findIndex(function (bay) { return bay.id === bayId; });
      return index === -1 ? null : { x: 915, y: 235 + index * 90 };
    }

    function updateLayout() {
      var maxSlot = 0;
      views.forEach(function (view) { if (view.slot !== null) maxSlot = Math.max(maxSlot, view.slot + 1); });
      var rows = Math.max(6, Math.ceil(maxSlot / 3));
      mapHeight = Math.max(860, 380 + rows * 80);
      map.setAttribute('viewBox', '0 0 1200 ' + mapHeight);
      map.setAttribute('height', mapHeight);
      find('twin-boundary').setAttribute('height', mapHeight - 40);
      find('twin-waiting-area').setAttribute('height', mapHeight - 340);
      find('twin-exit-road').setAttribute('d', 'M790 200V' + (mapHeight - 60) + 'H1160');
      find('twin-exit-marking').setAttribute('d', 'M790 735V' + (mapHeight - 60) + 'H1090');
      find('twin-exit-gate').setAttribute('transform', 'translate(0 ' + (mapHeight - 860) + ')');
      if (parkingRows !== rows) {
        var spaces = find('twin-parking-spaces');
        spaces.replaceChildren();
        for (var index = 0; index < rows * 3; index++) {
          spaces.appendChild(svgElement('rect', { x: 240 + index % 3 * 140, y: 221 + Math.floor(index / 3) * 80, width: 120, height: 66, rx: 5, class: 'twin-parking-space' }));
        }
        parkingRows = rows;
      }
    }

    function updateBays() {
      snapshot.bays.forEach(function (bay, index) {
        var view = bayViews.get(bay.id);
        if (!view) {
          var group = svgElement('g');
          var label = svgElement('text', { x: 860, y: 235 + index * 90 - 29 });
          var pad = svgElement('rect', { x: 852, y: 235 + index * 90 - 20, width: 145, height: 44, rx: 5, class: 'twin-dock-pad' });
          var status = svgElement('text', { x: 1013, y: 235 + index * 90 - 3, class: 'twin-dock-state' });
          var owner = svgElement('text', { x: 1013, y: 235 + index * 90 + 21, class: 'twin-dock-owner' });
          group.append(pad, label, status, owner);
          bayLayer.appendChild(group);
          view = { group: group, label: label, status: status, owner: owner };
          bayViews.set(bay.id, view);
        }
        var truck = snapshot.operations.find(function (item) { return item.id === bay.operationId; });
        var status = truck && truck.status === 'Called' ? 'Reserved' : bay.status;
        view.group.setAttribute('class', 'twin-dock twin-dock-' + bay.status.toLowerCase());
        view.label.textContent = bay.name + ' · ' + (bay.operation || 'Shared');
        view.status.textContent = status;
        view.owner.textContent = truck ? truck.registration : bay.status === 'Unavailable' ? 'Not in service' : 'Ready for truck';
      });
    }

    function routeTo(view, truck, target, isNew, leaving) {
      var points = [{ x: view.x, y: view.y }];
      if (leaving) {
        points.push({ x: 790, y: view.y }, { x: 790, y: mapHeight - 60 }, { x: 1135, y: mapHeight - 60 });
      } else if (isNew && truck.status === 'Waiting') {
        points.push({ x: 352, y: 110 }, { x: 710, y: 110 }, { x: 710, y: target.y });
      } else if (truck.status === 'Called') {
        points.push({ x: 710, y: view.y }, { x: 710, y: target.y });
      } else if (view.x < 740 && truck.status !== 'Waiting') {
        points.push({ x: 710, y: view.y }, { x: 710, y: target.y });
      } else if (view.y !== target.y) {
        points.push({ x: view.x, y: target.y });
      }
      points.push(target);
      return points;
    }

    function update(state, options) {
      // Reset replaces the simulation snapshot. Discard routes and selections
      // so identities reused by Reset cannot inherit old animated positions.
      var reset = snapshot !== state;
      if (reset) {
        stopFrames();
        truckLayer.replaceChildren();
        views.clear();
        selectedId = null;
      }
      snapshot = state;
      reducedMotion = options.reducedMotion;
      movementDuration = Math.max(150, (options.intervalMs || 1000) * 0.85);
      var active = state.operations.filter(function (truck) { return !truck.departedAt && truck.status !== 'Cancelled'; });
      var activeIds = new Set(active.map(function (truck) { return truck.id; }));
      views.forEach(function (view, id) {
        if (!activeIds.has(id) && !state.operations.some(function (truck) { return truck.id === id && truck.departedAt; })) removeTruck(id);
        if (view.slot !== null && !active.some(function (truck) { return truck.id === id && truck.status === 'Waiting'; })) view.slot = null;
      });
      var usedSlots = new Set();
      views.forEach(function (view) { if (view.slot !== null) usedSlots.add(view.slot); });
      active.forEach(function (truck) {
        var view = views.get(truck.id);
        if (!view) view = makeTruck(truck, { x: 65, y: 110 });
        if (truck.status === 'Waiting' && view.slot === null) {
          var slot = 0;
          while (usedSlots.has(slot)) slot++;
          view.slot = slot;
          usedSlots.add(slot);
        }
      });
      updateLayout();
      updateBays();
      state.operations.forEach(function (truck) {
        var view = views.get(truck.id);
        if (!view) return; // Historical departures are not placed back on the map.
        var leaving = Boolean(truck.departedAt);
        var target = bayPosition(truck.bayId);
        if (leaving) target = { x: 1250, y: mapHeight - 60 };
        else if (truck.status === 'Waiting') target = { x: 300 + view.slot % 3 * 140, y: 250 + Math.floor(view.slot / 3) * 80 };
        else if (truck.status === 'Called' && target) target = { x: 800, y: target.y };
        if (!target) { removeTruck(truck.id); return; }
        var isNew = !view.target;
        view.location = leaving ? 'Outside warehouse' : truck.status === 'Waiting' ? 'Truck waiting area' : truck.status === 'Called' ? 'Reserved bay staging area' : truck.status === 'Completed' ? 'At bay · awaiting departure' : 'At assigned loading bay';
        view.routeLabel = leaving ? 'Departure animation · exit route' : truck.status === 'Waiting' ? 'Entrance → registration → waiting area' : truck.status === 'Called' ? 'Waiting area → reserved bay staging' : 'Moving to assigned loading bay';
        var accessibleName = truck.registration + ', ' + truck.queueNumber + ', ' + truck.operation + ', ' + truck.status + (leaving ? ', Departed' : '') + ', ' + (truck.bayId || 'No bay assigned');
        view.element.setAttribute('aria-label', accessibleName);
        view.title.textContent = accessibleName;
        view.element.classList.toggle('twin-inbound', truck.operation === 'Inbound');
        view.element.classList.toggle('twin-outbound', truck.operation === 'Outbound');
        view.element.classList.toggle('twin-processing', truck.status === 'Loading / Unloading');
        view.element.classList.toggle('twin-leaving', leaving);
        if (!view.target || view.target.x !== target.x || view.target.y !== target.y) {
          var points = routeTo(view, truck, target, isNew, leaving);
          view.target = target;
          if (!reset && options.animate && !reducedMotion) startMotion(view, points, leaving);
          else {
            view.motion = null;
            view.x = target.x;
            view.y = target.y;
            view.angle = 0;
            if (leaving) removeTruck(truck.id);
            else paintTruck(view);
          }
        } else if (view.motion) {
          view.motion.elapsed = view.motion.elapsed / view.motion.duration * movementDuration;
          view.motion.duration = movementDuration;
        }
        if (reducedMotion && view.motion) finishMotion(view, truck.id);
      });
      setText('twin-count', active.length + ' trucks on site · ' + active.filter(function (truck) { return truck.status === 'Waiting'; }).length + ' waiting');
      setPaused(!options.running || options.suspended);
      showSelection();
    }

    return {
      update: update,
      setPaused: setPaused,
      clear: function () {
        stopFrames();
        views.clear();
        truckLayer.replaceChildren();
        snapshot = null;
        selectedId = null;
        bayViews.forEach(function (view) {
          view.group.setAttribute('class', 'twin-dock twin-dock-unavailable');
          view.status.textContent = 'Unknown';
          view.owner.textContent = 'Data unavailable';
        });
        setText('twin-count', 'Yard data unavailable');
        showSelection();
      }
    };
  }

  return { create: create };
}());
