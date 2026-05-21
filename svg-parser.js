/**
 * SVG Parser — extracts paths/shapes from an SVG document.
 * Group transforms are accumulated and baked into path coordinates,
 * so callers receive clean absolute-coordinate pathD strings.
 */

const SVGParser = (() => {

  const SHAPE_TAGS = new Set(['path','rect','circle','ellipse','polygon','polyline','line']);
  const IDENTITY   = [1, 0, 0, 1, 0, 0]; // [a, b, c, d, e, f]

  // ── Public: parse ────────────────────────────────────────────────────────

  function parse(svgString) {
    const doc   = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (!svgEl) throw new Error('SVG inválido');

    const viewBox = svgEl.getAttribute('viewBox');
    const width   = parseFloat(svgEl.getAttribute('width'))
                 || (viewBox ? parseFloat(viewBox.split(/[\s,]+/)[2]) : 100);
    const height  = parseFloat(svgEl.getAttribute('height'))
                 || (viewBox ? parseFloat(viewBox.split(/[\s,]+/)[3]) : 100);

    // Adopt SVG into main document so getComputedStyle works (handles CSS classes, <style> blocks, etc.)
    const tempDiv = document.createElement('div');
    tempDiv.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;';
    document.body.appendChild(tempDiv);
    tempDiv.appendChild(document.adoptNode(svgEl));

    const elements  = [];
    const groupsMap = {};   // rawId → { id, label, parentGroupId, childGroupIds }
    let idCounter   = 0;

    // groupStack: array of group raw IDs (innermost last)
    // inh: { fill, opacity } — cascaded from ancestor elements
    function walkNode(node, groupStack, ctm, inh) {
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();

      const localTf  = node.getAttribute('transform');
      const localMat = localTf ? parseTransformMatrix(localTf) : null;
      const matrix   = localMat ? multiplyMatrix(ctm, localMat) : ctm;

      // Compute what children of this node will inherit
      const ownFill    = getStyle(node, 'fill');
      const ownOpacity = parseFloat(getStyle(node, 'opacity') || '1');
      const childInh   = {
        fill:    ownFill !== null ? ownFill : inh.fill,
        opacity: inh.opacity * ownOpacity,
      };

      if (tag === 'g') {
        const rawId = node.getAttribute('id')
                   || node.getAttribute('inkscape:label')
                   || `group_${idCounter++}`;
        const label = node.getAttribute('inkscape:label')
                   || node.getAttribute('id')
                   || rawId;
        const parentId = groupStack.length > 0 ? groupStack[groupStack.length - 1] : null;

        groupsMap[rawId] = { id: rawId, label, parentGroupId: parentId, childGroupIds: [] };
        if (parentId && groupsMap[parentId]) {
          groupsMap[parentId].childGroupIds.push(rawId);
        }

        groupStack.push(rawId);
        Array.from(node.childNodes).forEach(c => walkNode(c, groupStack, matrix, childInh));
        groupStack.pop();
        return;
      }

      if (SHAPE_TAGS.has(tag)) {
        const elemId = node.getAttribute('id') || `${tag}_${idCounter++}`;
        let pathD    = shapeToPathD(node);
        if (!pathD) return;

        const isIdentity =
          matrix[0] === 1 && matrix[1] === 0 &&
          matrix[2] === 0 && matrix[3] === 1 &&
          matrix[4] === 0 && matrix[5] === 0;
        if (!isIdentity) pathD = applyMatrixToPathD(pathD, matrix);

        // Resolve fill: use getComputedStyle first (handles CSS classes, <style> blocks,
        // and SVG fill inheritance automatically), then fall back to attribute/inh.fill.
        let fillRaw;
        try {
          fillRaw = window.getComputedStyle(node).getPropertyValue('fill') || null;
        } catch(e) { fillRaw = null; }
        if (!fillRaw) fillRaw = getStyle(node, 'fill') ?? inh.fill;

        const fillOpacity = parseFloat(getStyle(node, 'fill-opacity') || '1');
        const effectiveOp = inh.opacity * ownOpacity;
        const stroke      = getStyle(node, 'stroke') || 'none';

        const hasFill = fillRaw !== 'none'
                     && fillRaw !== 'transparent'
                     && fillOpacity > 0.01
                     && effectiveOp > 0.01;
        const fill = hasFill ? (fillRaw || 'black') : 'none';

        const directGroupId = groupStack.length > 0 ? groupStack[groupStack.length - 1] : null;

        node.setAttribute('data-elem-ref', elemId);

        elements.push({
          id: elemId, tag,
          label: elemId,
          pathD, fill, hasFill, stroke,
          transform: '',
          groupId:    directGroupId,
          groupLabel: directGroupId ? (groupsMap[directGroupId]?.label ?? directGroupId) : null,
          config: null, visible: true,
        });
      }
    }

    Array.from(svgEl.childNodes).forEach(c =>
      walkNode(c, [], IDENTITY, { fill: null, opacity: 1 })
    );

    // Detach from main document (svgEl stays in memory but is no longer in the DOM)
    tempDiv.remove();

    return { elements, groups: Object.values(groupsMap), svgEl, width, height };
  }

  // ── Transform helpers ────────────────────────────────────────────────────

  /**
   * Parse an SVG transform string → [a, b, c, d, e, f].
   * Handles matrix, translate, scale, rotate, skewX, skewY
   * and chains multiple transforms left-to-right (each applied after the previous).
   */
  function parseTransformMatrix(str) {
    if (!str || !str.trim()) return null;
    let mat = IDENTITY.slice();
    const re = /(\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const fn   = m[1].trim();
      const args = m[2].trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
      let local;
      switch (fn) {
        case 'matrix':
          if (args.length < 6) continue;
          local = args.slice(0, 6);
          break;
        case 'translate':
          local = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
          break;
        case 'scale': {
          const sx = args[0] || 1, sy = args[1] !== undefined ? args[1] : sx;
          local = [sx, 0, 0, sy, 0, 0];
          break;
        }
        case 'rotate': {
          const ang = (args[0] || 0) * Math.PI / 180;
          const cos = Math.cos(ang), sin = Math.sin(ang);
          if (args.length >= 3) {
            const [cx, cy] = [args[1], args[2]];
            local = [cos, sin, -sin, cos, cx - cx*cos + cy*sin, cy - cx*sin - cy*cos];
          } else {
            local = [cos, sin, -sin, cos, 0, 0];
          }
          break;
        }
        case 'skewX': {
          const t = Math.tan((args[0] || 0) * Math.PI / 180);
          local = [1, 0, t, 1, 0, 0];
          break;
        }
        case 'skewY': {
          const t = Math.tan((args[0] || 0) * Math.PI / 180);
          local = [1, t, 0, 1, 0, 0];
          break;
        }
        default: continue;
      }
      mat = multiplyMatrix(mat, local);
    }
    return mat;
  }

  /**
   * Matrix multiplication: result = m2 * m1
   * (m1 is applied first to a point, then m2).
   * Both matrices are [a, b, c, d, e, f] in SVG convention:
   *   x' = a*x + c*y + e
   *   y' = b*x + d*y + f
   */
  function multiplyMatrix(m1, m2) {
    const [a1,b1,c1,d1,e1,f1] = m1;
    const [a2,b2,c2,d2,e2,f2] = m2;
    return [
      a2*a1 + c2*b1,
      b2*a1 + d2*b1,
      a2*c1 + c2*d1,
      b2*c1 + d2*d1,
      a2*e1 + c2*f1 + e2,
      b2*e1 + d2*f1 + f2,
    ];
  }

  /**
   * Apply a 2D affine matrix [a,b,c,d,e,f] to all coordinates in an SVG pathD string.
   * All relative commands are first resolved to absolute coordinates, then the
   * matrix is applied, so the output is always absolute. This correctly handles
   * translations in the matrix (which must not affect relative deltas).
   */
  function applyMatrixToPathD(pathD, m) {
    if (!m) return pathD;
    const [a, b, c, d, e, f] = m;

    const N  = n => parseFloat(n.toFixed(4));
    // Transform an absolute point
    const pt = (x, y) => [a*x + c*y + e, b*x + d*y + f];
    // Scale factors for arc radii
    const scX = Math.sqrt(a*a + b*b), scY = Math.sqrt(c*c + d*d);

    const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
    const tokens = [];
    let match;
    while ((match = re.exec(pathD)) !== null)
      tokens.push(match[1] !== undefined ? match[1] : parseFloat(match[2]));

    let out = '';
    let i = 0;
    let cx = 0, cy = 0, spx = 0, spy = 0;

    const isNum = () => i < tokens.length && typeof tokens[i] === 'number';
    const num   = () => (typeof tokens[i] === 'number' ? tokens[i++] : NaN);
    const ap    = s  => { out += (out.length ? ' ' : '') + s; };

    while (i < tokens.length) {
      const cmd = tokens[i];
      if (typeof cmd !== 'string') { i++; continue; }
      i++;

      switch (cmd) {
        case 'M': {
          let first = true;
          while (isNum()) {
            const [x, y] = [num(), num()];
            cx = x; cy = y;
            const [nx, ny] = pt(x, y);
            if (first) { spx = x; spy = y; ap(`M${N(nx)},${N(ny)}`); first = false; }
            else ap(`L${N(nx)},${N(ny)}`);
          }
          break;
        }
        // Relative: resolve to absolute FIRST, then transform
        case 'm': {
          let first = true;
          while (isNum()) {
            const [dx, dy] = [num(), num()];
            cx += dx; cy += dy;
            const [nx, ny] = pt(cx, cy);
            if (first) { spx = cx; spy = cy; ap(`M${N(nx)},${N(ny)}`); first = false; }
            else ap(`L${N(nx)},${N(ny)}`);
          }
          break;
        }
        case 'L':
          while (isNum()) {
            const [x, y] = [num(), num()];
            cx = x; cy = y;
            const [nx, ny] = pt(x, y);
            ap(`L${N(nx)},${N(ny)}`);
          }
          break;
        case 'l':
          while (isNum()) {
            const [dx, dy] = [num(), num()];
            cx += dx; cy += dy;
            const [nx, ny] = pt(cx, cy);
            ap(`L${N(nx)},${N(ny)}`);
          }
          break;
        case 'H':
          while (isNum()) {
            cx = num();
            const [nx, ny] = pt(cx, cy);
            ap(`L${N(nx)},${N(ny)}`);
          }
          break;
        case 'h':
          while (isNum()) {
            cx += num();
            const [nx, ny] = pt(cx, cy);
            ap(`L${N(nx)},${N(ny)}`);
          }
          break;
        case 'V':
          while (isNum()) {
            cy = num();
            const [nx, ny] = pt(cx, cy);
            ap(`L${N(nx)},${N(ny)}`);
          }
          break;
        case 'v':
          while (isNum()) {
            cy += num();
            const [nx, ny] = pt(cx, cy);
            ap(`L${N(nx)},${N(ny)}`);
          }
          break;
        case 'C':
          while (isNum()) {
            const [x1,y1,x2,y2,x,y] = [num(),num(),num(),num(),num(),num()];
            const [n1,m1] = pt(x1,y1), [n2,m2] = pt(x2,y2);
            cx = x; cy = y;
            const [nx,ny] = pt(x,y);
            ap(`C${N(n1)},${N(m1)} ${N(n2)},${N(m2)} ${N(nx)},${N(ny)}`);
          }
          break;
        case 'c':
          while (isNum()) {
            const [x1,y1,x2,y2,dx,dy] = [num(),num(),num(),num(),num(),num()];
            // control points are relative to current point
            const [n1,m1] = pt(cx+x1, cy+y1), [n2,m2] = pt(cx+x2, cy+y2);
            cx += dx; cy += dy;
            const [nx,ny] = pt(cx,cy);
            ap(`C${N(n1)},${N(m1)} ${N(n2)},${N(m2)} ${N(nx)},${N(ny)}`);
          }
          break;
        case 'S':
          while (isNum()) {
            const [x2,y2,x,y] = [num(),num(),num(),num()];
            const [n2,m2] = pt(x2,y2);
            cx = x; cy = y;
            const [nx,ny] = pt(x,y);
            ap(`S${N(n2)},${N(m2)} ${N(nx)},${N(ny)}`);
          }
          break;
        case 's':
          while (isNum()) {
            const [dx2,dy2,dx,dy] = [num(),num(),num(),num()];
            const [n2,m2] = pt(cx+dx2, cy+dy2);
            cx += dx; cy += dy;
            const [nx,ny] = pt(cx,cy);
            ap(`S${N(n2)},${N(m2)} ${N(nx)},${N(ny)}`);
          }
          break;
        case 'Q':
          while (isNum()) {
            const [x1,y1,x,y] = [num(),num(),num(),num()];
            const [n1,m1] = pt(x1,y1);
            cx = x; cy = y;
            const [nx,ny] = pt(x,y);
            ap(`Q${N(n1)},${N(m1)} ${N(nx)},${N(ny)}`);
          }
          break;
        case 'q':
          while (isNum()) {
            const [dx1,dy1,dx,dy] = [num(),num(),num(),num()];
            const [n1,m1] = pt(cx+dx1, cy+dy1);
            cx += dx; cy += dy;
            const [nx,ny] = pt(cx,cy);
            ap(`Q${N(n1)},${N(m1)} ${N(nx)},${N(ny)}`);
          }
          break;
        case 'T':
          while (isNum()) {
            cx = num(); cy = num();
            const [nx,ny] = pt(cx,cy);
            ap(`T${N(nx)},${N(ny)}`);
          }
          break;
        case 't':
          while (isNum()) {
            cx += num(); cy += num();
            const [nx,ny] = pt(cx,cy);
            ap(`T${N(nx)},${N(ny)}`);
          }
          break;
        case 'A':
          while (isNum()) {
            const [rx,ry,rot,la,sw,x,y] = [num(),num(),num(),num(),num(),num(),num()];
            cx = x; cy = y;
            const [nx,ny] = pt(x,y);
            ap(`A${N(rx*scX)},${N(ry*scY)} ${N(rot)} ${la},${sw} ${N(nx)},${N(ny)}`);
          }
          break;
        case 'a':
          while (isNum()) {
            const [rx,ry,rot,la,sw,dx,dy] = [num(),num(),num(),num(),num(),num(),num()];
            cx += dx; cy += dy;
            const [nx,ny] = pt(cx,cy);
            ap(`A${N(rx*scX)},${N(ry*scY)} ${N(rot)} ${la},${sw} ${N(nx)},${N(ny)}`);
          }
          break;
        case 'Z': case 'z':
          ap('Z');
          cx = spx; cy = spy;
          break;
      }
    }
    return out.trim();
  }

  // ── Style helpers ────────────────────────────────────────────────────────

  function getStyle(node, prop) {
    const inline = node.style && node.style[prop];
    if (inline && inline !== '') return inline;
    const attr = node.getAttribute(prop);
    if (attr && attr !== '') return attr;
    return null;
  }

  // ── Shape → path D ──────────────────────────────────────────────────────

  function shapeToPathD(node) {
    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case 'path':
        return node.getAttribute('d');
      case 'rect': {
        const x = +(node.getAttribute('x')  || 0);
        const y = +(node.getAttribute('y')  || 0);
        const w = +(node.getAttribute('width')  || 0);
        const h = +(node.getAttribute('height') || 0);
        const rx = +(node.getAttribute('rx') || node.getAttribute('ry') || 0);
        if (!w || !h) return null;
        if (rx) {
          return `M${x+rx},${y} H${x+w-rx} Q${x+w},${y} ${x+w},${y+rx}` +
                 ` V${y+h-rx} Q${x+w},${y+h} ${x+w-rx},${y+h}` +
                 ` H${x+rx} Q${x},${y+h} ${x},${y+h-rx}` +
                 ` V${y+rx} Q${x},${y} ${x+rx},${y} Z`;
        }
        return `M${x},${y} H${x+w} V${y+h} H${x} Z`;
      }
      case 'circle': {
        const cx = +(node.getAttribute('cx') || 0);
        const cy = +(node.getAttribute('cy') || 0);
        const r  = +(node.getAttribute('r')  || 0);
        if (!r) return null;
        return `M${cx-r},${cy} A${r},${r} 0 1,0 ${cx+r},${cy} A${r},${r} 0 1,0 ${cx-r},${cy} Z`;
      }
      case 'ellipse': {
        const cx = +(node.getAttribute('cx') || 0);
        const cy = +(node.getAttribute('cy') || 0);
        const rx = +(node.getAttribute('rx') || 0);
        const ry = +(node.getAttribute('ry') || 0);
        if (!rx || !ry) return null;
        return `M${cx-rx},${cy} A${rx},${ry} 0 1,0 ${cx+rx},${cy} A${rx},${ry} 0 1,0 ${cx-rx},${cy} Z`;
      }
      case 'polygon':
      case 'polyline': {
        const pts = (node.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
        if (pts.length < 4) return null;
        let d = `M${pts[0]},${pts[1]}`;
        for (let i = 2; i < pts.length; i += 2) d += ` L${pts[i]},${pts[i+1]}`;
        if (tag === 'polygon') d += ' Z';
        return d;
      }
      case 'line': {
        return `M${node.getAttribute('x1')||0},${node.getAttribute('y1')||0}` +
               ` L${node.getAttribute('x2')||0},${node.getAttribute('y2')||0}`;
      }
      default: return null;
    }
  }

  return { parse, applyMatrixToPathD, multiplyMatrix };
})();
