/**
 * STL Exporter — exports a Three.js scene/group to binary STL.
 */

const STLExporter = (() => {

  function export3D(scene) {
    const meshes = [];
    scene.traverse(obj => {
      if (obj.isMesh) meshes.push(obj);
    });

    // Count total triangles
    let triCount = 0;
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position');
      if (geo.index) {
        triCount += geo.index.count / 3;
      } else {
        triCount += pos.count / 3;
      }
    }

    // Binary STL: 80-byte header + 4-byte tri count + (triCount * 50 bytes)
    const buffer = new ArrayBuffer(80 + 4 + triCount * 50);
    const view = new DataView(buffer);

    // Header (80 bytes, ASCII "SVG2STL")
    const headerStr = 'SVG2STL Factory Export';
    for (let i = 0; i < Math.min(headerStr.length, 80); i++) {
      view.setUint8(i, headerStr.charCodeAt(i));
    }
    view.setUint32(80, triCount, true);

    let offset = 84;

    for (const mesh of meshes) {
      const geo = mesh.geometry.clone();
      // Apply world matrix
      mesh.updateWorldMatrix(true, false);
      geo.applyMatrix4(mesh.matrixWorld);
      if (!geo.getAttribute('normal')) geo.computeVertexNormals();

      const pos = geo.getAttribute('position');
      const norm = geo.getAttribute('normal');
      const idx = geo.index;

      const getVec = (attr, i) => ({
        x: attr.getX(i), y: attr.getY(i), z: attr.getZ(i)
      });

      const writeFace = (v0, v1, v2, n) => {
        view.setFloat32(offset,      n.x, true); offset += 4;
        view.setFloat32(offset,      n.y, true); offset += 4;
        view.setFloat32(offset,      n.z, true); offset += 4;
        view.setFloat32(offset,    v0.x, true); offset += 4;
        view.setFloat32(offset,    v0.y, true); offset += 4;
        view.setFloat32(offset,    v0.z, true); offset += 4;
        view.setFloat32(offset,    v1.x, true); offset += 4;
        view.setFloat32(offset,    v1.y, true); offset += 4;
        view.setFloat32(offset,    v1.z, true); offset += 4;
        view.setFloat32(offset,    v2.x, true); offset += 4;
        view.setFloat32(offset,    v2.y, true); offset += 4;
        view.setFloat32(offset,    v2.z, true); offset += 4;
        view.setUint16(offset, 0, true); offset += 2; // attribute byte count
      };

      if (idx) {
        for (let i = 0; i < idx.count; i += 3) {
          const a = idx.getX(i), b = idx.getX(i+1), c = idx.getX(i+2);
          const v0 = getVec(pos, a), v1 = getVec(pos, b), v2 = getVec(pos, c);
          const n  = avgNormal(getVec(norm, a), getVec(norm, b), getVec(norm, c));
          writeFace(v0, v1, v2, n);
        }
      } else {
        for (let i = 0; i < pos.count; i += 3) {
          const v0 = getVec(pos, i), v1 = getVec(pos, i+1), v2 = getVec(pos, i+2);
          const n  = faceNormal(v0, v1, v2);
          writeFace(v0, v1, v2, n);
        }
      }
    }

    return buffer;
  }

  function avgNormal(n0, n1, n2) {
    const x = (n0.x + n1.x + n2.x) / 3;
    const y = (n0.y + n1.y + n2.y) / 3;
    const z = (n0.z + n1.z + n2.z) / 3;
    const len = Math.sqrt(x*x + y*y + z*z) || 1;
    return { x: x/len, y: y/len, z: z/len };
  }

  function faceNormal(v0, v1, v2) {
    const ax = v1.x-v0.x, ay = v1.y-v0.y, az = v1.z-v0.z;
    const bx = v2.x-v0.x, by = v2.y-v0.y, bz = v2.z-v0.z;
    const nx = ay*bz - az*by;
    const ny = az*bx - ax*bz;
    const nz = ax*by - ay*bx;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    return { x: nx/len, y: ny/len, z: nz/len };
  }

  function download(buffer, filename = 'export.stl') {
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return { export3D, download };
})();
