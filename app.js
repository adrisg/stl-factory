/**
 * Main application — wires SVGParser, ExtrusionEngine, STLExporter, Three.js scene.
 */

(function () {
  // ── State ──────────────────────────────────────────────────────────────────
  let svgData = null;        // { elements, groups, svgEl, width, height }
  let svgFilename = 'export'; // base name for STL export
  let selectedIds = new Set(); // element IDs currently selected
  let globalScale = 0.264583; // px → mm
  const collapsedGroups = new Set(); // group IDs collapsed in the list
  let currentTextGroupId = null; // groupId of the text group shown in the edit panel

  // Eye icons (Feather-style SVG)
  const ICO_EYE_OPEN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const ICO_EYE_CLOSED = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  // 2D viewport pan/zoom state
  const view2d = { scale: 1, tx: 0, ty: 0, wasDragged: false };
  let controls2dSetup = false;

  // Three.js
  let renderer, scene, camera, animId;
  let gizmoScene, gizmoCamera;
  let svgPlane = null, svgPlaneVisible = false;
  let meshTransparent = false;
  let orbitStart = null;
  let isDragging = false;
  let theta = 0.4, phi = 1.1, radius = 200;
  let panX = 0, panY = 0, panYW = 0; // panY = world Z, panYW = world Y
  let hasFitCamera = false;   // only auto-fit once per SVG load
  let homeCam = null;         // saved initial camera state


  // ── DOM refs ───────────────────────────────────────────────────────────────
  const svgInput       = document.getElementById('svg-input');
  const elementsList   = document.getElementById('elements-list');
  const selectedPanel  = document.getElementById('selected-panel');
  const selectedName   = document.getElementById('selected-name');
  const applyBtn       = document.getElementById('apply-btn');
  const resetElemBtn   = document.getElementById('reset-element-btn');
  const exportBtn      = document.getElementById('export-btn');
  const resetAllBtn    = document.getElementById('reset-all-btn');
  const statusMsg      = document.getElementById('status-msg');
  const elementCount   = document.getElementById('element-count');
  const dimX           = document.getElementById('dim-x');
  const dimY           = document.getElementById('dim-y');
  const svgContainer   = document.getElementById('svg-container');
  const canvas         = document.getElementById('three-canvas');
  const viewTabs       = document.querySelectorAll('.tab-btn');
  const views          = document.querySelectorAll('.view');
  const extrudeDepth   = document.getElementById('extrude-depth');
  const extrudeOffset  = document.getElementById('extrude-offset');
  const dbgNative      = document.getElementById('dbg-native');
  const dbgEngine      = document.getElementById('dbg-engine');
  const dbgStats       = document.getElementById('debug-stats');
  const dbgPathD       = document.getElementById('debug-path-d');
  const colorInput     = document.getElementById('color-3d');
  const colorFromSvg   = document.getElementById('color-from-svg');

  // ── Tabs ───────────────────────────────────────────────────────────────────
  viewTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      viewTabs.forEach(b => b.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      const viewId = 'view-' + btn.dataset.view;
      document.getElementById(viewId).classList.add('active');
      requestAnimationFrame(() => {
        if (btn.dataset.view === 'split') {
          activateSplitView();
        } else {
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

  // ── File load ──────────────────────────────────────────────────────────────
  svgInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadSVG(ev.target.result, file.name);
    reader.readAsText(file);
  });

  function loadSVG(svgString, filename) {
    try {
      svgData = SVGParser.parse(svgString);
      svgFilename = filename.replace(/\.[^.]+$/, '');
      hasFitCamera = false;
      collapsedGroups.clear();
      svgData.groups.forEach(g => collapsedGroups.add(g.id));
      setStatus(`Cargado: ${filename} — ${svgData.elements.length} elementos`);
      elementCount.textContent = `${svgData.elements.length} elem`;

      renderSVG2D();
      buildElementsList();
      initDimensions();
      initThree();
      rebuild3D();
    } catch (err) {
      setStatus('Error al cargar SVG: ' + err.message);
      console.error(err);
    }
  }

  // ── 2D SVG render ──────────────────────────────────────────────────────────
  function renderSVG2D() {
    const svgEl = svgData.svgEl;
    // Remove explicit size constraints so the SVG is its natural size
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    svgEl.style.width  = svgData.width  + 'px';
    svgEl.style.height = svgData.height + 'px';
    svgEl.style.display = 'block';
    svgEl.style.overflow = 'visible';

    // SVG background click → deselect (ignored if we were panning)
    svgEl.addEventListener('click', () => {
      if (view2d.wasDragged) { view2d.wasDragged = false; return; }
      selectedIds.clear();
      updateSelectionVisuals();
      updatePanel();
    });

    // Wire up every shape that has a data-elem-ref
    svgEl.querySelectorAll('[data-elem-ref]').forEach(shape => {
      shape.classList.add('svg-selectable');
      const refId = shape.getAttribute('data-elem-ref');
      shape.addEventListener('click', ev => {
        if (view2d.wasDragged) { view2d.wasDragged = false; return; }
        ev.stopPropagation();
        selectElement(refId, ev.ctrlKey || ev.metaKey);
      });
    });

    // Wrap SVG in a div that receives the CSS transform
    const wrapper = document.createElement('div');
    wrapper.id = 'svg-wrapper';
    wrapper.appendChild(svgEl);

    const gizmo2d = svgContainer.querySelector('.axis-gizmo-2d');
    while (svgContainer.firstChild) svgContainer.removeChild(svgContainer.firstChild);
    svgContainer.appendChild(wrapper);
    if (gizmo2d) svgContainer.appendChild(gizmo2d);

    // Setup controls once; auto-fit every time a new SVG loads
    if (!controls2dSetup) { setup2DControls(); controls2dSetup = true; }
    // Small delay so the container has its final dimensions
    requestAnimationFrame(autoFit2D);
  }

  function applyTransform2D() {
    const wrapper = document.getElementById('svg-wrapper');
    if (wrapper) wrapper.style.transform =
      `translate(${view2d.tx}px, ${view2d.ty}px) scale(${view2d.scale})`;
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
    let dragging = false;
    let dragStart = {};
    let totalMove = 0;

    svgContainer.addEventListener('mousedown', e => {
      if (e.button !== 0 && e.button !== 1) return;
      if (e.button === 1) e.preventDefault(); // block middle-click scroll
      dragging = true;
      totalMove = 0;
      dragStart = { x: e.clientX, y: e.clientY, tx: view2d.tx, ty: view2d.ty };
      svgContainer.classList.add('grabbing');
    });

    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      totalMove += Math.abs(dx) + Math.abs(dy);
      view2d.tx = dragStart.tx + dx;
      view2d.ty = dragStart.ty + dy;
      applyTransform2D();
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      svgContainer.classList.remove('grabbing');
      // Flag as drag if the pointer moved more than 5px total
      if (totalMove > 5) view2d.wasDragged = true;
    });

    // Zoom centered on cursor
    svgContainer.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = svgContainer.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view2d.tx = mx - (mx - view2d.tx) * factor;
      view2d.ty = my - (my - view2d.ty) * factor;
      view2d.scale = Math.max(0.02, Math.min(100, view2d.scale * factor));
      applyTransform2D();
    }, { passive: false });

    // Double-click → fit to screen
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
    const collapsed = collapsedGroups.has(groupId);
    const btn = document.querySelector(`[data-group-collapse="${groupId}"]`);
    if (btn) btn.textContent = collapsed ? '▶' : '▼';
    document.querySelectorAll(`[data-elem-id]`).forEach(row => {
      const el = svgData?.elements.find(e => e.id === row.dataset.elemId);
      if (el?.groupId === groupId) row.style.display = collapsed ? 'none' : '';
    });
  }

  function buildElementsList() {
    elementsList.innerHTML = '';

    if (!svgData || !svgData.elements.length) {
      elementsList.innerHTML = '<p class="hint">Sin elementos</p>';
      return;
    }

    const groupsRendered = new Set();

    svgData.elements.forEach(el => {
      // ── Group header ──
      if (el.groupId && !groupsRendered.has(el.groupId)) {
        groupsRendered.add(el.groupId);
        const div = document.createElement('div');
        div.className = 'element-item';
        div.dataset.groupId = el.groupId;

        const arrowBtn = document.createElement('button');
        arrowBtn.className = 'collapse-btn';
        arrowBtn.dataset.groupCollapse = el.groupId;
        arrowBtn.textContent = collapsedGroups.has(el.groupId) ? '▶' : '▼';
        arrowBtn.title = 'Expandir / contraer';
        arrowBtn.addEventListener('click', ev => { ev.stopPropagation(); toggleGroupCollapse(el.groupId); });
        div.appendChild(arrowBtn);

        const label = document.createElement('span');
        label.className = 'elem-label';
        label.textContent = el.groupLabel || el.groupId;
        div.appendChild(label);

        const eyeBtn = makeEyeBtn(() => toggleGroupVisibility(el.groupId));
        eyeBtn.dataset.groupEyeId = el.groupId;
        div.appendChild(eyeBtn);

        div.addEventListener('click', ev => selectGroup(el.groupId, ev.ctrlKey || ev.metaKey));
        elementsList.appendChild(div);
      }

      // ── Element row ──
      const div = document.createElement('div');
      div.className = 'element-item' + (el.groupId ? ' indented' : '') + (el.hasFill === false ? ' no-fill-item' : '');
      if (el.groupId && collapsedGroups.has(el.groupId)) div.style.display = 'none';
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

      div.addEventListener('click', ev => selectElement(el.id, ev.ctrlKey || ev.metaKey));
      elementsList.appendChild(div);
    });
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
    const group = svgData?.groups.find(g => g.id === groupId);
    if (!group) return;
    // If any child visible → hide all; else show all
    const anyVisible = group.children.some(id => {
      const e = svgData.elements.find(el => el.id === id);
      return e?.visible !== false;
    });
    group.children.forEach(id => {
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
    if (!groupId) return;
    const group = svgData?.groups.find(g => g.id === groupId);
    if (!group) return;
    const anyVisible = group.children.some(id => {
      const e = svgData.elements.find(el => el.id === id);
      return e?.visible !== false;
    });
    const btn = document.querySelector(`[data-group-eye-id="${groupId}"]`);
    if (!btn) return;
    btn.innerHTML = anyVisible ? ICO_EYE_OPEN : ICO_EYE_CLOSED;
    btn.classList.toggle('eye-off', !anyVisible);
  }

  function fillPanelFromConfig(cfg) {
    extrudeDepth.value = cfg.extrudeUp ?? 0;
    extrudeOffset.value = cfg.extrudeOffset ?? 0;
    colorInput.value = cfg.color3d || '#888888';
  }

  function updateSelectionVisuals() {
    document.querySelectorAll('.element-item').forEach(d => d.classList.remove('selected'));
    document.querySelectorAll('.svg-selectable').forEach(s => {
      s.classList.remove('selected');
      s.classList.remove('text-group-selected');
    });

    let lastListItem = null;
    selectedIds.forEach(id => {
      // List item
      const listItem = document.querySelector(`[data-elem-id="${id}"]`);
      if (listItem) { listItem.classList.add('selected'); lastListItem = listItem; }

      // SVG shape (matched via data-elem-ref set by the parser)
      const svgShape = svgContainer.querySelector(`[data-elem-ref="${id}"]`);
      if (svgShape) svgShape.classList.add('selected');
    });

    // Scroll list to last selected item
    if (lastListItem) lastListItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    // Highlight group header when all its children are selected; mark text groups as draggable
    svgData?.groups.forEach(group => {
      if (group.children.length && group.children.every(id => selectedIds.has(id))) {
        document.querySelector(`[data-group-id="${group.id}"]`)?.classList.add('selected');
        if (group.isTextGroup) {
          group.children.forEach(id => {
            const s = svgContainer.querySelector(`[data-elem-ref="${id}"]`);
            if (s) s.classList.add('text-group-selected');
          });
        }
      }
    });
  }

  function updateDebugPanel(id) {
    const el = svgData?.elements.find(e => e.id === id);
    if (!el || !dbgNative) return;

    const W = dbgNative.width, H = dbgNative.height;
    const PAD = 8;

    // ── 1. Native canvas: let the browser draw the path via Path2D ──
    const ctxN = dbgNative.getContext('2d');
    ctxN.clearRect(0, 0, W, H);

    let p2d;
    try { p2d = new Path2D(el.pathD); } catch(e) { p2d = null; }

    if (p2d) {
      // Measure bounding box via offscreen trick
      const tmp = document.createElement('canvas');
      tmp.width = 2000; tmp.height = 2000;
      const tCtx = tmp.getContext('2d');
      tCtx.beginPath();
      tCtx.addPath(p2d);
      // Use isPointInPath to find rough bbox (expensive but accurate)
      // Instead, use the SVG element's getBBox if available
      const svgShape = svgContainer.querySelector(`[data-elem-ref="${id}"]`);
      let bx = 0, by = 0, bw = 100, bh = 100;
      if (svgShape && svgShape.getBBox) {
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

    // ── 2. Engine canvas: sampled points from our parser ──
    const ctxE = dbgEngine.getContext('2d');
    ctxE.clearRect(0, 0, W, H);

    const subpaths = ExtrusionEngine.debugShapes(el.pathD);

    if (subpaths.length) {
      // Compute bbox of all points
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      subpaths.forEach(sp => sp.pts.forEach(p => {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }));
      const bw = (maxX - minX) || 1, bh = (maxY - minY) || 1;
      const scaleF = Math.min((W - PAD*2) / bw, (H - PAD*2) / bh);

      // Color-code subpaths: first = fill, rest = holes
      const colors = ['#4fc3f7', '#ef9a9a', '#a5d6a7', '#fff176', '#ce93d8'];

      subpaths.forEach((sp, si) => {
        ctxE.beginPath();
        sp.pts.forEach((p, i) => {
          const sx = (p.x - minX) * scaleF + PAD;
          const sy = (p.y - minY) * scaleF + PAD;
          i === 0 ? ctxE.moveTo(sx, sy) : ctxE.lineTo(sx, sy);
        });
        if (sp.closed) ctxE.closePath();
        ctxE.fillStyle = colors[si % colors.length] + '44';
        ctxE.fill('evenodd');
        ctxE.strokeStyle = colors[si % colors.length];
        ctxE.lineWidth = 1.5;
        ctxE.stroke();

        // Draw start point
        if (sp.pts.length) {
          const p0x = (sp.pts[0].x - minX) * scaleF + PAD;
          const p0y = (sp.pts[0].y - minY) * scaleF + PAD;
          ctxE.fillStyle = colors[si % colors.length];
          ctxE.beginPath();
          ctxE.arc(p0x, p0y, 3, 0, Math.PI*2);
          ctxE.fill();
        }
      });
    } else {
      ctxE.fillStyle = '#e94560';
      ctxE.font = '11px sans-serif';
      ctxE.fillText('Sin puntos', 4, 20);
    }

    // ── Stats ──
    const totalPts = subpaths.reduce((s, sp) => s + sp.pts.length, 0);
    const closedCount = subpaths.filter(sp => sp.closed).length;
    dbgStats.innerHTML =
      `<span class="dbg-tag">Subpaths: ${subpaths.length}</span>` +
      `<span class="dbg-tag">Pts: ${totalPts}</span>` +
      `<span class="dbg-tag ${closedCount < subpaths.length ? 'dbg-warn' : ''}">Cerrados: ${closedCount}/${subpaths.length}</span>`;

    // ── Raw path D ──
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

    // Check if a complete group (text or not) is selected
    const matchedGroup = svgData?.groups.find(g =>
      g.children.length > 0 &&
      g.children.length === selectedIds.size &&
      g.children.every(id => selectedIds.has(id))
    );

    if (matchedGroup?.isTextGroup) {
      currentTextGroupId = matchedGroup.id;
      document.getElementById('tg-text').value = matchedGroup.textContent || '';
      document.getElementById('tg-font').value = matchedGroup.fontFamily || GOOGLE_FONTS[0];
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
      if (document.getElementById('debug-details')?.open) updateDebugPanel(id);
      // single element of a text group: also show edit panel if group is fully selected
      if (!matchedGroup?.isTextGroup && el?.groupId) {
        const grp = svgData.groups.find(g => g.id === el.groupId && g.isTextGroup &&
          g.children.every(cid => selectedIds.has(cid)));
        if (grp) {
          currentTextGroupId = grp.id;
          document.getElementById('tg-text').value = grp.textContent || '';
          document.getElementById('tg-font').value = grp.fontFamily || GOOGLE_FONTS[0];
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
    if (!ctrlKey) {
      selectedIds.clear();
      selectedIds.add(id);
    } else {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
    }
    updateSelectionVisuals();
    updatePanel();
  }

  function selectGroup(groupId, ctrlKey = false) {
    const group = svgData?.groups.find(g => g.id === groupId);
    if (!group) return;

    if (!ctrlKey) {
      selectedIds.clear();
      group.children.forEach(id => selectedIds.add(id));
    } else {
      const allSelected = group.children.every(id => selectedIds.has(id));
      if (allSelected) group.children.forEach(id => selectedIds.delete(id));
      else group.children.forEach(id => selectedIds.add(id));
    }
    updateSelectionVisuals();
    updatePanel();
  }

  // ── Controls logic ─────────────────────────────────────────────────────────

  // Adjusts globalScale so all configured elements fill the target Y (dimY).
  // Uses path-space coords (scale=1) to avoid getBBox failures on hidden elements.
  function rescaleToConfigured() {
    const configured = svgData.elements.filter(el => el.config);
    if (!configured.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    configured.forEach(el => {
      const subpaths = ExtrusionEngine.debugShapes(el.pathD);
      subpaths.forEach(sp => sp.pts.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }));
    });
    if (!isFinite(minX) || maxY <= minY) return;

    const targetY = parseFloat(dimY.value) || 30;
    globalScale = targetY / (maxY - minY);
    const newX = ((maxX - minX) * globalScale).toFixed(2);
    dimX.value = newX;
    dimX.dataset.base = newX;
    dimY.dataset.base = String(targetY);
  }

  applyBtn.addEventListener('click', () => {
    if (!svgData || selectedIds.size === 0) return;

    const cfg = {
      extrudeUp:     parseFloat(extrudeDepth.value) || 0,
      extrudeOffset: parseFloat(extrudeOffset.value) || 0,
      scaleX:        1,
      scaleY:        1,
      color3d:       colorInput.value,
    };

    selectedIds.forEach(id => {
      const el = svgData.elements.find(e => e.id === id);
      if (el) {
        el.config = { ...cfg };
        document.querySelector(`[data-elem-id="${id}"]`)?.classList.add('configured');
      }
    });

    // Mark group headers whose children are all configured
    svgData.groups.forEach(group => {
      if (group.children.every(id => svgData.elements.find(e => e.id === id)?.config)) {
        document.querySelector(`[data-group-id="${group.id}"]`)?.classList.add('configured');
      }
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
      }
    });
    // Unmark group headers
    svgData.groups.forEach(group => {
      if (group.children.some(id => selectedIds.has(id))) {
        document.querySelector(`[data-group-id="${group.id}"]`)?.classList.remove('configured');
      }
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

  // Live color preview: update material without rebuilding geometry
  colorInput.addEventListener('input', () => {
    if (!scene || selectedIds.size === 0) return;
    const hex = parseInt(colorInput.value.slice(1), 16);
    scene.traverse(obj => {
      if (!obj.isMesh) return;
      const elemId = obj.parent?.userData.elementId;
      if (selectedIds.has(elemId)) obj.material.color.setHex(hex);
    });
    render3D();
  });

  // "SVG" button: fill picker with this element's SVG fill color
  colorFromSvg.addEventListener('click', () => {
    const id = [...selectedIds][0];
    if (!id) return;
    const el = svgData?.elements.find(e => e.id === id);
    if (!el || !el.hasFill || el.fill === 'none') return;
    const hex = cssColorToHex6(el.fill);
    if (hex) {
      colorInput.value = hex;
      colorInput.dispatchEvent(new Event('input'));
    }
  });

  function cssColorToHex6(color) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  document.getElementById('debug-details')?.addEventListener('toggle', ev => {
    if (ev.target.open && selectedIds.size === 1) {
      updateDebugPanel([...selectedIds][0]);
    }
  });

  function initDimensions() {
    globalScale = 30 / svgData.height;
    const w = (svgData.width * globalScale).toFixed(2);
    const h = (30).toFixed(2);
    dimX.value = w;
    dimY.value = h;
    dimX.dataset.base = w;
    dimY.dataset.base = h;
    dimX.disabled = false;
    dimY.disabled = false;
  }

  // Live proportional preview — no rebuild, just update the linked field
  dimX.addEventListener('input', () => {
    const newX = parseFloat(dimX.value);
    const baseX = parseFloat(dimX.dataset.base);
    if (!newX || !baseX) return;
    dimY.value = (parseFloat(dimY.dataset.base) * newX / baseX).toFixed(2);
  });

  // Apply on Enter / blur — update base so next edit is relative to the new size
  dimX.addEventListener('change', () => {
    const newX = parseFloat(dimX.value);
    const baseX = parseFloat(dimX.dataset.base);
    if (!newX || !baseX || !svgData) return;
    globalScale *= newX / baseX;
    dimX.dataset.base = dimX.value;
    dimY.dataset.base = dimY.value;
    rebuild3D();
  });

  dimY.addEventListener('input', () => {
    const newY = parseFloat(dimY.value);
    const baseZ = parseFloat(dimY.dataset.base);
    if (!newY || !baseZ) return;
    dimX.value = (parseFloat(dimX.dataset.base) * newY / baseZ).toFixed(2);
  });

  dimY.addEventListener('change', () => {
    const newY = parseFloat(dimY.value);
    const baseZ = parseFloat(dimY.dataset.base);
    if (!newY || !baseZ || !svgData) return;
    globalScale *= newY / baseZ;
    dimX.dataset.base = dimX.value;
    dimY.dataset.base = dimY.value;
    rebuild3D();
  });

  const meshTransparentBtn = document.getElementById('mesh-transparent-btn');
  meshTransparentBtn.addEventListener('click', () => {
    meshTransparent = !meshTransparent;
    meshTransparentBtn.classList.toggle('active', meshTransparent);
    applyMeshTransparency(meshTransparent);
  });

  const svgPlaneBtn = document.getElementById('svg-plane-btn');
  svgPlaneBtn.addEventListener('click', () => {
    svgPlaneVisible = !svgPlaneVisible;
    svgPlaneBtn.classList.toggle('active', svgPlaneVisible);
    if (svgPlane) { svgPlane.visible = svgPlaneVisible; render3D(); }
  });

  document.getElementById('home-btn').addEventListener('click', () => {
    if (!homeCam) return;
    ({ radius, theta, phi, panX, panY, panYW } = homeCam);
    updateCameraPosition();
    render3D();
  });

  exportBtn.addEventListener('click', () => {
    if (!scene) return;
    setStatus('Exportando STL…');
    setTimeout(() => {
      try {
        const buf = STLExporter.export3D(scene);
        STLExporter.download(buf, svgFilename + '.stl');
        setStatus('STL exportado');
      } catch (err) {
        setStatus('Error al exportar: ' + err.message);
        console.error(err);
      }
    }, 50);
  });

  // ── Split divider drag ─────────────────────────────────────────────────────
  (function () {
    const divider = document.getElementById('split-divider');
    const pane1   = document.getElementById('split-2d');
    const pane2   = document.getElementById('split-3d');
    let dragging  = false;

    divider.addEventListener('mousedown', e => {
      e.preventDefault();
      dragging = true;
      divider.classList.add('dragging');
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const rect  = document.getElementById('view-split').getBoundingClientRect();
      const minPx = 80, maxPx = rect.width - 80;
      const x     = Math.max(minPx, Math.min(maxPx, e.clientX - rect.left));
      pane1.style.flex = `0 0 ${x}px`;
      pane2.style.flex = '1';
      syncSplitCanvas();
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('dragging');
      document.body.style.userSelect = '';
      syncSplitCanvas();
    });

    // Double-click divider → reset to 50/50
    divider.addEventListener('dblclick', () => {
      pane1.style.flex = '';
      pane2.style.flex = '';
      syncSplitCanvas();
    });

    function syncSplitCanvas() {
      if (!renderer || !camera) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render3D();
    }
  })();

  // ── Three.js ───────────────────────────────────────────────────────────────
  function initThree() {
    if (renderer) return; // already initialized

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x0a0a1a);

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 10000);
    updateCameraPosition();

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(100, 200, 150);
    scene.add(dirLight);
    const dirLight2 = new THREE.DirectionalLight(0x8888ff, 0.3);
    dirLight2.position.set(-100, -50, -100);
    scene.add(dirLight2);

    // Grid
    const grid = new THREE.GridHelper(400, 40, 0x222244, 0x111133);
    grid.position.y = -0.5;
    scene.add(grid);

    setupOrbitControls();
    setupGizmo3D();
    resizeRenderer();
    window.addEventListener('resize', resizeRenderer);
    animate();
  }

  function setupGizmo3D() {
    gizmoScene = new THREE.Scene();
    gizmoCamera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 100);

    const geo = new THREE.BoxGeometry(1.1, 1.1, 1.1);
    const mats = [
      new THREE.MeshPhongMaterial({ color: 0xcc3333 }), // +X
      new THREE.MeshPhongMaterial({ color: 0x661a1a }), // -X
      new THREE.MeshPhongMaterial({ color: 0x33aa55 }), // +Y
      new THREE.MeshPhongMaterial({ color: 0x1a5530 }), // -Y
      new THREE.MeshPhongMaterial({ color: 0x3355cc }), // +Z
      new THREE.MeshPhongMaterial({ color: 0x1a2866 }), // -Z
    ];
    gizmoScene.add(new THREE.Mesh(geo, mats));

    const edges = new THREE.EdgesGeometry(geo);
    gizmoScene.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })));

    gizmoScene.add(new THREE.AxesHelper(1.55));

    gizmoScene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const dl = new THREE.DirectionalLight(0xffffff, 0.55);
    dl.position.set(2, 3, 4);
    gizmoScene.add(dl);
  }

  function renderGizmo3D() {
    if (!gizmoScene || !gizmoCamera || !renderer || !camera) return;
    const sz = 64;
    const pad = 8; // padding inside background div
    const off = 10 + pad; // bg starts at 10px, gizmo is inset by pad
    const target = new THREE.Vector3(panX, panYW, panY);
    const dir = camera.position.clone().sub(target).normalize().multiplyScalar(5);
    gizmoCamera.position.copy(dir);
    gizmoCamera.lookAt(0, 0, 0);

    const bgOff = 10;
    const bgSz  = sz + pad * 2; // full background area including padding

    renderer.autoClear = false;

    // Clear the entire background area (including padding) to transparent
    // so the CSS div rounded corners show through the canvas
    renderer.setScissor(bgOff, bgOff, bgSz, bgSz);
    renderer.setScissorTest(true);
    renderer.setClearColor(0x000000, 0.0);
    renderer.clearColor();

    // Render gizmo in the inner viewport only
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
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function setupOrbitControls() {
    window.addEventListener('mouseup', () => isDragging = false);
    window.addEventListener('mousemove', e => {
      if (!isDragging || !orbitStart) return;
      const dx = e.clientX - orbitStart.x;
      const dy = e.clientY - orbitStart.y;
      if (orbitStart.button === 0) {
        theta = orbitStart.theta - dx * 0.01;
        phi   = Math.max(0.1, Math.min(Math.PI - 0.1, orbitStart.phi - dy * 0.01));
      } else if (orbitStart.button === 2) {
        const sc = 0.3;
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        const sinP = Math.sin(phi),   cosP = Math.cos(phi);
        panX  = orbitStart.panX  + (-dx * cosT      - dy * cosP * sinT) * sc;
        panYW = orbitStart.panYW + ( dy * sinP                         ) * sc;
        panY  = orbitStart.panY  + ( dx * sinT      - dy * cosP * cosT) * sc;
      }
      updateCameraPosition();
      render3D();
    });
    addOrbitCanvas(canvas);
  }

  function addOrbitCanvas(cvs) {
    cvs.addEventListener('mousedown', e => {
      isDragging = true;
      orbitStart = { x: e.clientX, y: e.clientY, theta, phi, panX, panY, panYW, button: e.button };
    });
    cvs.addEventListener('wheel', e => {
      radius = Math.max(10, Math.min(2000, radius + e.deltaY * 0.3));
      updateCameraPosition();
      render3D();
    });
    cvs.addEventListener('contextmenu', e => e.preventDefault());
  }

  function updateCameraPosition() {
    if (!camera) return;
    const x = radius * Math.sin(phi) * Math.sin(theta) + panX;
    const y = radius * Math.cos(phi) + panYW;
    const z = radius * Math.sin(phi) * Math.cos(theta) + panY;
    camera.position.set(x, y, z);
    camera.lookAt(panX, panYW, panY);
  }

  let needsRender = false;
  function render3D() { needsRender = true; }

  function animate() {
    animId = requestAnimationFrame(animate);
    if (needsRender) {
      if (renderer && scene && camera) {
        renderer.render(scene, camera);
        renderGizmo3D();
      }
      needsRender = false;
    }
  }

  // ── Split view ──────────────────────────────────────────────────────────────
  // Move the real #svg-container and #three-viewport into the split panes so
  // both sides stay in sync with the main views automatically.

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
      // Clone and force explicit pixel dimensions so the browser renders at full size
      const clone = svgEl.cloneNode(true);
      clone.setAttribute('width',  svgW);
      clone.setAttribute('height', svgH);
      clone.style.width  = '';
      clone.style.height = '';
      const str  = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([str], { type: 'image/svg+xml;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        const max = 4096;
        const sc  = Math.min(1, max / Math.max(svgW, svgH));
        const cw  = Math.round(svgW * sc);
        const ch  = Math.round(svgH * sc);
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

    // Remove previous pivot (and all its children)
    const toRemove = [];
    scene.children.forEach(obj => { if (obj.userData.isPivot) toRemove.push(obj); });
    toRemove.forEach(obj => scene.remove(obj));

    // Explicitly configured elements always render (user chose them intentionally).
    // The auto-fallback only picks filled, visible elements.
    const configured = svgData.elements.filter(el => el.config);
    const toProcess  = configured.length
      ? configured
      : svgData.elements.filter(el => el.visible !== false && el.hasFill !== false).slice(0, 1);

    const pivot = new THREE.Group();
    pivot.userData.isPivot = true;
    let meshCount = 0;

    for (const el of toProcess) {
      if (el.visible === false) continue;
      // Skip transparent elements unless the user explicitly configured them
      if (el.hasFill === false && !el.config) continue;

      // Use assigned config or a non-mutating default
      const cfg = el.config || { extrudeUp: 0, scaleX: 1, scaleY: 1 };
      const elWithCfg = el.config ? el : { ...el, config: cfg };

      try {
        const group = ExtrusionEngine.buildMesh(elWithCfg, globalScale);
        if (group) { pivot.add(group); meshCount++; }
      } catch (err) {
        console.warn(`Error al extruir ${el.id}:`, err);
      }
    }

    // SVG reference plane — always present regardless of mesh count
    const planeW = svgData.width  * globalScale;
    const planeH = svgData.height * globalScale;
    const pMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false,
    });
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
      // Center pivot on meshes (X/Z centered, Y base at ground)
      pivot.updateMatrixWorld(true);
      const meshBox = new THREE.Box3();
      pivot.children.forEach(obj => { if (obj !== pMesh) meshBox.expandByObject(obj); });
      const meshCenter = meshBox.getCenter(new THREE.Vector3());
      pivot.position.set(-meshCenter.x, -meshBox.min.y, -meshCenter.z);
      pMesh.position.set(planeW / 2, -0.02, planeH / 2);


      // Only fit camera on first build after loading a new SVG
      if (!hasFitCamera) {
        const size = meshBox.getSize(new THREE.Vector3());
        radius = Math.max(size.x, size.y, size.z) * 2.5;
        panX = 0; panY = 0; panYW = 0; phi = 1.0; theta = 0.4;
        updateCameraPosition();
        homeCam = { radius, theta, phi, panX, panY, panYW };
        hasFitCamera = true;
      }
    } else {
      // No meshes: center plane on origin and fit camera to it
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

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setStatus(msg) { statusMsg.textContent = msg; }

  // Ensure disabled number inputs don't show browser-default "0" before any SVG is loaded
  dimX.value = '';
  dimY.value = '';

  // ── Text tool ─────────────────────────────────────────────────────────────

  const GOOGLE_FONTS = [
    'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Oswald',
    'Raleway', 'Ubuntu', 'Nunito', 'Poppins', 'Inter',
    'Bebas Neue', 'Anton', 'Merriweather', 'Playfair Display', 'Teko',
  ];

  const fontCache = {};
  const fontFamilySelect = document.getElementById('font-family');
  const tgFontSelect     = document.getElementById('tg-font');
  GOOGLE_FONTS.forEach(f => {
    [fontFamilySelect, tgFontSelect].forEach(sel => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      sel.appendChild(opt);
    });
  });

  async function loadGoogleFont(family) {
    if (fontCache[family]) return fontCache[family];
    const pkgId = family.toLowerCase().replace(/\s+/g, '-');
    // fontsource CDN serves WOFF (not WOFF2), which opentype.js supports without Brotli decompressor
    const urls = [
      `https://cdn.jsdelivr.net/npm/@fontsource/${pkgId}/files/${pkgId}-latin-400-normal.woff`,
      `https://cdn.jsdelivr.net/npm/@fontsource/${pkgId}/files/${pkgId}-400-normal.woff`,
    ];
    let lastErr;
    for (const url of urls) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buffer = await r.arrayBuffer();
        const font = opentype.parse(buffer);
        fontCache[family] = font;
        return font;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`Fuente no encontrada: ${family}. ${lastErr?.message ?? ''}`);
  }

  // Translates all absolute coordinates in an SVG path d string by (dx, dy).
  // opentype.js only emits M, L, C, Q, Z (all absolute), so pairs of numbers
  // after a command letter are always (x, y) pairs.
  function translatePathD(d, dx, dy) {
    return d.replace(/([MLCQ])((?:[\s,]*-?[\d.]+(?:e[+-]?\d+)?)+)/gi, (_, cmd, rest) => {
      const nums = rest.trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        nums[i]   += dx;
        if (i + 1 < nums.length) nums[i + 1] += dy;
      }
      return cmd + nums.map(n => parseFloat(n.toFixed(3))).join(' ');
    });
  }

  // Starts a drag-to-move operation for a text group.
  // gEl: the <g> SVG element wrapping the group's paths.
  function startGroupMove(groupId, gEl, ev) {
    const startX = ev.clientX, startY = ev.clientY;

    function onMove(e) {
      const dx = (e.clientX - startX) / view2d.scale;
      const dy = (e.clientY - startY) / view2d.scale;
      gEl.setAttribute('transform', `translate(${dx},${dy})`);
    }

    function onUp(e) {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const dx = (e.clientX - startX) / view2d.scale;
      const dy = (e.clientY - startY) / view2d.scale;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        // Bake translation into each element's pathD
        const group = svgData?.groups.find(g => g.id === groupId);
        group?.children.forEach(childId => {
          const el = svgData.elements.find(e => e.id === childId);
          if (!el) return;
          el.pathD = translatePathD(el.pathD, dx, dy);
          const domPath = svgData.svgEl.querySelector(`[data-elem-ref="${childId}"]`);
          if (domPath) domPath.setAttribute('d', el.pathD);
        });
        gEl.setAttribute('transform', 'translate(0,0)');
        rebuild3D();
      }
      view2d.wasDragged = true;
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Creates path DOM elements and element data objects for a text string.
  // Paths are centered at (centerX, centerY) in SVG coordinates.
  // Returns { elements, gEl }.
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
      pathEl.setAttribute('data-elem-ref', elemId);
      pathEl.classList.add('svg-selectable');
      gEl.appendChild(pathEl);

      pathEl.addEventListener('click', ev => {
        if (view2d.wasDragged) { view2d.wasDragged = false; return; }
        ev.stopPropagation();
        selectElement(elemId, ev.ctrlKey || ev.metaKey);
      });

      pathEl.addEventListener('mousedown', ev => {
        const grp = svgData?.groups.find(g => g.id === groupId);
        if (!grp?.isTextGroup) return;
        if (!grp.children.every(id => selectedIds.has(id))) return;
        ev.stopPropagation(); // prevent canvas pan
        startGroupMove(groupId, gEl, ev);
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

  function ensureSVGCanvas() {
    if (svgData) return;
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120" viewBox="0 0 400 120"></svg>',
      'image/svg+xml'
    );
    svgData = { elements: [], groups: [], svgEl: doc.querySelector('svg'), width: 400, height: 120 };
    svgFilename = 'texto';
    hasFitCamera = false;
    collapsedGroups.clear();
    elementCount.textContent = '0 elem';
    renderSVG2D();
    buildElementsList();
    initDimensions();
    initThree();
    rebuild3D();
  }

  async function addTextToSVG() {
    const text = document.getElementById('text-input').value.trim();
    const family = fontFamilySelect.value;
    const fontSize = parseFloat(document.getElementById('font-size').value) || 40;
    if (!text) return;

    const addBtn = document.getElementById('add-text-btn');
    addBtn.disabled = true;
    setStatus('Cargando fuente…');

    let font;
    try {
      font = await loadGoogleFont(family);
    } catch (err) {
      setStatus('Error al cargar fuente: ' + err.message);
      addBtn.disabled = false;
      return;
    }

    ensureSVGCanvas();

    const groupId    = `text_${Date.now()}`;
    const groupLabel = `"${text}"`;
    const result = generateTextPaths(font, text, fontSize,
      svgData.width / 2, svgData.height / 2, groupId, groupLabel);

    if (!result) { setStatus('Sin paths para este texto'); addBtn.disabled = false; return; }
    const { elements: newElements } = result;

    svgData.elements.push(...newElements);
    svgData.groups.push({
      id: groupId, label: groupLabel,
      children: newElements.map(e => e.id),
      isTextGroup: true, textContent: text, fontFamily: family, fontSize,
    });
    collapsedGroups.add(groupId);

    elementCount.textContent = `${svgData.elements.length} elem`;
    buildElementsList();
    rebuild3D();
    document.getElementById('text-input').value = '';
    setStatus(`Texto añadido: "${text}" · ${newElements.length} paths`);
    addBtn.disabled = false;
  }

  async function updateTextGroupFromPanel() {
    if (!currentTextGroupId) return;
    const group = svgData?.groups.find(g => g.id === currentTextGroupId);
    if (!group?.isTextGroup) return;

    const newText   = document.getElementById('tg-text').value.trim();
    const newFamily = document.getElementById('tg-font').value;
    const newSize   = parseFloat(document.getElementById('tg-size').value) || 40;
    if (!newText) return;

    const btn = document.getElementById('tg-update-btn');
    btn.disabled = true;
    setStatus('Cargando fuente…');

    let font;
    try {
      font = await loadGoogleFont(newFamily);
    } catch (err) {
      setStatus('Error al cargar fuente: ' + err.message);
      btn.disabled = false;
      return;
    }

    // Compute current center of the group from its paths' bboxes
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

    // Remove old <g> wrapper and its paths from DOM
    svgData.svgEl.querySelector(`g[data-text-group="${currentTextGroupId}"]`)?.remove();
    // Remove old elements from data
    svgData.elements = svgData.elements.filter(e => !group.children.includes(e.id));

    // Generate new paths centered at the same position
    const newGroupLabel = `"${newText}"`;
    const result = generateTextPaths(font, newText, newSize,
      centerX, centerY, currentTextGroupId, newGroupLabel);

    if (!result) {
      setStatus('Sin paths para el nuevo texto');
      btn.disabled = false;
      return;
    }
    const { elements: newElements } = result;

    // Update group metadata and children
    group.label       = newGroupLabel;
    group.textContent = newText;
    group.fontFamily  = newFamily;
    group.fontSize    = newSize;
    group.children    = newElements.map(e => e.id);

    svgData.elements.push(...newElements);

    // Keep the group selected
    selectedIds.clear();
    newElements.forEach(e => selectedIds.add(e.id));

    elementCount.textContent = `${svgData.elements.length} elem`;
    buildElementsList();
    updateSelectionVisuals();
    updatePanel();
    rebuild3D();
    setStatus(`Texto actualizado: "${newText}" · ${newElements.length} paths`);
    btn.disabled = false;
  }

  document.getElementById('add-text-btn').addEventListener('click', addTextToSVG);
  document.getElementById('text-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addTextToSVG();
  });
  document.getElementById('tg-update-btn').addEventListener('click', updateTextGroupFromPanel);
  document.getElementById('tg-text').addEventListener('keydown', e => {
    if (e.key === 'Enter') updateTextGroupFromPanel();
  });
})();
