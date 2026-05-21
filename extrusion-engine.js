/**
 * Extrusion Engine
 * Converts SVG path data into Three.js ExtrudeGeometry meshes.
 * Depends on Three.js (r128) being loaded globally.
 */

const ExtrusionEngine = (() => {

  // ── Public: build a Three.js Group (mesh) from one SVG element ──────────────

  function buildMesh(element, globalScale) {
    const cfg = element.config || { extrudeUp: 0, scaleX: 1, scaleY: 1 };
    const rawDepth = cfg.extrudeUp !== undefined ? cfg.extrudeUp : 0;
    if (rawDepth === 0) return null;

    const sx =  (cfg.scaleX || 1) * globalScale;
    const sy = -(cfg.scaleY || 1) * globalScale; // flip Y: SVG Y-down → world Y-up

    const shapes = pathToShapes(element.pathD, sx, sy);
    if (!shapes.length) return null;

    const group = new THREE.Group();
    const color = cssColorToHex(cfg.color3d || '#888888');
    const depth = Math.max(0.01, Math.abs(rawDepth));

    for (const shape of shapes) {
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color, side: THREE.DoubleSide }));
      if (rawDepth < 0) mesh.scale.z = -1;
      group.add(mesh);
    }

    // Lay flat on XZ plane, extrude in ±Y
    group.rotation.x = -Math.PI / 2;
    group.position.y = cfg.extrudeOffset || 0;
    group.userData.elementId = element.id;
    return group;
  }

  // ── Path → THREE.Shape[] using ShapePath (correct even-odd hole detection) ──

  function pathToShapes(pathD, sx, sy) {
    const subpaths = parseFullPath(pathD, sx, sy);
    if (!subpaths.length) return [];

    const shapePath = new THREE.ShapePath();
    for (const { pts } of subpaths) {
      if (pts.length < 2) continue;
      shapePath.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) shapePath.lineTo(pts[i].x, pts[i].y);
    }

    try {
      // isCCW=false: after Y-flip outer paths are CW, so CW = outer shape, CCW = hole
      return shapePath.toShapes(false);
    } catch (e) {
      console.warn('ShapePath.toShapes error:', e);
      return [];
    }
  }

  // ── Debug: raw subpaths for the debug panel (no scale) ──────────────────────

  function debugShapes(pathD) {
    return parseFullPath(pathD, 1, 1);
  }

  // ── Core parser: processes entire path in one pass ──────────────────────────
  // Fixes:
  //  • relative 'm' after 'Z' uses correct current position
  //  • S command correctly reflects previous control point
  //  • tokenizer handles scientific notation and implicit sign separators

  function parseFullPath(d, sx, sy) {
    const tokens = tokenize(d);
    const subpaths = [];   // [{pts:[{x,y}], closed:bool}]
    let cur = [];          // points for current subpath
    let cx = 0, cy = 0;   // current pen position
    let startX = 0, startY = 0; // start of current subpath (for Z)
    let lastCmd = '';
    let lastCx2 = 0, lastCy2 = 0; // last cubic/quadratic control point (for S/T)
    let i = 0;

    function push(x, y) { cur.push({ x: x * sx, y: y * sy }); }

    function flushSub(closed) {
      if (cur.length >= 2) subpaths.push({ pts: cur, closed });
      cur = [];
    }

    while (i < tokens.length) {
      const tok = tokens[i];
      if (!isCmd(tok)) { i++; continue; }
      const cmd = tok; i++;
      const up  = cmd.toUpperCase();
      const rel = cmd !== up;

      switch (up) {
        case 'M': {
          flushSub(false);
          let first = true;
          while (i < tokens.length && !isCmd(tokens[i])) {
            const x = n(tokens[i++]), y = n(tokens[i++]);
            cx = rel && !first ? cx + x : (rel ? cx + x : x);
            cy = rel && !first ? cy + y : (rel ? cy + y : y);
            if (first) { startX = cx; startY = cy; first = false; }
            push(cx, cy);
            // subsequent coord pairs are implicit L
          }
          lastCmd = 'M';
          break;
        }
        case 'Z': {
          push(startX, startY);
          flushSub(true);
          cx = startX; cy = startY;
          lastCmd = 'Z';
          break;
        }
        case 'L': {
          while (i < tokens.length && !isCmd(tokens[i])) {
            const x = n(tokens[i++]), y = n(tokens[i++]);
            cx = rel ? cx + x : x; cy = rel ? cy + y : y;
            push(cx, cy);
          }
          lastCmd = up; break;
        }
        case 'H': {
          while (i < tokens.length && !isCmd(tokens[i])) {
            const x = n(tokens[i++]);
            cx = rel ? cx + x : x;
            push(cx, cy);
          }
          lastCmd = up; break;
        }
        case 'V': {
          while (i < tokens.length && !isCmd(tokens[i])) {
            const y = n(tokens[i++]);
            cy = rel ? cy + y : y;
            push(cx, cy);
          }
          lastCmd = up; break;
        }
        case 'C': {
          while (i < tokens.length && !isCmd(tokens[i])) {
            const x1=n(tokens[i++]), y1=n(tokens[i++]);
            const x2=n(tokens[i++]), y2=n(tokens[i++]);
            const x =n(tokens[i++]), y =n(tokens[i++]);
            const ax1=rel?cx+x1:x1, ay1=rel?cy+y1:y1;
            const ax2=rel?cx+x2:x2, ay2=rel?cy+y2:y2;
            const ex =rel?cx+x:x,   ey =rel?cy+y:y;
            sampleCubic(cur, cx,cy, ax1,ay1, ax2,ay2, ex,ey, sx,sy);
            lastCx2=ax2; lastCy2=ay2; cx=ex; cy=ey;
          }
          lastCmd = up; break;
        }
        case 'S': {
          while (i < tokens.length && !isCmd(tokens[i])) {
            const x2=n(tokens[i++]), y2=n(tokens[i++]);
            const x =n(tokens[i++]), y =n(tokens[i++]);
            const ax2=rel?cx+x2:x2, ay2=rel?cy+y2:y2;
            const ex =rel?cx+x:x,   ey =rel?cy+y:y;
            // Reflect previous control point around current pen
            const ax1 = (lastCmd==='C'||lastCmd==='S') ? 2*cx-lastCx2 : cx;
            const ay1 = (lastCmd==='C'||lastCmd==='S') ? 2*cy-lastCy2 : cy;
            sampleCubic(cur, cx,cy, ax1,ay1, ax2,ay2, ex,ey, sx,sy);
            lastCx2=ax2; lastCy2=ay2; cx=ex; cy=ey;
          }
          lastCmd = up; break;
        }
        case 'Q': {
          while (i < tokens.length && !isCmd(tokens[i])) {
            const x1=n(tokens[i++]), y1=n(tokens[i++]);
            const x =n(tokens[i++]), y =n(tokens[i++]);
            const ax1=rel?cx+x1:x1, ay1=rel?cy+y1:y1;
            const ex =rel?cx+x:x,   ey =rel?cy+y:y;
            sampleQuad(cur, cx,cy, ax1,ay1, ex,ey, sx,sy);
            lastCx2=ax1; lastCy2=ay1; cx=ex; cy=ey;
          }
          lastCmd = up; break;
        }
        case 'T': {
          while (i < tokens.length && !isCmd(tokens[i])) {
            const x=n(tokens[i++]), y=n(tokens[i++]);
            const ex=rel?cx+x:x, ey=rel?cy+y:y;
            const ax1=(lastCmd==='Q'||lastCmd==='T') ? 2*cx-lastCx2 : cx;
            const ay1=(lastCmd==='Q'||lastCmd==='T') ? 2*cy-lastCy2 : cy;
            sampleQuad(cur, cx,cy, ax1,ay1, ex,ey, sx,sy);
            lastCx2=ax1; lastCy2=ay1; cx=ex; cy=ey;
          }
          lastCmd = up; break;
        }
        case 'A': {
          while (i < tokens.length && !isCmd(tokens[i])) {
            const rx=Math.abs(n(tokens[i++])), ry=Math.abs(n(tokens[i++]));
            const xRot=n(tokens[i++]);
            const largeArc=n(tokens[i++]);
            const sweep=n(tokens[i++]);
            const x=n(tokens[i++]), y=n(tokens[i++]);
            const ex=rel?cx+x:x, ey=rel?cy+y:y;
            sampleArc(cur, cx,cy, rx,ry, xRot, largeArc, sweep, ex,ey, sx,sy);
            cx=ex; cy=ey;
          }
          lastCmd = up; break;
        }
        default: lastCmd = up; break;
      }
    }
    flushSub(false);
    return subpaths;
  }

  // ── Tokenizer: handles scientific notation + implicit sign separators ────────

  function tokenize(d) {
    const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
    const tokens = [];
    let m;
    while ((m = re.exec(d)) !== null) tokens.push(m[0]);
    return tokens;
  }

  function isCmd(t) { return t && /^[MmLlHhVvCcSsQqTtAaZz]$/.test(t); }
  function n(t) { return parseFloat(t) || 0; }

  // ── Curve samplers ────────────────────────────────────────────────────────────

  function sampleCubic(pts, x0,y0, x1,y1, x2,y2, x3,y3, sx,sy, steps=20) {
    for (let t = 1/steps; t <= 1+1e-6; t += 1/steps) {
      const mt=1-t;
      pts.push({
        x: (mt*mt*mt*x0 + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*x3) * sx,
        y: (mt*mt*mt*y0 + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*y3) * sy,
      });
    }
  }

  function sampleQuad(pts, x0,y0, x1,y1, x2,y2, sx,sy, steps=14) {
    for (let t = 1/steps; t <= 1+1e-6; t += 1/steps) {
      const mt=1-t;
      pts.push({
        x: (mt*mt*x0 + 2*mt*t*x1 + t*t*x2) * sx,
        y: (mt*mt*y0 + 2*mt*t*y1 + t*t*y2) * sy,
      });
    }
  }

  function sampleArc(pts, x1,y1, rx,ry, xRot, largeArc, sweep, x2,y2, sx,sy, steps=32) {
    if (rx===0 || ry===0) { pts.push({ x:x2*sx, y:y2*sy }); return; }
    const phi = xRot * Math.PI/180;
    const cp=Math.cos(phi), sp=Math.sin(phi);
    const mx=(x1-x2)/2, my=(y1-y2)/2;
    const x1p= cp*mx+sp*my, y1p=-sp*mx+cp*my;
    let num = rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p;
    let den = rx*rx*y1p*y1p + ry*ry*x1p*x1p;
    const sq = Math.sqrt(Math.max(0, num/den));
    const sign = largeArc===sweep ? -1 : 1;
    const cxp= sign*sq* rx*y1p/ry;
    const cyp=-sign*sq* ry*x1p/rx;
    const cx = cp*cxp-sp*cyp+(x1+x2)/2;
    const cy = sp*cxp+cp*cyp+(y1+y2)/2;
    let a0=Math.atan2((y1p-cyp)/ry,(x1p-cxp)/rx);
    let da=Math.atan2((-y1p-cyp)/ry,(-x1p-cxp)/rx)-a0;
    if (sweep===0 && da>0) da-=2*Math.PI;
    if (sweep===1 && da<0) da+=2*Math.PI;
    for (let k=1; k<=steps; k++) {
      const a=a0+da*k/steps;
      pts.push({
        x: (cx + rx*Math.cos(a)*cp - ry*Math.sin(a)*sp) * sx,
        y: (cy + rx*Math.cos(a)*sp + ry*Math.sin(a)*cp) * sy,
      });
    }
  }

  function cssColorToHex(color) {
    if (!color || color==='none') return 0x888888;
    const c=document.createElement('canvas'); c.width=1; c.height=1;
    const ctx=c.getContext('2d');
    ctx.fillStyle=color; ctx.fillRect(0,0,1,1);
    const [r,g,b]=ctx.getImageData(0,0,1,1).data;
    return (r<<16)|(g<<8)|b;
  }

  return { buildMesh, pathToShapes, debugShapes };
})();
