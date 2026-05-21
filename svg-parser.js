/**
 * SVG Parser — extracts paths, shapes and groups from an SVG document.
 * Returns a flat list of "elements" each with id, type, d (path data or synthesized),
 * fill, stroke, bbox, and optional groupId.
 */

const SVGParser = (() => {

  // Tags we can extract geometry from
  const SHAPE_TAGS = new Set(['path','rect','circle','ellipse','polygon','polyline','line']);

  function parse(svgString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (!svgEl) throw new Error('SVG inválido');

    const viewBox = svgEl.getAttribute('viewBox');
    const width = parseFloat(svgEl.getAttribute('width')) || (viewBox ? parseFloat(viewBox.split(/[\s,]+/)[2]) : 100);
    const height = parseFloat(svgEl.getAttribute('height')) || (viewBox ? parseFloat(viewBox.split(/[\s,]+/)[3]) : 100);

    const elements = [];
    let idCounter = 0;

    function walkNode(node, groupInfo) {
      if (node.nodeType !== 1) return; // element nodes only
      const tag = node.tagName.toLowerCase();

      if (tag === 'g') {
        const gid = node.getAttribute('id') || node.getAttribute('inkscape:label') || `group_${idCounter++}`;
        const label = node.getAttribute('inkscape:label') || node.getAttribute('id') || gid;
        const childGroupInfo = { id: gid, label };
        Array.from(node.childNodes).forEach(c => walkNode(c, childGroupInfo));
        return;
      }

      if (SHAPE_TAGS.has(tag)) {
        const elemId = node.getAttribute('id') || `${tag}_${idCounter++}`;
        const pathD = shapeToPathD(node);
        if (!pathD) return;

        const fillRaw      = getStyle(node, 'fill');
        const fillOpacity  = parseFloat(getStyle(node, 'fill-opacity') || '1');
        const nodeOpacity  = parseFloat(getStyle(node, 'opacity')      || '1');
        const stroke       = getStyle(node, 'stroke') || 'none';
        const transform    = node.getAttribute('transform') || '';

        // An element has a visible fill when:
        //  • fill is not explicitly "none" or "transparent"
        //  • fill-opacity > 0 and opacity > 0
        const hasFill = fillRaw !== 'none' &&
                        fillRaw !== 'transparent' &&
                        fillOpacity > 0.01 &&
                        nodeOpacity > 0.01;

        // Use actual fill color; fall back to black (SVG default) when unset
        const fill = hasFill ? (fillRaw || 'black') : 'none';

        // Mark the actual DOM node so renderSVG2D can link it without re-parsing
        node.setAttribute('data-elem-ref', elemId);

        elements.push({
          id: elemId,
          tag,
          label: elemId,
          pathD,
          fill,
          hasFill,
          stroke,
          transform,
          groupId: groupInfo ? groupInfo.id : null,
          groupLabel: groupInfo ? groupInfo.label : null,
          config: null,
          visible: true,
        });
      }
    }

    Array.from(svgEl.childNodes).forEach(c => walkNode(c, null));

    // Build group list
    const groups = {};
    elements.forEach(el => {
      if (el.groupId) {
        if (!groups[el.groupId]) groups[el.groupId] = { id: el.groupId, label: el.groupLabel, children: [] };
        groups[el.groupId].children.push(el.id);
      }
    });

    return { elements, groups: Object.values(groups), svgEl, width, height };
  }

  function getStyle(node, prop) {
    const inline = node.style && node.style[prop];
    if (inline && inline !== '') return inline;
    const attr = node.getAttribute(prop);
    if (attr && attr !== '') return attr;
    return null;
  }

  function shapeToPathD(node) {
    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case 'path':
        return node.getAttribute('d');
      case 'rect': {
        const x = +( node.getAttribute('x') || 0);
        const y = +( node.getAttribute('y') || 0);
        const w = +( node.getAttribute('width') || 0);
        const h = +( node.getAttribute('height') || 0);
        const rx = +( node.getAttribute('rx') || node.getAttribute('ry') || 0);
        if (!w || !h) return null;
        if (rx) {
          return `M${x+rx},${y} H${x+w-rx} Q${x+w},${y} ${x+w},${y+rx} V${y+h-rx} Q${x+w},${y+h} ${x+w-rx},${y+h} H${x+rx} Q${x},${y+h} ${x},${y+h-rx} V${y+rx} Q${x},${y} ${x+rx},${y} Z`;
        }
        return `M${x},${y} H${x+w} V${y+h} H${x} Z`;
      }
      case 'circle': {
        const cx = +( node.getAttribute('cx') || 0);
        const cy = +( node.getAttribute('cy') || 0);
        const r  = +( node.getAttribute('r')  || 0);
        if (!r) return null;
        return `M${cx-r},${cy} A${r},${r} 0 1,0 ${cx+r},${cy} A${r},${r} 0 1,0 ${cx-r},${cy} Z`;
      }
      case 'ellipse': {
        const cx = +( node.getAttribute('cx') || 0);
        const cy = +( node.getAttribute('cy') || 0);
        const rx = +( node.getAttribute('rx') || 0);
        const ry = +( node.getAttribute('ry') || 0);
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
        const x1 = node.getAttribute('x1') || 0;
        const y1 = node.getAttribute('y1') || 0;
        const x2 = node.getAttribute('x2') || 0;
        const y2 = node.getAttribute('y2') || 0;
        return `M${x1},${y1} L${x2},${y2}`;
      }
      default:
        return null;
    }
  }

  return { parse };
})();
