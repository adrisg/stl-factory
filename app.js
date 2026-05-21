/**
 * Main application — wires SVGParser, ExtrusionEngine, STLExporter, Three.js scene.
 */

(function () {
  // ── State ──────────────────────────────────────────────────────────────────
  let svgData = null;          // { elements, groups, svgEl, width, height }
  let svgFilename = 'export';
  let selectedIds = new Set();
  let globalScale = 0.264583;
  const collapsedGroups = new Set();
  let currentTextGroupId = null;

  const ICO_EYE_OPEN   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const ICO_EYE_CLOSED = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  const ICO_TRASH      = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;

  const view2d = { scale: 1, tx: 0, ty: 0, wasDragged: false };
  let controls2dSetup = false;
  let updateMoveHandle = () => {}; // assigned once the SVG handle overlay is created

  let renderer, scene, camera, animId;
  let gizmoScene, gizmoCamera;
  let svgPlane = null, svgPlaneVisible = false;
  let meshTransparent = false;
  let orbitStart = null;
  let isDragging = false;
  let theta = 0.4, phi = 1.1, radius = 200;
  let panX = 0, panY = 0, panYW = 0;
  let hasFitCamera = false;
  let homeCam = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const elementsList  = document.getElementById('elements-list');
  const selectedPanel = document.getElementById('selected-panel');
  const selectedName  = document.getElementById('selected-name');
  const applyBtn      = document.getElementById('apply-btn');
  const resetElemBtn  = document.getElementById('reset-element-btn');
  const exportBtn     = document.getElementById('export-btn');
  const resetAllBtn   = document.getElementById('reset-all-btn');
  const statusMsg     = document.getElementById('status-msg');
  const elementCount  = document.getElementById('element-count');
  const dimX          = document.getElementById('dim-x');
  const dimY          = document.getElementById('dim-y');
  const svgContainer  = document.getElementById('svg-container');
  const canvas        = document.getElementById('three-canvas');
  const viewTabs      = document.querySelectorAll('.tab-btn');
  const views         = document.querySelectorAll('.view');
  const extrudeDepth  = document.getElementById('extrude-depth');
  const extrudeOffset = document.getElementById('extrude-offset');
  const dbgNative     = document.getElementById('dbg-native');
  const dbgEngine     = document.getElementById('dbg-engine');
  const dbgStats      = document.getElementById('debug-stats');
  const dbgPathD      = document.getElementById('debug-path-d');
  const colorInput    = document.getElementById('color-3d');
  const colorFromSvg  = document.getElementById('color-from-svg');

  // ── Tabs ───────────────────────────────────────────────────────────────────
  viewTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      viewTabs.forEach(b => b.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('view-' + btn.dataset.view).classList.add('active');
      requestAnimationFrame(() => {
        if (btn.dataset.view === 'split') activateSplitView();
        else {
          deactivateSplitView();
          if (renderer && camera) {
            renderer.setSize(canvas.clientWidth, canvas.clientHeight);
            camera.aspect = canvas.clientWidth / canvas.clientHeight;
            camera.updateProjectionMatrix();
          }
        }
        render3D();
      });
    });
  });

  // ── 2D SVG render ──────────────────────────────────────────────────────────
  function renderSVG2D() {
    const svgEl = svgData.svgEl;
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    svgEl.style.width   = svgData.width  + 'px';
    svgEl.style.height  = svgData.height + 'px';
    svgEl.style.display = 'block';
    svgEl.style.overflow = 'visible';

    // Origin axis lines — inserted before content so they render below everything
    if (!svgEl.querySelector('#grid-axes')) {
      const axesG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      axesG.id = 'grid-axes';
      axesG.setAttribute('pointer-events', 'none');
      function mkAxis(x1, y1, x2, y2, color) {
        const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l.setAttribute('x1', x1); l.setAttribute('y1', y1);
        l.setAttribute('x2', x2); l.setAttribute('y2', y2);
        l.setAttribute('stroke', color);
        l.setAttribute('stroke-width', '1.5');
        l.setAttribute('vector-effect', 'non-scaling-stroke');
        return l;
      }
      axesG.appendChild(mkAxis(-99999, 0, 99999, 0, 'rgba(224,85,85,0.55)'));   // X axis
      axesG.appendChild(mkAxis(0, -99999, 0, 99999, 'rgba(68,187,102,0.55)')); // Y axis
      svgEl.insertBefore(axesG, svgEl.firstChild);
    }

    svgEl.addEventListener('click', () => {
      if (view2d.wasDragged) { view2d.wasDragged = false; return; }
      selectedIds.clear();
      updateSelectionVisuals();
      updatePanel();
    });

    svgEl.querySelectorAll('[data-elem-ref]').forEach(shape => {
      shape.classList.add('svg-selectable');
      const refId = shape.getAttribute('data-elem-ref');
      shape.addEventListener('click', ev => {
        if (view2d.wasDragged) { view2d.wasDragged = false; return; }
        ev.stopPropagation();
        selectElement(refId, ev.ctrlKey || ev.metaKey);
      });
    });

    const wrapper = document.createElement('div');
    wrapper.id = 'svg-wrapper';
    wrapper.appendChild(svgEl);

    const gizmo2d = svgContainer.querySelector('.axis-gizmo-2d');
    while (svgContainer.firstChild) svgContainer.removeChild(svgContainer.firstChild);
    svgContainer.appendChild(wrapper);
    if (gizmo2d) svgContainer.appendChild(gizmo2d);

    if (!controls2dSetup) { setup2DControls(); controls2dSetup = true; }

    // ── Move handle overlay ───────────────────────────────────────────
    (function () {
      const MH_PX = 22; // desired size in CSS pixels (constant regardless of zoom)
      const ICON_D = 'M8,1L10,4L9,4L9,7L12,7L12,6L15,8L12,10L12,9L9,9L9,12L10,12L8,15L6,12L7,12L7,9L4,9L4,10L1,8L4,6L4,7L7,7L7,4L6,4Z';

      const mhLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      mhLayer.id = 'mh-layer';
      svgEl.appendChild(mhLayer);

      const mhG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      mhG.style.display = 'none';
      mhG.style.cursor = 'grab';

      const mhRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      mhRect.setAttribute('rx', '3');
      mhRect.setAttribute('fill', '#e94560');
      mhRect.setAttribute('stroke', 'rgba(255,255,255,0.55)');
      mhRect.setAttribute('stroke-width', '0.5');
      mhG.appendChild(mhRect);

      const mhIcon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      mhIcon.setAttribute('fill', 'white');
      mhG.appendChild(mhIcon);

      mhLayer.appendChild(mhG);

      let mhTargets  = []; // [{ el, id }, ...]
      let mhDragging = false;
      let mhStartSVG = null, mhBBox0 = null, mhSzCache = MH_PX;

      function clientToSVG(cx, cy) {
        const ctm = svgEl.getScreenCTM();
        if (!ctm) return { x: cx, y: cy };
        const inv = ctm.inverse();
        return { x: inv.a*cx + inv.c*cy + inv.e, y: inv.b*cx + inv.d*cy + inv.f };
      }
      function getSVGUnits() {
        const ctm = svgEl.getScreenCTM();
        return ctm ? MH_PX / Math.abs(ctm.a) : MH_PX;
      }
      function placeHandle(bx, by, sz) {
        mhRect.setAttribute('width', sz);
        mhRect.setAttribute('height', sz);
        mhIcon.setAttribute('d', ICON_D);
        mhIcon.setAttribute('transform', `scale(${sz / 16})`);
        mhG.setAttribute('transform', `translate(${bx},${by - sz - 2})`);
      }
      function mhHide() {
        if (mhDragging) return;
        mhG.style.display = 'none';
        mhTargets = [];
      }

      // Show handle for all currently selected elements (called from updateSelectionVisuals)
      updateMoveHandle = function () {
        if (mhDragging || selectedIds.size === 0) { mhHide(); return; }
        const pathEls = [...selectedIds]
          .map(id => ({ el: svgEl.querySelector(`[data-elem-ref="${id}"]`), id }))
          .filter(t => t.el);
        if (!pathEls.length) { mhHide(); return; }

        let minX = Infinity, minY = Infinity;
        pathEls.forEach(({ el }) => {
          try { const bb = el.getBBox(); if (bb.x < minX) minX = bb.x; if (bb.y < minY) minY = bb.y; } catch(e) {}
        });
        if (!isFinite(minX)) { mhHide(); return; }

        const sz = getSVGUnits();
        mhSzCache = sz;
        mhBBox0   = { x: minX, y: minY };
        placeHandle(minX, minY, sz);
        svgEl.appendChild(mhLayer); // keep handle on top of all SVG children
        mhG.style.display = '';
        mhTargets = pathEls;
      };

      mhG.addEventListener('mousedown', e => {
        if (!mhTargets.length) return;
        e.stopPropagation(); e.preventDefault();
        mhDragging = true;
        mhG.style.cursor = 'grabbing';
        mhStartSVG = clientToSVG(e.clientX, e.clientY);
        const bx0 = mhBBox0.x, by0 = mhBBox0.y, sz = mhSzCache;
        const targets = mhTargets.slice();

        function onMove(e) {
          const cur = clientToSVG(e.clientX, e.clientY);
          const dx = cur.x - mhStartSVG.x, dy = cur.y - mhStartSVG.y;
          targets.forEach(({ el }) => el.setAttribute('transform', `translate(${dx},${dy})`));
          placeHandle(bx0 + dx, by0 + dy, sz);
        }
        function onUp(e) {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup',   onUp);
          const cur = clientToSVG(e.clientX, e.clientY);
          const dx = cur.x - mhStartSVG.x, dy = cur.y - mhStartSVG.y;
          let moved = false;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            targets.forEach(({ el, id }) => {
              const elemData = svgData?.elements.find(e => e.id === id);
              if (elemData) { elemData.pathD = translatePathD(elemData.pathD, dx, dy); el.setAttribute('d', elemData.pathD); }
              el.removeAttribute('transform');
            });
            moved = true;
          } else {
            targets.forEach(({ el }) => el.removeAttribute('transform'));
          }
          mhDragging = false;
          mhG.style.cursor = 'grab';
          view2d.wasDragged = true;
          if (moved) rebuild3D();
          updateMoveHandle();
        }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);
      });
    })();

    requestAnimationFrame(autoFit2D);
  }

  function applyTransform2D() {
    const wrapper = document.getElementById('svg-wrapper');
    if (wrapper) wrapper.style.transform =
      `translate(${view2d.tx}px, ${view2d.ty}px) scale(${view2d.scale})`;

    // Infinite grid that follows pan/zoom: minor every 50 SVG px, major every 250
    const GRID = 50;
    const gs   = GRID * view2d.scale;
    const gs5  = gs * 5;
    const ox   = ((view2d.tx % gs)  + gs)  % gs;
    const oy   = ((view2d.ty % gs)  + gs)  % gs;
    const ox5  = ((view2d.tx % gs5) + gs5) % gs5;
    const oy5  = ((view2d.ty % gs5) + gs5) % gs5;
    svgContainer.style.backgroundSize =
      `${gs}px ${gs}px, ${gs}px ${gs}px, ${gs5}px ${gs5}px, ${gs5}px ${gs5}px`;
    svgContainer.style.backgroundPosition =
      `${ox}px ${oy}px, ${ox}px ${oy}px, ${ox5}px ${oy5}px, ${ox5}px ${oy5}px`;
  }

  function autoFit2D() {
    const cw = svgContainer.clientWidth  || svgContainer.offsetWidth;
    const ch = svgContainer.clientHeight || svgContainer.offsetHeight;
    if (!cw || !ch || !svgData) return;
    const pad = 40;
    const s = Math.min((cw - pad) / svgData.width, (ch - pad) / svgData.height);
    view2d.scale = s;
    view2d.tx = (cw - svgData.width  * s) / 2;
    view2d.ty = (ch - svgData.height * s) / 2;
    applyTransform2D();
  }

  function setup2DControls() {
    let dragging = false, dragStart = {}, totalMove = 0;

    svgContainer.addEventListener('mousedown', e => {
      if (e.button !== 0 && e.button !== 1) return;
      if (e.button === 1) e.preventDefault();
      dragging = true; totalMove = 0;
      dragStart = { x: e.clientX, y: e.clientY, tx: view2d.tx, ty: view2d.ty };
      svgContainer.classList.add('grabbing');
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      totalMove += Math.abs(dx) + Math.abs(dy);
      view2d.tx = dragStart.tx + dx;
      view2d.ty = dragStart.ty + dy;
      applyTransform2D();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      svgContainer.classList.remove('grabbing');
      if (totalMove > 5) view2d.wasDragged = true;
    });
    svgContainer.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = svgContainer.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view2d.tx = mx - (mx - view2d.tx) * factor;
      view2d.ty = my - (my - view2d.ty) * factor;
      view2d.scale = Math.max(0.02, Math.min(100, view2d.scale * factor));
      applyTransform2D();
    }, { passive: false });
    svgContainer.addEventListener('dblclick', autoFit2D);
  }

  // ── Elements list ──────────────────────────────────────────────────────────
  function makeEyeBtn(onClick) {
    const btn = document.createElement('button');
    btn.className = 'eye-btn';
    btn.title = 'Mostrar / ocultar';
    btn.innerHTML = ICO_EYE_OPEN;
    btn.addEventListener('click', ev => { ev.stopPropagation(); onClick(); });
    return btn;
  }

  function toggleGroupCollapse(groupId) {
    if (collapsedGroups.has(groupId)) collapsedGroups.delete(groupId);
    else collapsedGroups.add(groupId);
    buildElementsList();
  }

  function buildElementsList() {
    elementsList.innerHTML = '';
    if (!svgData || !svgData.elements.length) {
      elementsList.innerHTML = '<p class="hint">Sin elementos</p>';
      return;
    }
    const GROUP_ICONS = {
      svg:   `<svg class="group-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
      text:  `<svg class="group-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
      shape: `<svg class="group-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
    };

    function renderGroup(group, depth) {
      const isSubgroup = depth > 0;
      const div = document.createElement('div');
      div.className = 'element-item' + (isSubgroup ? ' subgroup-item' : '');
      if (isSubgroup) div.style.marginLeft = (depth * 14) + 'px';
      div.dataset.groupId = group.id;

      const arrowBtn = document.createElement('button');
      arrowBtn.className = 'collapse-btn';
      arrowBtn.dataset.groupCollapse = group.id;
      arrowBtn.textContent = collapsedGroups.has(group.id) ? '▶' : '▼';
      arrowBtn.title = 'Expandir / contraer';
      arrowBtn.addEventListener('click', ev => { ev.stopPropagation(); toggleGroupCollapse(group.id); });
      div.appendChild(arrowBtn);

      if (!isSubgroup && group.groupType && GROUP_ICONS[group.groupType]) {
        const iconWrap = document.createElement('span');
        iconWrap.className = 'group-type-icon-wrap';
        iconWrap.innerHTML = GROUP_ICONS[group.groupType];
        div.appendChild(iconWrap);
      }

      const label = document.createElement('span');
      label.className = 'elem-label';
      label.textContent = group.label || group.id;
      div.appendChild(label);

      const eyeBtn = makeEyeBtn(() => toggleGroupVisibility(group.id));
      eyeBtn.dataset.groupEyeId = group.id;
      div.appendChild(eyeBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.title = 'Eliminar';
      delBtn.innerHTML = ICO_TRASH;
      delBtn.addEventListener('click', ev => { ev.stopPropagation(); deleteGroup(group.id); });
      div.appendChild(delBtn);

      div.addEventListener('click', ev => selectGroup(group.id, ev.ctrlKey || ev.metaKey));
      elementsList.appendChild(div);

      if (!collapsedGroups.has(group.id)) {
        (group.children || []).forEach(elemId => {
          const el = svgData.elements.find(e => e.id === elemId);
          if (el) renderElement(el, depth + 1);
        });
        (group.subGroupIds || []).forEach(sgId => {
          const sg = svgData.groups.find(g => g.id === sgId);
          if (sg) renderGroup(sg, depth + 1);
        });
      }
    }

    function renderElement(el, depth) {
      const div = document.createElement('div');
      div.className = 'element-item indented' + (el.hasFill === false ? ' no-fill-item' : '');
      div.style.marginLeft = (depth * 14) + 'px';
      div.dataset.elemId = el.id;

      const colorDot = document.createElement('span');
      colorDot.className = 'elem-color' + (el.hasFill === false ? ' no-fill' : '');
      if (el.hasFill !== false) colorDot.style.background = el.fill;
      div.appendChild(colorDot);

      const labelSpan = document.createElement('span');
      labelSpan.className = 'elem-label';
      labelSpan.textContent = el.label;
      div.appendChild(labelSpan);

      const checkMark = document.createElement('span');
      checkMark.className = 'check-mark';
      checkMark.textContent = '✓';
      div.appendChild(checkMark);

      const eyeBtn = makeEyeBtn(() => toggleElementVisibility(el.id));
      eyeBtn.dataset.elemEyeId = el.id;
      div.appendChild(eyeBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.title = 'Eliminar';
      delBtn.innerHTML = ICO_TRASH;
      delBtn.addEventListener('click', ev => { ev.stopPropagation(); deleteElement(el.id); });
      div.appendChild(delBtn);

      div.addEventListener('click', ev => selectElement(el.id, ev.ctrlKey || ev.metaKey));
      elementsList.appendChild(div);
    }

    // Render top-level groups (no parentGroupId) in insertion order
    svgData.groups.filter(g => !g.parentGroupId).forEach(g => renderGroup(g, 0));
    // Render any orphan elements (no group)
    svgData.elements.filter(e => !e.groupId).forEach(el => renderElement(el, 0));
  }

  function toggleElementVisibility(id) {
    const el = svgData?.elements.find(e => e.id === id);
    if (!el) return;
    el.visible = !el.visible;
    applyVisibility2D(id, el.visible);
    refreshEyeBtn(id, el.visible);
    refreshGroupEye(el.groupId);
    rebuild3D();
  }

  function toggleGroupVisibility(groupId) {
    const allIds = getAllElementIds(groupId);
    const anyVisible = allIds.some(id => {
      const e = svgData.elements.find(el => el.id === id);
      return e?.visible !== false;
    });
    allIds.forEach(id => {
      const e = svgData.elements.find(el => el.id === id);
      if (e) { e.visible = !anyVisible; applyVisibility2D(id, e.visible); refreshEyeBtn(id, e.visible); }
    });
    refreshGroupEye(groupId);
    rebuild3D();
  }

  function applyVisibility2D(id, visible) {
    const shape = svgContainer.querySelector(`[data-elem-ref="${id}"]`);
    if (shape) shape.style.visibility = visible ? '' : 'hidden';
  }

  function refreshEyeBtn(id, visible) {
    const btn = document.querySelector(`[data-elem-eye-id="${id}"]`);
    if (!btn) return;
    btn.innerHTML = visible ? ICO_EYE_OPEN : ICO_EYE_CLOSED;
    btn.classList.toggle('eye-off', !visible);
  }

  function refreshGroupEye(groupId) {
    let gid = groupId;
    while (gid) {
      const group = svgData?.groups.find(g => g.id === gid);
      if (!group) break;
      const allIds = getAllElementIds(gid);
      const anyVisible = allIds.some(id => {
        const e = svgData.elements.find(el => el.id === id);
        return e?.visible !== false;
      });
      const btn = document.querySelector(`[data-group-eye-id="${gid}"]`);
      if (btn) {
        btn.innerHTML = anyVisible ? ICO_EYE_OPEN : ICO_EYE_CLOSED;
        btn.classList.toggle('eye-off', !anyVisible);
      }
      gid = group.parentGroupId || null;
    }
  }

  function fillPanelFromConfig(cfg) {
    extrudeDepth.value  = cfg.extrudeUp ?? 0;
    extrudeOffset.value = cfg.extrudeOffset ?? 0;
    colorInput.value    = cfg.color3d || '#888888';
  }

  function updateSelectionVisuals() {
    document.querySelectorAll('.element-item').forEach(d => d.classList.remove('selected'));
    document.querySelectorAll('.svg-selectable').forEach(s => {
      s.classList.remove('selected');
      s.classList.remove('text-group-selected');
    });
    let lastListItem = null;
    selectedIds.forEach(id => {
      const listItem = document.querySelector(`[data-elem-id="${id}"]`);
      if (listItem) { listItem.classList.add('selected'); lastListItem = listItem; }
      const svgShape = svgContainer.querySelector(`[data-elem-ref="${id}"]`);
      if (svgShape) svgShape.classList.add('selected');
    });
    if (lastListItem) lastListItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    svgData?.groups.forEach(group => {
      const allIds = getAllElementIds(group.id);
      if (allIds.length && allIds.every(id => selectedIds.has(id))) {
        document.querySelector(`[data-group-id="${group.id}"]`)?.classList.add('selected');
        if (group.isTextGroup) {
          allIds.forEach(id => {
            const s = svgContainer.querySelector(`[data-elem-ref="${id}"]`);
            if (s) s.classList.add('text-group-selected');
          });
        }
      }
    });
    updateMoveHandle();
  }

  function updateDebugPanel(id) {
    const el = svgData?.elements.find(e => e.id === id);
    if (!el || !dbgNative) return;
    const W = dbgNative.width, H = dbgNative.height, PAD = 8;

    const ctxN = dbgNative.getContext('2d');
    ctxN.clearRect(0, 0, W, H);
    let p2d;
    try { p2d = new Path2D(el.pathD); } catch(e) { p2d = null; }
    if (p2d) {
      const svgShape = svgContainer.querySelector(`[data-elem-ref="${id}"]`);
      let bx = 0, by = 0, bw = 100, bh = 100;
      if (svgShape?.getBBox) {
        try { const b = svgShape.getBBox(); bx = b.x; by = b.y; bw = b.width || 1; bh = b.height || 1; } catch(e){}
      }
      const scaleF = Math.min((W - PAD*2) / bw, (H - PAD*2) / bh);
      ctxN.save();
      ctxN.translate(PAD - bx * scaleF, PAD - by * scaleF);
      ctxN.scale(scaleF, scaleF);
      ctxN.fillStyle = el.fill === '#888888' ? '#aaaaaa' : el.fill;
      ctxN.fill(p2d, 'evenodd');
      ctxN.strokeStyle = 'rgba(255,255,255,0.4)';
      ctxN.lineWidth = 1 / scaleF;
      ctxN.stroke(p2d);
      ctxN.restore();
    } else {
      ctxN.fillStyle = '#e94560';
      ctxN.font = '11px sans-serif';
      ctxN.fillText('Path2D error', 4, 20);
    }

    const ctxE = dbgEngine.getContext('2d');
    ctxE.clearRect(0, 0, W, H);
    const subpaths = ExtrusionEngine.debugShapes(el.pathD);
    if (subpaths.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      subpaths.forEach(sp => sp.pts.forEach(p => {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }));
      const bw = (maxX - minX) || 1, bh = (maxY - minY) || 1;
      const scaleF = Math.min((W - PAD*2) / bw, (H - PAD*2) / bh);
      const colors = ['#4fc3f7', '#ef9a9a', '#a5d6a7', '#fff176', '#ce93d8'];
      subpaths.forEach((sp, si) => {
        ctxE.beginPath();
        sp.pts.forEach((p, i) => {
          const sx = (p.x - minX) * scaleF + PAD, sy = (p.y - minY) * scaleF + PAD;
          i === 0 ? ctxE.moveTo(sx, sy) : ctxE.lineTo(sx, sy);
        });
        if (sp.closed) ctxE.closePath();
        ctxE.fillStyle = colors[si % colors.length] + '44';
        ctxE.fill('evenodd');
        ctxE.strokeStyle = colors[si % colors.length];
        ctxE.lineWidth = 1.5;
        ctxE.stroke();
        if (sp.pts.length) {
          const p0x = (sp.pts[0].x - minX) * scaleF + PAD, p0y = (sp.pts[0].y - minY) * scaleF + PAD;
          ctxE.fillStyle = colors[si % colors.length];
          ctxE.beginPath(); ctxE.arc(p0x, p0y, 3, 0, Math.PI*2); ctxE.fill();
        }
      });
    } else {
      ctxE.fillStyle = '#e94560'; ctxE.font = '11px sans-serif'; ctxE.fillText('Sin puntos', 4, 20);
    }
    const totalPts = subpaths.reduce((s, sp) => s + sp.pts.length, 0);
    const closedCount = subpaths.filter(sp => sp.closed).length;
    dbgStats.innerHTML =
      `<span class="dbg-tag">Subpaths: ${subpaths.length}</span>` +
      `<span class="dbg-tag">Pts: ${totalPts}</span>` +
      `<span class="dbg-tag ${closedCount < subpaths.length ? 'dbg-warn' : ''}">Cerrados: ${closedCount}/${subpaths.length}</span>`;
    dbgPathD.textContent = el.pathD;
  }

  function updatePanel() {
    const tgEdit = document.getElementById('text-group-edit');
    if (selectedIds.size === 0) {
      selectedPanel.classList.add('hidden');
      tgEdit.classList.add('hidden');
      currentTextGroupId = null;
      return;
    }
    selectedPanel.classList.remove('hidden');

    const matchedGroup = svgData?.groups.find(g => {
      const allIds = getAllElementIds(g.id);
      return allIds.length > 0 &&
        allIds.length === selectedIds.size &&
        allIds.every(id => selectedIds.has(id));
    });

    if (matchedGroup?.isTextGroup) {
      currentTextGroupId = matchedGroup.id;
      document.getElementById('tg-text').value = matchedGroup.textContent || '';
      tgFontPicker.setValue(matchedGroup.fontFamily || GOOGLE_FONTS[0]);
      document.getElementById('tg-size').value = matchedGroup.fontSize || 40;
      tgEdit.classList.remove('hidden');
    } else {
      currentTextGroupId = null;
      tgEdit.classList.add('hidden');
    }

    if (selectedIds.size === 1) {
      const id = [...selectedIds][0];
      const el = svgData.elements.find(e => e.id === id);
      selectedName.textContent = el?.label || id;
      fillPanelFromConfig(el?.config || {});
      // If element has no config yet, pre-load its SVG fill color into the picker
      if (!el?.config && el?.hasFill && el?.fill !== 'none') {
        const hex = cssColorToHex6(el.fill);
        if (hex) colorInput.value = hex;
      }
      if (document.getElementById('debug-details')?.open) updateDebugPanel(id);
      if (!matchedGroup?.isTextGroup && el?.groupId) {
        const grp = svgData.groups.find(g => g.id === el.groupId && g.isTextGroup &&
          getAllElementIds(g.id).every(cid => selectedIds.has(cid)));
        if (grp) {
          currentTextGroupId = grp.id;
          document.getElementById('tg-text').value = grp.textContent || '';
          tgFontPicker.setValue(grp.fontFamily || GOOGLE_FONTS[0]);
          document.getElementById('tg-size').value = grp.fontSize || 40;
          tgEdit.classList.remove('hidden');
        }
      }
      return;
    }

    selectedName.textContent = matchedGroup
      ? `${matchedGroup.label || matchedGroup.id} (${selectedIds.size} elem)`
      : `${selectedIds.size} elementos`;
    const firstEl = svgData.elements.find(e => selectedIds.has(e.id));
    fillPanelFromConfig(firstEl?.config || {});
  }

  function selectElement(id, ctrlKey = false) {
    if (!ctrlKey) { selectedIds.clear(); selectedIds.add(id); }
    else { if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); }
    updateSelectionVisuals();
    updatePanel();
  }

  function selectGroup(groupId, ctrlKey = false) {
    const allIds = getAllElementIds(groupId);
    if (!ctrlKey) { selectedIds.clear(); allIds.forEach(id => selectedIds.add(id)); }
    else {
      const allSelected = allIds.every(id => selectedIds.has(id));
      if (allSelected) allIds.forEach(id => selectedIds.delete(id));
      else allIds.forEach(id => selectedIds.add(id));
    }
    updateSelectionVisuals();
    updatePanel();
  }

  // Recursively collect all descendant element IDs (direct children + sub-group children)
  function getAllElementIds(groupId) {
    const group = svgData?.groups.find(g => g.id === groupId);
    if (!group) return [];
    const ids = [...(group.children || [])];
    (group.subGroupIds || []).forEach(sgId => ids.push(...getAllElementIds(sgId)));
    return ids;
  }

  async function deleteElement(id) {
    const el = svgData?.elements.find(e => e.id === id);
    if (!el) return;
    const ok = await showConfirm(`¿Eliminar "${el.label || id}"?`);
    if (!ok) return;

    if (el.groupId) {
      const group = svgData.groups.find(g => g.id === el.groupId);
      if (group) group.children = group.children.filter(c => c !== id);
    }
    svgData.svgEl.querySelector(`[data-elem-ref="${id}"]`)?.remove();
    selectedIds.delete(id);
    svgData.elements = svgData.elements.filter(e => e.id !== id);

    elementCount.textContent = `${svgData.elements.length} elem`;
    buildElementsList(); updateSelectionVisuals(); updatePanel(); rebuild3D();
    setStatus(`Eliminado: "${el.label || id}"`);
  }

  async function deleteGroup(groupId) {
    const group = svgData?.groups.find(g => g.id === groupId);
    if (!group) return;
    const label = group.label || groupId;
    const ok = await showConfirm(`¿Eliminar "${label}" y todos sus elementos?`);
    if (!ok) return;

    function collectGroupIds(gId) {
      const g = svgData.groups.find(gr => gr.id === gId);
      if (!g) return [];
      return [gId, ...(g.subGroupIds || []).flatMap(sgId => collectGroupIds(sgId))];
    }
    const groupIdsToRemove = collectGroupIds(groupId);
    const allElemIds = getAllElementIds(groupId);

    if (group.parentGroupId) {
      const parent = svgData.groups.find(g => g.id === group.parentGroupId);
      if (parent) parent.subGroupIds = (parent.subGroupIds || []).filter(id => id !== groupId);
    } else {
      svgData.svgEl.querySelector(`[data-svg-group="${groupId}"]`)?.remove();
      svgData.svgEl.querySelector(`[data-text-group="${groupId}"]`)?.remove();
      svgData.svgEl.querySelector(`[data-shape-group="${groupId}"]`)?.remove();
    }
    allElemIds.forEach(id => {
      svgData.svgEl.querySelector(`[data-elem-ref="${id}"]`)?.remove();
      selectedIds.delete(id);
    });
    svgData.elements = svgData.elements.filter(e => !allElemIds.includes(e.id));
    svgData.groups   = svgData.groups.filter(g => !groupIdsToRemove.includes(g.id));
    groupIdsToRemove.forEach(id => collapsedGroups.delete(id));
    if (groupIdsToRemove.includes(currentTextGroupId)) currentTextGroupId = null;

    elementCount.textContent = `${svgData.elements.length} elem`;
    buildElementsList(); updateSelectionVisuals(); updatePanel(); rebuild3D();
    setStatus(`Eliminado: "${label}"`);
  }

  // ── Controls logic ─────────────────────────────────────────────────────────
  function rescaleToConfigured() {
    const configured = svgData.elements.filter(el => el.config);
    if (!configured.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    configured.forEach(el => {
      ExtrusionEngine.debugShapes(el.pathD).forEach(sp => sp.pts.forEach(p => {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }));
    });
    if (!isFinite(minX) || maxY <= minY) return;
    const targetY = parseFloat(dimY.value) || 30;
    globalScale = targetY / (maxY - minY);
    const newX = ((maxX - minX) * globalScale).toFixed(2);
    dimX.value = newX; dimX.dataset.base = newX; dimY.dataset.base = String(targetY);
  }

  applyBtn.addEventListener('click', () => {
    if (!svgData || selectedIds.size === 0) return;
    const cfg = {
      extrudeUp:     parseFloat(extrudeDepth.value) || 0,
      extrudeOffset: parseFloat(extrudeOffset.value) || 0,
      scaleX: 1, scaleY: 1,
      color3d: colorInput.value,
    };
    selectedIds.forEach(id => {
      const el = svgData.elements.find(e => e.id === id);
      if (el) {
        el.config = { ...cfg };
        document.querySelector(`[data-elem-id="${id}"]`)?.classList.add('configured');
        // Reflect configured color in the 2D SVG view
        const pathEl = svgData.svgEl.querySelector(`[data-elem-ref="${id}"]`);
        if (pathEl) pathEl.setAttribute('fill', cfg.color3d);
      }
    });
    svgData.groups.forEach(group => {
      const allIds = getAllElementIds(group.id);
      if (allIds.length && allIds.every(id => svgData.elements.find(e => e.id === id)?.config))
        document.querySelector(`[data-group-id="${group.id}"]`)?.classList.add('configured');
    });
    rescaleToConfigured();
    setStatus(`Configurado: ${selectedIds.size} elemento${selectedIds.size > 1 ? 's' : ''}`);
    rebuild3D();
  });

  resetElemBtn.addEventListener('click', () => {
    if (!svgData || selectedIds.size === 0) return;
    selectedIds.forEach(id => {
      const el = svgData.elements.find(e => e.id === id);
      if (el) {
        el.config = null;
        document.querySelector(`[data-elem-id="${id}"]`)?.classList.remove('configured');
        // Restore original SVG fill in 2D view
        const pathEl = svgData.svgEl.querySelector(`[data-elem-ref="${id}"]`);
        if (pathEl) pathEl.setAttribute('fill', el.fill || 'none');
      }
    });
    svgData.groups.forEach(group => {
      if (getAllElementIds(group.id).some(id => selectedIds.has(id)))
        document.querySelector(`[data-group-id="${group.id}"]`)?.classList.remove('configured');
    });
    rebuild3D();
  });

  resetAllBtn.addEventListener('click', () => {
    if (!svgData) return;
    svgData.elements.forEach(el => el.config = null);
    document.querySelectorAll('.element-item').forEach(d => d.classList.remove('configured', 'selected'));
    document.querySelectorAll('.svg-selectable').forEach(s => s.classList.remove('selected'));
    selectedIds.clear();
    updatePanel();
    rebuild3D();
  });

  colorInput.addEventListener('input', () => {
    if (!scene || selectedIds.size === 0) return;
    const hex = parseInt(colorInput.value.slice(1), 16);
    scene.traverse(obj => {
      if (!obj.isMesh) return;
      if (selectedIds.has(obj.parent?.userData.elementId)) obj.material.color.setHex(hex);
    });
    render3D();
  });

  colorFromSvg.addEventListener('click', () => {
    const id = [...selectedIds][0];
    if (!id) return;
    const el = svgData?.elements.find(e => e.id === id);
    if (!el || !el.hasFill || el.fill === 'none') return;
    const hex = cssColorToHex6(el.fill);
    if (hex) { colorInput.value = hex; colorInput.dispatchEvent(new Event('input')); }
  });

  function cssColorToHex6(color) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  document.getElementById('debug-details')?.addEventListener('toggle', ev => {
    if (ev.target.open && selectedIds.size === 1) updateDebugPanel([...selectedIds][0]);
  });

  function initDimensions() {
    globalScale = 30 / svgData.height;
    const w = (svgData.width * globalScale).toFixed(2);
    const h = (30).toFixed(2);
    dimX.value = w; dimY.value = h;
    dimX.dataset.base = w; dimY.dataset.base = h;
    dimX.disabled = false; dimY.disabled = false;
  }

  dimX.addEventListener('input', () => {
    const newX = parseFloat(dimX.value), baseX = parseFloat(dimX.dataset.base);
    if (!newX || !baseX) return;
    dimY.value = (parseFloat(dimY.dataset.base) * newX / baseX).toFixed(2);
  });
  dimX.addEventListener('change', () => {
    const newX = parseFloat(dimX.value), baseX = parseFloat(dimX.dataset.base);
    if (!newX || !baseX || !svgData) return;
    globalScale *= newX / baseX;
    dimX.dataset.base = dimX.value; dimY.dataset.base = dimY.value;
    rebuild3D();
  });
  dimY.addEventListener('input', () => {
    const newY = parseFloat(dimY.value), baseZ = parseFloat(dimY.dataset.base);
    if (!newY || !baseZ) return;
    dimX.value = (parseFloat(dimX.dataset.base) * newY / baseZ).toFixed(2);
  });
  dimY.addEventListener('change', () => {
    const newY = parseFloat(dimY.value), baseZ = parseFloat(dimY.dataset.base);
    if (!newY || !baseZ || !svgData) return;
    globalScale *= newY / baseZ;
    dimX.dataset.base = dimX.value; dimY.dataset.base = dimY.value;
    rebuild3D();
  });

  document.getElementById('mesh-transparent-btn').addEventListener('click', () => {
    meshTransparent = !meshTransparent;
    document.getElementById('mesh-transparent-btn').classList.toggle('active', meshTransparent);
    applyMeshTransparency(meshTransparent);
  });

  document.getElementById('svg-plane-btn').addEventListener('click', () => {
    svgPlaneVisible = !svgPlaneVisible;
    document.getElementById('svg-plane-btn').classList.toggle('active', svgPlaneVisible);
    if (svgPlane) { svgPlane.visible = svgPlaneVisible; render3D(); }
  });

  document.getElementById('home-btn').addEventListener('click', () => {
    if (!homeCam) return;
    ({ radius, theta, phi, panX, panY, panYW } = homeCam);
    updateCameraPosition(); render3D();
  });

  exportBtn.addEventListener('click', () => {
    if (!scene) return;
    setStatus('Exportando STL…');
    setTimeout(() => {
      try {
        const buf = STLExporter.export3D(scene);
        STLExporter.download(buf, svgFilename + '.stl');
        setStatus('STL exportado');
      } catch (err) { setStatus('Error al exportar: ' + err.message); console.error(err); }
    }, 50);
  });

  // ── Split divider ──────────────────────────────────────────────────────────
  (function () {
    const divider = document.getElementById('split-divider');
    const pane1   = document.getElementById('split-2d');
    const pane2   = document.getElementById('split-3d');
    let dragging  = false;

    divider.addEventListener('mousedown', e => {
      e.preventDefault(); dragging = true;
      divider.classList.add('dragging');
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const rect = document.getElementById('view-split').getBoundingClientRect();
      const minPx = 80, maxPx = rect.width - 80;
      const x = Math.max(minPx, Math.min(maxPx, e.clientX - rect.left));
      pane1.style.flex = `0 0 ${x}px`; pane2.style.flex = '1';
      syncSplitCanvas();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; divider.classList.remove('dragging');
      document.body.style.userSelect = ''; syncSplitCanvas();
    });
    divider.addEventListener('dblclick', () => { pane1.style.flex = ''; pane2.style.flex = ''; syncSplitCanvas(); });

    function syncSplitCanvas() {
      if (!renderer || !camera) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix(); render3D();
    }
  })();

  // ── Three.js ───────────────────────────────────────────────────────────────
  function initThree() {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x0a0a1a);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 10000);
    updateCameraPosition();
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dl1 = new THREE.DirectionalLight(0xffffff, 0.8); dl1.position.set(100, 200, 150); scene.add(dl1);
    const dl2 = new THREE.DirectionalLight(0x8888ff, 0.3); dl2.position.set(-100, -50, -100); scene.add(dl2);
    const grid = new THREE.GridHelper(400, 40, 0x222244, 0x111133);
    grid.position.y = -0.5; scene.add(grid);
    setupOrbitControls();
    setupGizmo3D();
    resizeRenderer();
    window.addEventListener('resize', resizeRenderer);
    animate();
  }

  function setupGizmo3D() {
    gizmoScene  = new THREE.Scene();
    gizmoCamera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 100);
    const geo  = new THREE.BoxGeometry(1.1, 1.1, 1.1);
    const mats = [
      new THREE.MeshPhongMaterial({ color: 0xcc3333 }),
      new THREE.MeshPhongMaterial({ color: 0x661a1a }),
      new THREE.MeshPhongMaterial({ color: 0x33aa55 }),
      new THREE.MeshPhongMaterial({ color: 0x1a5530 }),
      new THREE.MeshPhongMaterial({ color: 0x3355cc }),
      new THREE.MeshPhongMaterial({ color: 0x1a2866 }),
    ];
    gizmoScene.add(new THREE.Mesh(geo, mats));
    gizmoScene.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000 })));
    gizmoScene.add(new THREE.AxesHelper(1.55));
    gizmoScene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const dl = new THREE.DirectionalLight(0xffffff, 0.55); dl.position.set(2, 3, 4); gizmoScene.add(dl);
  }

  function renderGizmo3D() {
    if (!gizmoScene || !gizmoCamera || !renderer || !camera) return;
    const sz = 64, pad = 8, off = 10 + pad;
    const target = new THREE.Vector3(panX, panYW, panY);
    const dir = camera.position.clone().sub(target).normalize().multiplyScalar(5);
    gizmoCamera.position.copy(dir); gizmoCamera.lookAt(0, 0, 0);
    const bgOff = 10, bgSz = sz + pad * 2;
    renderer.autoClear = false;
    renderer.setScissor(bgOff, bgOff, bgSz, bgSz);
    renderer.setScissorTest(true);
    renderer.setClearColor(0x000000, 0.0);
    renderer.clearColor();
    renderer.setViewport(off, off, sz, sz);
    renderer.setClearColor(0x0a0a1a, 1.0);
    renderer.clearDepth();
    renderer.render(gizmoScene, gizmoCamera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
    renderer.autoClear = true;
  }

  function resizeRenderer() {
    if (!renderer || !canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function setupOrbitControls() {
    window.addEventListener('mouseup', () => isDragging = false);
    window.addEventListener('mousemove', e => {
      if (!isDragging || !orbitStart) return;
      const dx = e.clientX - orbitStart.x, dy = e.clientY - orbitStart.y;
      if (orbitStart.button === 0) {
        theta = orbitStart.theta - dx * 0.01;
        phi   = Math.max(0.1, Math.min(Math.PI - 0.1, orbitStart.phi - dy * 0.01));
      } else if (orbitStart.button === 2) {
        const sc = 0.3, sinT = Math.sin(theta), cosT = Math.cos(theta);
        const sinP = Math.sin(phi), cosP = Math.cos(phi);
        panX  = orbitStart.panX  + (-dx * cosT - dy * cosP * sinT) * sc;
        panYW = orbitStart.panYW + ( dy * sinP) * sc;
        panY  = orbitStart.panY  + ( dx * sinT - dy * cosP * cosT) * sc;
      }
      updateCameraPosition(); render3D();
    });
    canvas.addEventListener('mousedown', e => {
      isDragging = true;
      orbitStart = { x: e.clientX, y: e.clientY, theta, phi, panX, panY, panYW, button: e.button };
    });
    canvas.addEventListener('wheel', e => {
      radius = Math.max(10, Math.min(2000, radius + e.deltaY * 0.3));
      updateCameraPosition(); render3D();
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  function updateCameraPosition() {
    if (!camera) return;
    camera.position.set(
      radius * Math.sin(phi) * Math.sin(theta) + panX,
      radius * Math.cos(phi) + panYW,
      radius * Math.sin(phi) * Math.cos(theta) + panY
    );
    camera.lookAt(panX, panYW, panY);
  }

  let needsRender = false;
  function render3D() { needsRender = true; }
  function animate() {
    animId = requestAnimationFrame(animate);
    if (needsRender) {
      if (renderer && scene && camera) { renderer.render(scene, camera); renderGizmo3D(); }
      needsRender = false;
    }
  }

  function activateSplitView() {
    const splitTwoPane   = document.getElementById('split-2d');
    const splitThreePane = document.getElementById('split-3d');
    const threeViewport  = document.getElementById('three-viewport');
    if (svgContainer.parentElement !== splitTwoPane) {
      svgContainer._prevParent = svgContainer.parentElement;
      splitTwoPane.appendChild(svgContainer);
    }
    if (threeViewport.parentElement !== splitThreePane) {
      threeViewport._prevParent = threeViewport.parentElement;
      splitThreePane.appendChild(threeViewport);
    }
    if (renderer && camera) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w && h) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    }
  }

  function deactivateSplitView() {
    const threeViewport = document.getElementById('three-viewport');
    if (svgContainer._prevParent && svgContainer.parentElement !== svgContainer._prevParent) {
      svgContainer._prevParent.appendChild(svgContainer);
      svgContainer._prevParent = null;
    }
    if (threeViewport._prevParent && threeViewport.parentElement !== threeViewport._prevParent) {
      threeViewport._prevParent.appendChild(threeViewport);
      threeViewport._prevParent = null;
    }
  }

  function loadSVGTexture(svgEl, callback) {
    try {
      const svgW = svgData.width, svgH = svgData.height;
      const clone = svgEl.cloneNode(true);
      clone.setAttribute('width', svgW); clone.setAttribute('height', svgH);
      clone.style.width = ''; clone.style.height = '';
      const str  = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([str], { type: 'image/svg+xml;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        const max = 4096, sc = Math.min(1, max / Math.max(svgW, svgH));
        const cw = Math.round(svgW * sc), ch = Math.round(svgH * sc);
        const cvs = document.createElement('canvas');
        cvs.width = cw; cvs.height = ch;
        cvs.getContext('2d').drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        callback(new THREE.CanvasTexture(cvs));
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    } catch(e) { console.warn('SVG texture:', e); }
  }

  function rebuild3D() {
    if (!scene || !svgData) return;
    const toRemove = [];
    scene.children.forEach(obj => { if (obj.userData.isPivot) toRemove.push(obj); });
    toRemove.forEach(obj => scene.remove(obj));

    const configured = svgData.elements.filter(el => el.config);
    const toProcess  = configured.length
      ? configured
      : svgData.elements.filter(el => el.visible !== false && el.hasFill !== false).slice(0, 1);

    const pivot = new THREE.Group();
    pivot.userData.isPivot = true;
    let meshCount = 0;

    for (const el of toProcess) {
      if (el.visible === false) continue;
      if (el.hasFill === false && !el.config) continue;
      const cfg = el.config || { extrudeUp: 0, scaleX: 1, scaleY: 1 };
      const elWithCfg = el.config ? el : { ...el, config: cfg };
      try {
        const group = ExtrusionEngine.buildMesh(elWithCfg, globalScale);
        if (group) { pivot.add(group); meshCount++; }
      } catch (err) { console.warn(`Error al extruir ${el.id}:`, err); }
    }

    const planeW = svgData.width * globalScale, planeH = svgData.height * globalScale;
    const pMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
    const pMesh = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), pMat);
    pMesh.rotation.x = -Math.PI / 2;
    pMesh.renderOrder = -1;
    pMesh.visible = svgPlaneVisible;
    pMesh.userData.isSVGPlane = true;
    svgPlane = pMesh;
    pivot.add(pMesh);
    loadSVGTexture(svgData.svgEl, tex => { pMat.map = tex; pMat.needsUpdate = true; render3D(); });

    scene.add(pivot);

    if (meshCount > 0) {
      pivot.updateMatrixWorld(true);
      const meshBox = new THREE.Box3();
      pivot.children.forEach(obj => { if (obj !== pMesh) meshBox.expandByObject(obj); });
      const meshCenter = meshBox.getCenter(new THREE.Vector3());
      pivot.position.set(-meshCenter.x, -meshBox.min.y, -meshCenter.z);
      pMesh.position.set(planeW / 2, -0.02, planeH / 2);
      if (!hasFitCamera) {
        const size = meshBox.getSize(new THREE.Vector3());
        radius = Math.max(size.x, size.y, size.z) * 2.5;
        panX = 0; panY = 0; panYW = 0; phi = 1.0; theta = 0.4;
        updateCameraPosition();
        homeCam = { radius, theta, phi, panX, panY, panYW };
        hasFitCamera = true;
      }
    } else {
      pMesh.position.set(0, -0.02, 0);
      if (!hasFitCamera) {
        radius = Math.max(planeW, planeH) * 1.5;
        panX = 0; panY = 0; panYW = 0; phi = 1.0; theta = 0.4;
        updateCameraPosition();
        homeCam = { radius, theta, phi, panX, panY, panYW };
        hasFitCamera = true;
      }
    }

    if (meshTransparent) applyMeshTransparency(true);
    render3D();
    setStatus(`Vista 3D: ${meshCount} mallas`);
  }

  function applyMeshTransparency(on) {
    if (!scene) return;
    scene.traverse(obj => {
      if (obj.isMesh && obj !== svgPlane) {
        obj.material.transparent = on;
        obj.material.opacity = on ? 0.55 : 1.0;
        obj.material.needsUpdate = true;
      }
    });
    render3D();
  }

  function setStatus(msg) { statusMsg.textContent = msg; }
  dimX.value = ''; dimY.value = '';

  // ── Google Fonts ───────────────────────────────────────────────────────────
  const GOOGLE_FONTS = [
    'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Oswald',
    'Raleway', 'Ubuntu', 'Nunito', 'Poppins', 'Inter',
    'Bebas Neue', 'Anton', 'Merriweather', 'Playfair Display', 'Teko',
  ];

  const LOCAL_FONTS = {
    'Brush Script Std':        'fonts/BrushScriptStd.otf',
    'Cooper Black':            'fonts/COOPBL.TTF',
    'Enchanting Celebrations': 'fonts/Enchanting Celebrations.ttf',
    'Milk Choco':              'fonts/Milk Choco.otf',
    'Myriad Pro':              'fonts/MyriadPro-Regular.otf',
  };

  const fontCache = {};

  // Load all Google Fonts via CSS API for picker preview (lightweight — only CSS, fonts load on-demand)
  (function () {
    const families = GOOGLE_FONTS.map(f => 'family=' + f.replace(/ /g, '+')).join('&');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?' + families + '&display=swap';
    document.head.appendChild(link);
  })();

  function createFontPicker(selectEl) {
    selectEl.style.display = 'none';

    const picker = document.createElement('div');
    picker.className = 'font-picker';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'font-picker-btn';
    const preview = document.createElement('span');
    preview.className = 'fp-current';
    const arrow = document.createElement('span');
    arrow.className = 'fp-arrow';
    arrow.textContent = '▾';
    btn.appendChild(preview); btn.appendChild(arrow);
    picker.appendChild(btn);

    const list = document.createElement('div');
    list.className = 'font-picker-list hidden';

    function addGroup(label) {
      const g = document.createElement('div');
      g.className = 'fp-group-label'; g.textContent = label;
      list.appendChild(g);
    }
    function addOption(fontName) {
      const opt = document.createElement('div');
      opt.className = 'fp-option';
      opt.dataset.font = fontName;
      opt.style.fontFamily = "'" + fontName + "', sans-serif";
      opt.textContent = fontName;
      opt.addEventListener('click', () => { setValue(fontName); closeList(); selectEl.dispatchEvent(new Event('change')); });
      list.appendChild(opt);
    }

    addGroup('Google Fonts');
    GOOGLE_FONTS.forEach(addOption);
    addGroup('Fuentes locales');
    Object.keys(LOCAL_FONTS).forEach(addOption);

    picker.appendChild(list);
    selectEl.parentNode.insertBefore(picker, selectEl.nextSibling);

    function setValue(fontName) {
      preview.textContent = fontName;
      preview.style.fontFamily = "'" + fontName + "', sans-serif";
      selectEl.value = fontName;
      list.querySelectorAll('.fp-option').forEach(o =>
        o.classList.toggle('fp-active', o.dataset.font === fontName));
    }
    function openList() {
      list.classList.remove('hidden'); picker.classList.add('open');
      const active = list.querySelector('.fp-active');
      if (active) setTimeout(() => active.scrollIntoView({ block: 'nearest' }), 0);
    }
    function closeList() { list.classList.add('hidden'); picker.classList.remove('open'); }

    btn.addEventListener('click', e => {
      e.stopPropagation();
      picker.classList.contains('open') ? closeList() : openList();
    });
    document.addEventListener('click', e => { if (!picker.contains(e.target)) closeList(); });

    setValue(selectEl.value || GOOGLE_FONTS[0]);
    return { setValue, getValue: () => selectEl.value };
  }

  function populateFontSelect(sel) {
    const gGroup = document.createElement('optgroup');
    gGroup.label = 'Google Fonts';
    GOOGLE_FONTS.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      gGroup.appendChild(opt);
    });
    sel.appendChild(gGroup);

    const lGroup = document.createElement('optgroup');
    lGroup.label = 'Fuentes locales';
    Object.keys(LOCAL_FONTS).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      lGroup.appendChild(opt);
    });
    sel.appendChild(lGroup);
  }

  // Populate sidebar edit panel font selects
  const tgFontSelect = document.getElementById('tg-font');
  populateFontSelect(tgFontSelect);
  const tgFontPicker = createFontPicker(tgFontSelect);

  async function loadGoogleFont(family) {
    if (fontCache[family]) return fontCache[family];

    if (LOCAL_FONTS[family]) {
      const r = await fetch(LOCAL_FONTS[family]);
      if (!r.ok) throw new Error(`No se pudo cargar la fuente local: ${LOCAL_FONTS[family]}`);
      const font = opentype.parse(await r.arrayBuffer());
      fontCache[family] = font;
      return font;
    }

    const pkgId = family.toLowerCase().replace(/\s+/g, '-');
    const urls = [
      `https://cdn.jsdelivr.net/npm/@fontsource/${pkgId}/files/${pkgId}-latin-400-normal.woff`,
      `https://cdn.jsdelivr.net/npm/@fontsource/${pkgId}/files/${pkgId}-400-normal.woff`,
    ];
    let lastErr;
    for (const url of urls) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const font = opentype.parse(await r.arrayBuffer());
        fontCache[family] = font;
        return font;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`Fuente no encontrada: ${family}. ${lastErr?.message ?? ''}`);
  }

  function translatePathD(d, dx, dy) {
    return d.replace(/([MLCQ])((?:[\s,]*-?[\d.]+(?:e[+-]?\d+)?)+)/gi, (_, cmd, rest) => {
      const nums = rest.trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        nums[i] += dx;
        if (i + 1 < nums.length) nums[i + 1] += dy;
      }
      return cmd + nums.map(n => parseFloat(n.toFixed(3))).join(' ');
    });
  }



  function generateTextPaths(font, text, fontSize, centerX, centerY, groupId, groupLabel) {
    const rawPaths = font.getPaths(text, 0, 0, fontSize);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rawPaths.forEach(p => {
      if (!p.commands?.length) return;
      try {
        const bb = p.getBoundingBox();
        if (bb.x2 > bb.x1) {
          minX = Math.min(minX, bb.x1); minY = Math.min(minY, bb.y1);
          maxX = Math.max(maxX, bb.x2); maxY = Math.max(maxY, bb.y2);
        }
      } catch (e) {}
    });
    if (!isFinite(minX)) return null;

    const offsetX = centerX - (minX + maxX) / 2;
    const offsetY = centerY - (minY + maxY) / 2;
    const paths = font.getPaths(text, offsetX, offsetY, fontSize);

    const gEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gEl.setAttribute('data-text-group', groupId);
    svgData.svgEl.appendChild(gEl);

    const newElements = [];
    paths.forEach((p, i) => {
      if (!p.commands?.length) return;
      const pathD = p.toPathData(2);
      if (!pathD?.trim()) return;
      const elemId = `${groupId}_c${i}`;
      const char   = [...text][i] || `_${i}`;

      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', pathD);
      pathEl.setAttribute('fill', '#000000');
      pathEl.setAttribute('fill-rule', 'evenodd');
      pathEl.setAttribute('data-elem-ref', elemId);
      pathEl.classList.add('svg-selectable');
      gEl.appendChild(pathEl);

      pathEl.addEventListener('click', ev => {
        if (view2d.wasDragged) { view2d.wasDragged = false; return; }
        ev.stopPropagation();
        selectElement(elemId, ev.ctrlKey || ev.metaKey);
      });

      newElements.push({
        id: elemId, tag: 'path',
        label: char === ' ' ? '(espacio)' : char,
        pathD, fill: '#000000', hasFill: true,
        stroke: 'none', transform: '',
        groupId, groupLabel, config: null, visible: true,
      });
    });
    return newElements.length ? { elements: newElements, gEl } : null;
  }

  // Ensures a blank SVG canvas exists (called once before adding any element)
  function ensureSVGCanvas() {
    if (svgData) return;
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"></svg>',
      'image/svg+xml'
    );
    svgData = { elements: [], groups: [], svgEl: doc.querySelector('svg'), width: 400, height: 400 };
    svgFilename = 'elementos';
    hasFitCamera = false;
    collapsedGroups.clear();
    elementCount.textContent = '0 elem';
    renderSVG2D();
    buildElementsList();
    initDimensions();
    initThree();
    rebuild3D();
  }

  // ── Confirmation dialog ───────────────────────────────────────────────────
  function showConfirm(message) {
    return new Promise(resolve => {
      const overlay = document.getElementById('confirm-modal');
      document.getElementById('confirm-message').textContent = message;
      overlay.classList.remove('hidden');

      function finish(result) {
        overlay.classList.add('hidden');
        document.getElementById('confirm-ok-btn').removeEventListener('click', onOk);
        document.getElementById('confirm-cancel-btn').removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlay);
        resolve(result);
      }
      function onOk()      { finish(true);  }
      function onCancel()  { finish(false); }
      function onOverlay(e){ if (e.target === overlay) finish(false); }

      document.getElementById('confirm-ok-btn').addEventListener('click', onOk);
      document.getElementById('confirm-cancel-btn').addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlay);
    });
  }

  // Wire up text-group edit panel (sidebar)
  document.getElementById('tg-update-btn').addEventListener('click', updateTextGroupFromPanel);
  document.getElementById('tg-text').addEventListener('keydown', e => { if (e.key === 'Enter') updateTextGroupFromPanel(); });

  async function updateTextGroupFromPanel() {
    if (!currentTextGroupId) return;
    const group = svgData?.groups.find(g => g.id === currentTextGroupId);
    if (!group?.isTextGroup) return;
    const newText   = document.getElementById('tg-text').value.trim();
    const newFamily = document.getElementById('tg-font').value;
    const newSize   = parseFloat(document.getElementById('tg-size').value) || 40;
    if (!newText) return;

    const textChanged = newText !== group.textContent;

    // Confirm only when the actual text content changes (configs will be lost)
    if (textChanged) {
      const ok = await showConfirm('Al cambiar el texto se resetearán las opciones de extrusión configuradas. ¿Continuar?');
      if (!ok) return;
    }

    const btn = document.getElementById('tg-update-btn');
    btn.disabled = true; setStatus('Cargando fuente…');

    let font;
    try { font = await loadGoogleFont(newFamily); }
    catch (err) { setStatus('Error al cargar fuente: ' + err.message); btn.disabled = false; return; }

    // Save existing configs by position (only useful when text hasn't changed)
    const savedConfigs = {};
    if (!textChanged) {
      group.children.forEach((childId, i) => {
        const el = svgData.elements.find(e => e.id === childId);
        if (el?.config) savedConfigs[i] = { ...el.config };
      });
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    group.children.forEach(childId => {
      const el = svgData.elements.find(e => e.id === childId);
      if (!el) return;
      ExtrusionEngine.debugShapes(el.pathD).forEach(sp =>
        sp.pts.forEach(p => {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        })
      );
    });
    const centerX = isFinite(minX) ? (minX + maxX) / 2 : svgData.width  / 2;
    const centerY = isFinite(minY) ? (minY + maxY) / 2 : svgData.height / 2;

    svgData.svgEl.querySelector(`g[data-text-group="${currentTextGroupId}"]`)?.remove();
    svgData.elements = svgData.elements.filter(e => !group.children.includes(e.id));

    const newGroupLabel = `"${newText}"`;
    const result = generateTextPaths(font, newText, newSize, centerX, centerY, currentTextGroupId, newGroupLabel);
    if (!result) { setStatus('Sin paths para el nuevo texto'); btn.disabled = false; return; }

    const { elements: newElements } = result;

    // Restore configs when only font/size changed (same character count maps 1:1 by index)
    if (!textChanged) {
      newElements.forEach((el, i) => {
        if (savedConfigs[i]) el.config = savedConfigs[i];
      });
    }

    group.label = newGroupLabel; group.textContent = newText;
    group.fontFamily = newFamily; group.fontSize = newSize;
    group.children = newElements.map(e => e.id);
    svgData.elements.push(...newElements);

    selectedIds.clear();
    newElements.forEach(e => selectedIds.add(e.id));
    elementCount.textContent = `${svgData.elements.length} elem`;
    buildElementsList(); updateSelectionVisuals(); updatePanel(); rebuild3D();
    setStatus(`Texto actualizado: "${newText}" · ${newElements.length} paths`);
    btn.disabled = false;
  }

  // ── Predefined shapes registry ─────────────────────────────────────────────
  // Each entry: { id, label, icon (SVG string for the card), pathD (centered ~100x100) }
  const PREDEFINED_SHAPES = [
    {
      id: 'square',
      label: 'Cuadrado',
      icon: `<svg width="40" height="40" viewBox="-55 -55 110 110"><rect x="-46" y="-46" width="92" height="92" fill="currentColor"/></svg>`,
      pathD: 'M-46,-46 L46,-46 L46,46 L-46,46 Z',
    },
    {
      id: 'rectangle',
      label: 'Rectángulo',
      icon: `<svg width="40" height="40" viewBox="-55 -35 110 70"><rect x="-48" y="-28" width="96" height="56" fill="currentColor"/></svg>`,
      pathD: 'M-70,-40 L70,-40 L70,40 L-70,40 Z',
    },
    {
      id: 'circle',
      label: 'Círculo',
      icon: `<svg width="40" height="40" viewBox="-55 -55 110 110"><circle cx="0" cy="0" r="48" fill="currentColor"/></svg>`,
      // Approximate circle with 4 cubic beziers
      pathD: (function () {
        const r = 50, k = 0.5522847;
        const c = r * k;
        return `M ${r},0 C ${r},${c} ${c},${r} 0,${r} C ${-c},${r} ${-r},${c} ${-r},0 C ${-r},${-c} ${-c},${-r} 0,${-r} C ${c},${-r} ${r},${-c} ${r},0 Z`;
      })(),
    },
    {
      id: 'triangle',
      label: 'Triángulo',
      icon: `<svg width="40" height="40" viewBox="-55 -55 110 110"><polygon points="0,-48 48,40 -48,40" fill="currentColor"/></svg>`,
      pathD: 'M 0,-58 L 58,46 L -58,46 Z',
    },
    {
      id: 'pentagon',
      label: 'Pentágono',
      icon: `<svg width="40" height="40" viewBox="-55 -55 110 110"><polygon points="0,-48 45.6,-14.9 28.2,39 -28.2,39 -45.6,-14.9" fill="currentColor"/></svg>`,
      pathD: (function () {
        const r = 52, pts = [];
        for (let i = 0; i < 5; i++) {
          const a = (i * 2 * Math.PI / 5) - Math.PI / 2;
          pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
        }
        return 'M ' + pts.join(' L ') + ' Z';
      })(),
    },
    {
      id: 'hexagon',
      label: 'Hexágono',
      icon: `<svg width="40" height="40" viewBox="-55 -55 110 110"><polygon points="25,-43 -25,-43 -50,0 -25,43 25,43 50,0" fill="currentColor"/></svg>`,
      pathD: (function () {
        const r = 52, pts = [];
        for (let i = 0; i < 6; i++) {
          const a = (i * 2 * Math.PI / 6) - Math.PI / 2;
          pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
        }
        return 'M ' + pts.join(' L ') + ' Z';
      })(),
    },
    {
      id: 'star5',
      label: 'Estrella',
      icon: `<svg width="40" height="40" viewBox="-55 -55 110 110"><polygon points="0,-48 11.1,-15.3 46,-15.3 17.6,5.8 28.5,39 0,20.3 -28.5,39 -17.6,5.8 -46,-15.3 -11.1,-15.3" fill="currentColor"/></svg>`,
      pathD: (function () {
        const R = 52, r = 22, pts = [];
        for (let i = 0; i < 10; i++) {
          const a = (i * Math.PI / 5) - Math.PI / 2;
          const rad = i % 2 === 0 ? R : r;
          pts.push(`${(rad * Math.cos(a)).toFixed(2)},${(rad * Math.sin(a)).toFixed(2)}`);
        }
        return 'M ' + pts.join(' L ') + ' Z';
      })(),
    },
    {
      id: 'arrow',
      label: 'Flecha',
      icon: `<svg width="40" height="40" viewBox="-55 -55 110 110"><polygon points="-46,-18 10,-18 10,-40 46,0 10,40 10,18 -46,18" fill="currentColor"/></svg>`,
      pathD: 'M -52,-20 L 8,-20 L 8,-46 L 52,0 L 8,46 L 8,20 L -52,20 Z',
    },
  ];

  // ── Modal logic ────────────────────────────────────────────────────────────
  const modal         = document.getElementById('add-modal');
  const modalTabs     = document.querySelectorAll('.modal-tab');
  const modalPanels   = document.querySelectorAll('.modal-panel');
  const modalApplyBtn = document.getElementById('modal-apply-btn');

  let modalSvgString    = null;
  let modalSvgFname     = 'import';
  let modalSvgAspectRatio = null; // width / height of the imported SVG
  let selectedShapeId   = null;
  let scaleLocked       = true;

  // Populate modal font select
  const modalFontSelect = document.getElementById('modal-font-family');
  populateFontSelect(modalFontSelect);
  const modalFontPicker = createFontPicker(modalFontSelect);

  // Build shape grid
  const shapeGrid = document.getElementById('shape-grid');
  PREDEFINED_SHAPES.forEach(shape => {
    const card = document.createElement('div');
    card.className = 'shape-card';
    card.dataset.shapeId = shape.id;
    card.innerHTML = shape.icon + `<span>${shape.label}</span>`;
    card.addEventListener('click', () => {
      shapeGrid.querySelectorAll('.shape-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedShapeId = shape.id;
    });
    shapeGrid.appendChild(card);
  });

  function openModal() {
    modal.classList.remove('hidden');
    // Reset state
    modalSvgString = null;
    modalSvgAspectRatio = null;
    selectedShapeId = null;
    scaleLocked = true;
    scaleLockBtn.classList.add('active');
    document.getElementById('svg-file-info').classList.add('hidden');
    document.getElementById('svg-drop-zone').classList.remove('hidden');
    document.getElementById('svg-file-name').textContent = '';
    document.getElementById('modal-svg-width').value = '';
    document.getElementById('modal-svg-height').value = '';
    document.getElementById('modal-text-input').value = '';
    shapeGrid.querySelectorAll('.shape-card').forEach(c => c.classList.remove('selected'));
    // Default to first tab
    activateModalTab('svg');
  }

  function closeModal() { modal.classList.add('hidden'); }

  function activateModalTab(tabName) {
    modalTabs.forEach(t => t.classList.toggle('active', t.dataset.modalTab === tabName));
    modalPanels.forEach(p => {
      const name = p.id.replace('modal-panel-', '');
      p.classList.toggle('hidden', name !== tabName);
    });
  }

  document.getElementById('add-element-btn').addEventListener('click', openModal);
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  modalTabs.forEach(tab => {
    tab.addEventListener('click', () => activateModalTab(tab.dataset.modalTab));
  });

  // SVG file input
  const modalSvgInput = document.getElementById('modal-svg-input');
  modalSvgInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setSvgFile(ev.target.result, file.name);
    reader.readAsText(file);
    e.target.value = '';
  });

  // Drag and drop on the drop zone
  const dropZone = document.getElementById('svg-drop-zone');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.svg')) return;
    const reader = new FileReader();
    reader.onload = ev => setSvgFile(ev.target.result, file.name);
    reader.readAsText(file);
  });

  function parseSVGDimensions(svgString) {
    try {
      const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
      const svg = doc.querySelector('svg');
      if (!svg) return null;
      let w = parseFloat(svg.getAttribute('width'));
      let h = parseFloat(svg.getAttribute('height'));
      if (!w || !h) {
        const vb = svg.getAttribute('viewBox');
        if (vb) {
          const parts = vb.trim().split(/[\s,]+/);
          w = parseFloat(parts[2]);
          h = parseFloat(parts[3]);
        }
      }
      return (w > 0 && h > 0) ? { width: w, height: h } : null;
    } catch(e) { return null; }
  }

  function setSvgFile(svgString, filename) {
    modalSvgString = svgString;
    modalSvgFname  = filename.replace(/\.[^.]+$/, '');
    document.getElementById('svg-file-name').textContent = filename;
    document.getElementById('svg-file-info').classList.remove('hidden');
    document.getElementById('svg-drop-zone').classList.add('hidden');

    // Auto-fill dimensions: default 30 mm height, proportional width
    const dims = parseSVGDimensions(svgString);
    const wInput = document.getElementById('modal-svg-width');
    const hInput = document.getElementById('modal-svg-height');
    if (dims) {
      modalSvgAspectRatio = dims.width / dims.height;
      const h = 30;
      hInput.value = h.toFixed(1);
      wInput.value = (h * modalSvgAspectRatio).toFixed(1);
    } else {
      modalSvgAspectRatio = null;
      hInput.value = '30.0';
      wInput.value = '';
    }
  }

  document.getElementById('svg-file-clear').addEventListener('click', () => {
    modalSvgString = null;
    modalSvgAspectRatio = null;
    document.getElementById('svg-file-info').classList.add('hidden');
    document.getElementById('svg-drop-zone').classList.remove('hidden');
    document.getElementById('modal-svg-width').value = '';
    document.getElementById('modal-svg-height').value = '';
  });

  // Scale lock toggle
  const scaleLockBtn = document.getElementById('modal-scale-lock');
  scaleLockBtn.addEventListener('click', () => {
    scaleLocked = !scaleLocked;
    scaleLockBtn.classList.toggle('active', scaleLocked);
  });

  // Proportional linking between width and height inputs
  const modalWInput = document.getElementById('modal-svg-width');
  const modalHInput = document.getElementById('modal-svg-height');

  modalWInput.addEventListener('input', () => {
    if (!scaleLocked) return;
    const ratio = modalSvgAspectRatio || (parseFloat(modalWInput.dataset.prev) / parseFloat(modalHInput.value)) || 1;
    const w = parseFloat(modalWInput.value);
    if (w > 0) modalHInput.value = (w / ratio).toFixed(1);
  });
  modalWInput.addEventListener('focus', () => { modalWInput.dataset.prev = modalWInput.value; });

  modalHInput.addEventListener('input', () => {
    if (!scaleLocked) return;
    const ratio = modalSvgAspectRatio || (parseFloat(modalWInput.value) / parseFloat(modalHInput.dataset.prev)) || 1;
    const h = parseFloat(modalHInput.value);
    if (h > 0) modalWInput.value = (h * ratio).toFixed(1);
  });
  modalHInput.addEventListener('focus', () => { modalHInput.dataset.prev = modalHInput.value; });

  // Apply button
  modalApplyBtn.addEventListener('click', async () => {
    const activeTab = [...modalTabs].find(t => t.classList.contains('active'))?.dataset.modalTab;
    if (activeTab === 'svg')   await applyModalSVG();
    if (activeTab === 'text')  await applyModalText();
    if (activeTab === 'shape') applyModalShape();
  });

  async function applyModalSVG() {
    if (!modalSvgString) { setStatus('Selecciona un archivo SVG'); return; }
    modalApplyBtn.disabled = true;
    try {
      const parsed  = SVGParser.parse(modalSvgString);
      const targetH = parseFloat(document.getElementById('modal-svg-height').value) || 30;
      const targetW = parseFloat(document.getElementById('modal-svg-width').value)  || null;

      ensureSVGCanvas();

      const ns         = `svg_${Date.now()}`;
      const topGroupId = ns;
      const topLabel   = modalSvgFname || 'SVG';

      const importScale = targetW
        ? targetW  / (parsed.width  * globalScale)
        : targetH  / (parsed.height * globalScale);

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      parsed.elements.forEach(el => {
        try {
          ExtrusionEngine.debugShapes(el.pathD).forEach(sp =>
            sp.pts.forEach(p => {
              if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
              if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
            })
          );
        } catch(e) {}
      });
      const srcCX = isFinite(minX) ? (minX + maxX) / 2 : parsed.width  / 2;
      const srcCY = isFinite(minY) ? (minY + maxY) / 2 : parsed.height / 2;
      const dstCX = svgData.width  / 2;
      const dstCY = svgData.height / 2;
      const placeMatrix = [
        importScale, 0, 0, importScale,
        dstCX - srcCX * importScale,
        dstCY - srcCY * importScale,
      ];

      // All DOM paths go inside a single <g> for the whole import
      const topGEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      topGEl.setAttribute('data-svg-group', topGroupId);
      svgData.svgEl.appendChild(topGEl);

      // Map parsed group rawId → namespaced ID
      const gidMap = {};
      parsed.groups.forEach(pg => { gidMap[pg.id] = `${ns}_g_${pg.id}`; });

      // Create svgData group objects for each parsed <g>, in parsed order
      parsed.groups.forEach(pg => {
        const mappedId       = gidMap[pg.id];
        const mappedParentId = pg.parentGroupId ? gidMap[pg.parentGroupId] : topGroupId;
        svgData.groups.push({
          id: mappedId,
          label: pg.label,
          children: [],
          subGroupIds: (pg.childGroupIds || []).map(cid => gidMap[cid]),
          parentGroupId: mappedParentId,
          isTextGroup: false,
          groupType: 'svg',
        });
      });

      // Top-level wrapper group
      svgData.groups.push({
        id: topGroupId, label: topLabel,
        children: [],
        subGroupIds: parsed.groups.filter(pg => !pg.parentGroupId).map(pg => gidMap[pg.id]),
        parentGroupId: null,
        isTextGroup: false,
        groupType: 'svg',
      });

      const newElements = [];
      parsed.elements.forEach((el, i) => {
        const newId  = `${ns}_e${i}`;
        const pathD  = SVGParser.applyMatrixToPathD(el.pathD, placeMatrix);
        const fill   = el.fill === 'none' ? 'none' : (el.fill || '#000000');

        // Determine direct parent group (sub-group or top wrapper)
        const directGroupId = el.groupId ? gidMap[el.groupId] : topGroupId;

        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathEl.setAttribute('d', pathD);
        pathEl.setAttribute('fill', fill);
        pathEl.setAttribute('data-elem-ref', newId);
        pathEl.classList.add('svg-selectable');
        topGEl.appendChild(pathEl);

        pathEl.addEventListener('click', ev => {
          if (view2d.wasDragged) { view2d.wasDragged = false; return; }
          ev.stopPropagation();
          selectElement(newId, ev.ctrlKey || ev.metaKey);
        });

        // Register element in its direct parent group
        const parentGroup = svgData.groups.find(g => g.id === directGroupId);
        if (parentGroup) parentGroup.children.push(newId);

        newElements.push({
          id: newId, tag: el.tag || 'path',
          label: el.label || `path ${i}`,
          pathD, fill,
          hasFill: el.hasFill !== false,
          stroke: el.stroke || 'none',
          transform: '',
          groupId: directGroupId,
          groupLabel: topLabel,
          config: null, visible: true,
        });
      });

      if (!newElements.length) {
        // Roll back groups we just pushed
        svgData.groups = svgData.groups.filter(g =>
          g.id !== topGroupId && !g.id.startsWith(`${ns}_g_`)
        );
        topGEl.remove();
        setStatus('El SVG no contiene elementos válidos');
        modalApplyBtn.disabled = false;
        return;
      }

      svgData.elements.push(...newElements);
      collapsedGroups.add(topGroupId);

      elementCount.textContent = `${svgData.elements.length} elem`;
      buildElementsList();
      rebuild3D();
      setStatus(`SVG importado: "${topLabel}" · ${newElements.length} paths`);
      closeModal();
    } catch (err) {
      setStatus('Error al importar SVG: ' + err.message);
      console.error(err);
    }
    modalApplyBtn.disabled = false;
  }

  async function applyModalText() {
    const text    = document.getElementById('modal-text-input').value.trim();
    const family  = modalFontSelect.value;
    const fontSize = parseFloat(document.getElementById('modal-font-size').value) || 40;
    if (!text) { setStatus('Escribe un texto'); return; }

    modalApplyBtn.disabled = true;
    setStatus('Cargando fuente…');

    let font;
    try { font = await loadGoogleFont(family); }
    catch (err) { setStatus('Error al cargar fuente: ' + err.message); modalApplyBtn.disabled = false; return; }

    ensureSVGCanvas();

    const groupId    = `text_${Date.now()}`;
    const groupLabel = `"${text}"`;
    const result = generateTextPaths(font, text, fontSize, svgData.width / 2, svgData.height / 2, groupId, groupLabel);

    if (!result) { setStatus('Sin paths para este texto'); modalApplyBtn.disabled = false; return; }
    const { elements: newElements } = result;

    svgData.elements.push(...newElements);
    svgData.groups.push({
      id: groupId, label: groupLabel,
      children: newElements.map(e => e.id),
      isTextGroup: true, groupType: 'text', textContent: text, fontFamily: family, fontSize,
    });
    collapsedGroups.add(groupId);

    elementCount.textContent = `${svgData.elements.length} elem`;
    buildElementsList();
    rebuild3D();
    setStatus(`Texto añadido: "${text}" · ${newElements.length} paths`);
    modalApplyBtn.disabled = false;
    closeModal();
  }

  function applyModalShape() {
    if (!selectedShapeId) { setStatus('Selecciona una figura'); return; }
    const shape = PREDEFINED_SHAPES.find(s => s.id === selectedShapeId);
    if (!shape) return;

    ensureSVGCanvas();

    const groupId    = `shape_${Date.now()}`;
    const groupLabel = shape.label;

    // Center shape on canvas
    const cx = svgData.width  / 2;
    const cy = svgData.height / 2;
    const pathD = translatePathD(shape.pathD, cx, cy);

    const gEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gEl.setAttribute('data-shape-group', groupId);
    svgData.svgEl.appendChild(gEl);

    const elemId = `${groupId}_p0`;
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', pathD);
    pathEl.setAttribute('fill', '#000000');
    pathEl.setAttribute('data-elem-ref', elemId);
    pathEl.classList.add('svg-selectable');
    gEl.appendChild(pathEl);

    pathEl.addEventListener('click', ev => {
      if (view2d.wasDragged) { view2d.wasDragged = false; return; }
      ev.stopPropagation();
      selectElement(elemId, ev.ctrlKey || ev.metaKey);
    });

    const newElement = {
      id: elemId, tag: 'path',
      label: shape.label,
      pathD, fill: '#000000', hasFill: true,
      stroke: 'none', transform: '',
      groupId, groupLabel, config: null, visible: true,
    };

    svgData.elements.push(newElement);
    svgData.groups.push({
      id: groupId, label: groupLabel,
      children: [elemId],
      isTextGroup: false, groupType: 'shape',
    });
    collapsedGroups.add(groupId);

    elementCount.textContent = `${svgData.elements.length} elem`;
    buildElementsList();
    rebuild3D();
    setStatus(`Figura añadida: ${shape.label}`);
    closeModal();
  }
})();
