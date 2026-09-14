/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — a self-contained WebGL STL viewer (no CDN:
 *                     |                             | cockpit surfaces ship script-src 'self'). Parses binary and
 *                     |                             | ASCII STL, centres the part on its bounding box, draws it with
 *                     |                             | a headlight Lambert shade over a 10 mm bed grid, and takes
 *                     |                             | drag-to-orbit / wheel-to-zoom / shift-drag-to-pan. Renders
 *                     |                             | only when something changed; a still viewer costs nothing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Use a nonreserved GLSL uniform and schedule the first draw so real WebGL displays reconstructed geometry.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Share API v1 across Scan and CAD; release owned resources through dispose(), reject nonfinite mesh data and bound the bed grid.
 */
(function () {
  'use strict';

  /** Parse an STL (binary or ASCII) into flat per-vertex positions + normals. */
  function parseStl(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const looksBinary = bytes.length >= 84 && bytes.length === 84 + 50 * view.getUint32(80, true);
    if (looksBinary) {
      const n = view.getUint32(80, true);
      const pos = new Float32Array(n * 9);
      const nor = new Float32Array(n * 9);
      for (let i = 0; i < n; i += 1) {
        const at = 84 + i * 50;
        const nx = view.getFloat32(at, true), ny = view.getFloat32(at + 4, true), nz = view.getFloat32(at + 8, true);
        for (let v = 0; v < 3; v += 1) {
          const o = at + 12 + v * 12;
          pos.set([view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)], i * 9 + v * 3);
          nor.set([nx, ny, nz], i * 9 + v * 3);
        }
      }
      return finiteMesh(pos, nor, n);
    }
    const text = new TextDecoder().decode(bytes);
    const verts = [];
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) verts.push(Number(m[1]), Number(m[2]), Number(m[3]));
    const n = Math.floor(verts.length / 9);
    const pos = new Float32Array(verts.slice(0, n * 9));
    const nor = new Float32Array(n * 9);
    for (let i = 0; i < n; i += 1) {
      const a = pos.subarray(i * 9, i * 9 + 3), b = pos.subarray(i * 9 + 3, i * 9 + 6), c = pos.subarray(i * 9 + 6, i * 9 + 9);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      for (let v = 0; v < 3; v += 1) nor.set([nx / len, ny / len, nz / len], i * 9 + v * 3);
    }
    return finiteMesh(pos, nor, n);
  }

  /** Refuse invalid float coordinates before bounds can reach the camera or grid loop. */
  function finiteMesh(positions, normals, triangles) {
    if (!positions.every(Number.isFinite) || !normals.every(Number.isFinite)) {
      throw new Error('STL coordinates and normals must be finite numbers.');
    }
    return { positions, normals, triangles };
  }

  const VS = 'attribute vec3 p; attribute vec3 n; uniform mat4 mvp; uniform mat4 mv; varying vec3 vn; varying vec3 vp;' +
    'void main(){ gl_Position = mvp * vec4(p,1.0); vn = mat3(mv) * n; vp = (mv * vec4(p,1.0)).xyz; }';
  const FS = 'precision mediump float; uniform vec3 color; uniform float unlit; varying vec3 vn; varying vec3 vp;' +
    'void main(){ if (unlit > 0.5) { gl_FragColor = vec4(color, 1.0); return; } vec3 n = normalize(vn); vec3 l = normalize(-vp);' +
    'float d = max(dot(n, l), 0.0); float f = 0.25 + 0.75 * d; gl_FragColor = vec4(color * f, 1.0); }';

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(message);
    }
    return s;
  }

  /** Link the fixed shaders; temporary shaders are released even on compilation failure. */
  function createProgram(gl) {
    const program = gl.createProgram(), shaders = [];
    try {
      shaders.push(compile(gl, gl.VERTEX_SHADER, VS));
      shaders.push(compile(gl, gl.FRAGMENT_SHADER, FS));
      shaders.forEach((shader) => gl.attachShader(program, shader));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      return program;
    } catch (error) { gl.deleteProgram(program); throw error; }
    finally { shaders.forEach((shader) => gl.deleteShader(shader)); }
  }

  /** Minimal column-major 4×4 helpers. */
  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
    return out;
  }
  const translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  const rotX = (a) => new Float32Array([1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]);
  const rotZ = (a) => new Float32Array([Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /** Bed grid is 10 mm for ordinary parts; coarse spacing bounds huge meshes to 402 lines. */
  function gridLines(size) {
    const step = 10 * Math.max(1, Math.ceil(size * 0.8 / 1000));
    const ticks = Math.ceil(size * 0.8 / step), half = ticks * step;
    const lines = [];
    for (let i = -ticks; i <= ticks; i += 1) {
      const v = i * step;
      lines.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
    }
    return new Float32Array(lines);
  }

  function parseColor(css, fallback) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
    return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] : fallback;
  }

  /** Draw only invalidated frames, preserving the existing millimetre grid and camera. */
  function createDraw(canvas, gl, loc, bufs, state) {
    return function draw() {
      state.frame = 0; state.dirty = false;
      if (state.disposed) return;
      const w = canvas.clientWidth || 300, h = canvas.clientHeight || 300;
      if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) { canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio; }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const style = getComputedStyle(canvas);
      const part = parseColor(style.color, [0.55, 0.7, 0.95]);
      const line = parseColor(style.borderColor, [0.5, 0.5, 0.5]);
      const camDist = state.radius * state.dist;
      const mv = multiply(translate(state.pan[0], state.pan[1], -camDist), multiply(rotX(state.pitch), multiply(rotZ(state.yaw), translate(-state.center[0], -state.center[1], -state.center[2]))));
      const mvp = multiply(perspective(0.8, w / h, state.radius * 0.05, state.radius * 40), mv);
      gl.uniformMatrix4fv(loc.mvp, false, mvp);
      gl.uniformMatrix4fv(loc.mv, false, mv);
      if (state.gridCount) {
        gl.uniform1f(loc.flat, 1); gl.uniform3fv(loc.color, line);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.grid); gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 3, gl.FLOAT, false, 0, 0);
        gl.disableVertexAttribArray(loc.n); gl.vertexAttrib3f(loc.n, 0, 0, 1);
        gl.drawArrays(gl.LINES, 0, state.gridCount);
      }
      if (state.triangles) {
        gl.uniform1f(loc.flat, 0); gl.uniform3fv(loc.color, part);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.p); gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.n); gl.enableVertexAttribArray(loc.n); gl.vertexAttribPointer(loc.n, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, state.triangles * 3);
      }
    };
  }

  /** Bind only this instance's controls, returning an exact listener cleanup. */
  function bindControls(canvas, state, invalidate) {
    const listeners = [];
    function on(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      listeners.push(() => target.removeEventListener(type, listener, options));
    }
    let drag = null;
    on(canvas, 'pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, pan: ev.shiftKey || ev.button === 2 }; canvas.setPointerCapture(ev.pointerId); });
    on(canvas, 'pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.x = ev.clientX; drag.y = ev.clientY;
      if (drag.pan) { state.pan[0] += dx * state.radius * 0.004 * state.dist; state.pan[1] -= dy * state.radius * 0.004 * state.dist; } else { state.yaw += dx * 0.01; state.pitch = Math.max(-Math.PI, Math.min(0, state.pitch + dy * 0.01)); }
      invalidate();
    });
    on(canvas, 'pointerup', () => { drag = null; });
    on(canvas, 'pointercancel', () => { drag = null; });
    on(canvas, 'wheel', (ev) => { ev.preventDefault(); state.dist = Math.max(1.2, Math.min(12, state.dist * (ev.deltaY > 0 ? 1.1 : 0.9))); invalidate(); }, { passive: false });
    on(canvas, 'contextmenu', (ev) => ev.preventDefault());
    on(window, 'resize', invalidate);
    return () => listeners.forEach((remove) => remove());
  }

  /** Mount API v1. The caller can dispose before replacing its canvas; no continuous render loop. */
  function mount(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
    if (!gl) throw new Error('WebGL is not available');
    const prog = createProgram(gl);
    gl.useProgram(prog);
    const loc = { p: gl.getAttribLocation(prog, 'p'), n: gl.getAttribLocation(prog, 'n'), mvp: gl.getUniformLocation(prog, 'mvp'), mv: gl.getUniformLocation(prog, 'mv'), color: gl.getUniformLocation(prog, 'color'), flat: gl.getUniformLocation(prog, 'unlit') };
    const bufs = { p: gl.createBuffer(), n: gl.createBuffer(), grid: gl.createBuffer() };
    const state = { triangles: 0, gridCount: 0, center: [0, 0, 0], radius: 50, yaw: -0.6, pitch: -1.1, dist: 3, pan: [0, 0], dirty: false, frame: 0, disposed: false };

    const draw = createDraw(canvas, gl, loc, bufs, state);
    function invalidate() { if (!state.dirty && !state.disposed) { state.dirty = true; state.frame = requestAnimationFrame(draw); } }

    function load(buffer) {
      if (state.disposed) throw new Error('The 3D viewer has been disposed.');
      const mesh = parseStl(buffer);
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < mesh.positions.length; i += 3) for (let a = 0; a < 3; a += 1) { lo[a] = Math.min(lo[a], mesh.positions[i + a]); hi[a] = Math.max(hi[a], mesh.positions[i + a]); }
      state.center = mesh.triangles ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : [0, 0, 0];
      state.radius = mesh.triangles ? Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) : 50;
      state.triangles = mesh.triangles;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.p); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.n); gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      const grid = gridLines(state.radius * 2);
      state.gridCount = grid.length / 3;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.grid); gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
      state.dist = 3; state.pan = [0, 0];
      invalidate();
      return { triangles: mesh.triangles, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
    }
    function clear() { state.triangles = 0; state.gridCount = 0; invalidate(); }

    const unbind = bindControls(canvas, state, invalidate);
    function dispose() {
      if (state.disposed) return;
      state.disposed = true; cancelAnimationFrame(state.frame); unbind();
      Object.values(bufs).forEach((buffer) => gl.deleteBuffer(buffer));
      gl.deleteProgram(prog); gl.useProgram(null); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    invalidate();
    return { load, clear, resize: invalidate, parseStl, dispose };
  }

  window.OSHALStlViewer = Object.freeze({ apiVersion: 1, mount, parseStl });
})();
