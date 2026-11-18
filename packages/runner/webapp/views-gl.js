// A small block renderer for the browser app's turtle view (views.js): the sides of boxes drawn many at a time with
// WebGL 2, an
// orbit camera, and a ray through the blocks for the pointer. Nothing here knows about turtles or the emulator.
"use strict";

(() => {
  const FLOATS = 11; // one side of a box: the box's centre x y z, its size x y z, colour r g b a, which side (0..5)

  /**
   * Sides of boxes that are drawn together: 0 east (+x), 1 west, 2 top, 3 bottom, 4 south (+z), 5 north. Only the
   * sides that can be seen need to be here, so flat ground costs one side a block. Adding and removing one costs the
   * same however many there are.
   */
  class Sides {
    constructor(gl) {
      this.gl = gl;
      this.data = new Float32Array(FLOATS * 1024);
      this.count = 0;
      this.soft = 0; // how many of them are see-through
      this.buffer = gl.createBuffer();
      this.allocated = 0; // floats the buffer on the card holds
      this.dirtyFrom = Infinity;
      this.dirtyTo = 0;
    }
    clear() {
      this.count = 0;
      this.soft = 0;
      this.dirtyFrom = Infinity;
      this.dirtyTo = 0;
    }
    touch(index) {
      if (index < this.dirtyFrom) this.dirtyFrom = index;
      if (index + 1 > this.dirtyTo) this.dirtyTo = index + 1;
    }
    /** Add one side of a box and return its place. `rgb` is 0xRRGGBB. */
    add(x, y, z, sx, sy, sz, rgb, alpha, side) {
      if ((this.count + 1) * FLOATS > this.data.length) {
        const grown = new Float32Array(this.data.length * 2);
        grown.set(this.data);
        this.data = grown;
      }
      const index = this.count++;
      this.data[index * FLOATS + 9] = 1;
      this.set(index, x, y, z, sx, sy, sz, rgb, alpha, side);
      return index;
    }
    set(index, x, y, z, sx, sy, sz, rgb, alpha, side) {
      const d = this.data;
      const o = index * FLOATS;
      this.soft += (alpha < 0.99 ? 1 : 0) - (d[o + 9] < 0.99 ? 1 : 0);
      d[o] = x;
      d[o + 1] = y;
      d[o + 2] = z;
      d[o + 3] = sx;
      d[o + 4] = sy;
      d[o + 5] = sz;
      d[o + 6] = ((rgb >> 16) & 255) / 255;
      d[o + 7] = ((rgb >> 8) & 255) / 255;
      d[o + 8] = (rgb & 255) / 255;
      d[o + 9] = alpha;
      d[o + 10] = side;
      this.touch(index);
    }
    /** All six sides of a box. */
    addBox(x, y, z, sx, sy, sz, rgb, alpha) {
      for (let side = 0; side < 6; side++)
        this.add(x, y, z, sx, sy, sz, rgb, alpha, side);
    }
    /** Remove a side. The last one takes its place: the answer is the place that one had (it now has `index`), or -1. */
    remove(index) {
      const last = --this.count;
      if (this.data[index * FLOATS + 9] < 0.99) this.soft--;
      if (index === last) return -1;
      this.data.copyWithin(index * FLOATS, last * FLOATS, (last + 1) * FLOATS);
      this.touch(index);
      return last;
    }
    /** Send what changed to the card. */
    upload() {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      if (this.allocated < this.data.length) {
        gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW);
        this.allocated = this.data.length;
      } else if (this.dirtyTo > this.dirtyFrom) {
        const from = this.dirtyFrom * FLOATS;
        const to = Math.min(this.dirtyTo, this.count) * FLOATS;
        if (to > from)
          gl.bufferSubData(
            gl.ARRAY_BUFFER,
            from * 4,
            this.data,
            from,
            to - from,
          );
      }
      this.dirtyFrom = Infinity;
      this.dirtyTo = 0;
    }
  }

  const VERTEX = `#version 300 es
  layout(location=0) in vec2 corner;   // a corner of the side, -0.5..0.5 each way
  layout(location=1) in vec3 centre;   // of the box
  layout(location=2) in vec3 size;     // of the box
  layout(location=3) in vec4 colour;
  layout(location=4) in float side;
  uniform mat4 view;
  out vec4 vColour;
  out vec2 vFace;
  out vec2 vFaceSize;
  out float vLight;
  out float vHeight;
  out float vDepth;
  // for each side: the way it faces, and the two ways across it
  const vec3 N[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
  const vec3 U[6] = vec3[6](vec3(0,0,-1), vec3(0,0,1), vec3(1,0,0), vec3(1,0,0), vec3(1,0,0), vec3(-1,0,0));
  const vec3 V[6] = vec3[6](vec3(0,1,0), vec3(0,1,0), vec3(0,0,-1), vec3(0,0,1), vec3(0,1,0), vec3(0,1,0));
  void main() {
    int s = int(side + 0.5);
    vec3 normal = N[s];
    vec3 world = centre + (normal * 0.5 + U[s] * corner.x + V[s] * corner.y) * size;
    vHeight = world.y;
    gl_Position = view * vec4(world, 1.0);
    vDepth = gl_Position.w;
    vColour = colour;
    vFace = corner + 0.5;
    vFaceSize = vec2(dot(abs(U[s]), size), dot(abs(V[s]), size));
    // light from above and a little from the south-east, as a map is shaded
    vLight = s == 2 ? 1.0 : s == 3 ? 0.5 : s == 0 ? 0.82 : s == 1 ? 0.7 : s == 4 ? 0.76 : 0.62;
  }`;

  const FRAGMENT = `#version 300 es
  precision mediump float;
  in vec4 vColour;
  in vec2 vFace;
  in vec2 vFaceSize;
  in float vLight;
  in float vHeight;
  in float vDepth;
  uniform int pass;        // 0 solid sides, 1 see-through sides
  uniform float fade;      // every side this much see-through (1: as it is)
  uniform float cut;       // nothing above this height is drawn
  uniform float edges;     // how dark a side's edges are
  uniform vec3 fog;
  uniform float fogFar;
  out vec4 outColour;
  void main() {
    if (vHeight > cut) discard;
    float alpha = vColour.a * fade;
    if (pass == 0 && alpha < 0.99) discard;
    if (pass == 1 && alpha >= 0.99) discard;
    // a dark line along each edge, as wide on a long box as on a short one
    vec2 d = min(vFace, 1.0 - vFace) * vFaceSize;
    float edge = 1.0 - edges * (1.0 - smoothstep(0.0, 0.07, min(d.x, d.y)));
    vec3 c = vColour.rgb * vLight * edge;
    float far = clamp((vDepth - fogFar * 0.5) / (fogFar * 0.5), 0.0, 1.0);
    outColour = vec4(mix(c, fog, far * 0.85), alpha);
  }`;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) || "shader failed");
    return shader;
  }

  // 4x4 matrices, column-major, as WebGL takes them
  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = sum;
      }
    return out;
  }
  function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  function lookAt(eye, target) {
    const f = unit(sub(target, eye));
    const s = unit(cross(f, [0, 1, 0]));
    const u = cross(s, f);
    return new Float32Array([
      s[0],
      u[0],
      -f[0],
      0,
      s[1],
      u[1],
      -f[1],
      0,
      s[2],
      u[2],
      -f[2],
      0,
      -dot(s, eye),
      -dot(u, eye),
      dot(f, eye),
      1,
    ]);
  }

  const FOV = (50 * Math.PI) / 180;

  /**
   * The 3D view on one canvas. `world` boxes stay from frame to frame (the blocks); `marks` are rebuilt by the owner
   * whenever they change (turtles, trails, a block appearing or going) and are also drawn faintly through whatever
   * hides them, so a turtle in a tunnel can still be found.
   */
  class BlockScene {
    /** Throws when the browser has no WebGL 2: the owner then shows the flat view. */
    constructor(canvas) {
      const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
      if (!gl) throw new Error("no WebGL 2");
      this.canvas = canvas;
      this.gl = gl;
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || "link failed");
      this.program = program;
      this.uniform = {};
      for (const name of [
        "view",
        "pass",
        "fade",
        "cut",
        "edges",
        "fog",
        "fogFar",
      ])
        this.uniform[name] = gl.getUniformLocation(program, name);
      this.cube = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cube);
      // one side: two triangles, counter-clockwise seen from outside
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
        ]),
        gl.STATIC_DRAW,
      );
      this.world = new Sides(gl);
      this.marks = new Sides(gl);
      this.arrays = new Map();
      // the camera looks at `target` from `distance` away, turned `yaw` round and tipped `pitch` down
      this.target = [0, 64, 0];
      this.yaw = Math.PI * 0.2;
      this.pitch = 0.62;
      this.distance = 18;
      this.background = [0.08, 0.08, 0.08];
      this.seeThrough = false;
      this.cut = Infinity;
      this.changed = true;
      this.onMove = null; // the person moved the camera
      this.pointers();
    }

    arraysFor(boxes) {
      let vao = this.arrays.get(boxes);
      if (vao) return vao;
      const gl = this.gl;
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cube);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, boxes.buffer);
      const stride = FLOATS * 4;
      [
        [1, 3, 0],
        [2, 3, 12],
        [3, 4, 24],
        [4, 1, 40],
      ].forEach(([location, size, offset]) => {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        gl.vertexAttribDivisor(location, 1);
      });
      gl.bindVertexArray(null);
      this.arrays.set(boxes, vao);
      return vao;
    }

    eye() {
      const c = Math.cos(this.pitch);
      return [
        this.target[0] + this.distance * c * Math.sin(this.yaw),
        this.target[1] + this.distance * Math.sin(this.pitch),
        this.target[2] + this.distance * c * Math.cos(this.yaw),
      ];
    }

    /** Fit the drawing to the canvas's size on the page. True when it changed. */
    fitCanvas() {
      const canvas = this.canvas;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width === w && canvas.height === h) return false;
      canvas.width = w;
      canvas.height = h;
      this.changed = true;
      return true;
    }

    /** Draw, if anything changed since the last frame. */
    render() {
      this.fitCanvas();
      if (!this.changed) return;
      this.changed = false;
      const gl = this.gl;
      const { canvas } = this;
      gl.viewport(0, 0, canvas.width, canvas.height);
      const [r, g, b] = this.background;
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.useProgram(this.program);
      const far = Math.max(400, this.distance * 6);
      const projection = perspective(
        FOV,
        canvas.width / canvas.height,
        0.2,
        far,
      );
      gl.uniformMatrix4fv(
        this.uniform.view,
        false,
        multiply(projection, lookAt(this.eye(), this.target)),
      );
      gl.uniform3f(this.uniform.fog, r, g, b);
      gl.uniform1f(this.uniform.fogFar, Math.max(160, this.distance * 4));
      gl.uniform1f(this.uniform.cut, this.cut);
      const draw = (boxes, pass, fade, edges) => {
        // nothing to draw in this pass: all of them solid, or all of them see-through
        if (
          pass === 0
            ? fade < 0.99 || boxes.soft === boxes.count
            : fade >= 0.99 && boxes.soft === 0
        )
          return;
        gl.bindVertexArray(this.arraysFor(boxes));
        gl.uniform1i(this.uniform.pass, pass);
        gl.uniform1f(this.uniform.fade, fade);
        gl.uniform1f(this.uniform.edges, edges);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, boxes.count);
      };
      this.world.upload();
      this.marks.upload();
      const fade = this.seeThrough ? 0.13 : 1;
      // solid first, then what is see-through over it
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.depthFunc(gl.LESS);
      draw(this.world, 0, fade, 0.22);
      gl.uniform1f(this.uniform.cut, Infinity);
      draw(this.marks, 0, 1, 0.3);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(this.uniform.cut, this.cut);
      draw(this.world, 1, fade, this.seeThrough ? 0.35 : 0.22);
      gl.uniform1f(this.uniform.cut, Infinity);
      draw(this.marks, 1, 1, 0.3);
      // the marks again, faintly, where something stands in front of them
      gl.depthFunc(gl.GREATER);
      draw(this.marks, 1, 0.28, 0);
      draw(this.marks, 0, 0.28, 0);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.bindVertexArray(null);
    }

    /** The ray from the eye through a point of the canvas (client coordinates): { origin, direction }. */
    ray(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
      const eye = this.eye();
      const f = unit(sub(this.target, eye));
      const s = unit(cross(f, [0, 1, 0]));
      const u = cross(s, f);
      const t = Math.tan(FOV / 2);
      const aspect = rect.width / rect.height;
      const direction = unit([
        f[0] + s[0] * nx * t * aspect + u[0] * ny * t,
        f[1] + s[1] * nx * t * aspect + u[1] * ny * t,
        f[2] + s[2] * nx * t * aspect + u[2] * ny * t,
      ]);
      return { origin: eye, direction };
    }

    /**
     * The first block the ray meets: `solid(x, y, z)` says whether a block is there. Blocks are cubes centred on whole
     * numbers. Answers [x, y, z], or null when there is none within `reach`.
     */
    pick(clientX, clientY, solid, reach = 400) {
      const { origin, direction } = this.ray(clientX, clientY);
      const cell = origin.map((v) => Math.round(v));
      const step = direction.map((v) => (v > 0 ? 1 : -1));
      const delta = direction.map((v) =>
        v === 0 ? Infinity : Math.abs(1 / v),
      );
      const next = origin.map((v, i) =>
        direction[i] === 0
          ? Infinity
          : (step[i] > 0 ? cell[i] + 0.5 - v : v - (cell[i] - 0.5)) * delta[i],
      );
      let travelled = 0;
      while (travelled < reach) {
        if (cell[1] <= this.cut && solid(cell[0], cell[1], cell[2]))
          return cell;
        const axis =
          next[0] < next[1]
            ? next[0] < next[2]
              ? 0
              : 2
            : next[1] < next[2]
              ? 1
              : 2;
        travelled = next[axis];
        next[axis] += delta[axis];
        cell[axis] += step[axis];
      }
      return null;
    }

    pointers() {
      const canvas = this.canvas;
      const down = new Map();
      let pinch = 0;
      const moved = () => {
        this.changed = true;
        if (this.onMove) this.onMove();
      };
      canvas.addEventListener("contextmenu", (e) => e.preventDefault());
      canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);
        down.set(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
          button: e.button,
          shift: e.shiftKey,
        });
        pinch = 0;
      });
      const up = (e) => down.delete(e.pointerId);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", up);
      canvas.addEventListener("pointermove", (e) => {
        const p = down.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;
        if (down.size === 2) {
          // two fingers: pinch to zoom
          const [a, b] = [...down.values()];
          const apart = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch) this.zoom(pinch / apart);
          pinch = apart;
          return moved();
        }
        if (p.button === 2 || p.button === 1 || p.shift) this.pan(dx, dy);
        else {
          this.yaw -= dx * 0.008;
          this.pitch = Math.min(1.5, Math.max(-1.2, this.pitch + dy * 0.008));
        }
        moved();
      });
      canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          this.zoom(Math.exp(e.deltaY * 0.0012));
          moved();
        },
        { passive: false },
      );
    }

    zoom(factor) {
      this.distance = Math.min(600, Math.max(2.5, this.distance * factor));
      this.changed = true;
    }

    /** Slide what the camera looks at, by a drag of this many pixels. */
    pan(dx, dy) {
      const eye = this.eye();
      const f = unit(sub(this.target, eye));
      const s = unit(cross(f, [0, 1, 0]));
      const u = cross(s, f);
      const k =
        (this.distance * Math.tan(FOV / 2) * 2) / this.canvas.clientHeight;
      for (let i = 0; i < 3; i++)
        this.target[i] += (-dx * s[i] + dy * u[i]) * k;
      this.panned = true; // the owner stops following its turtle
      this.changed = true;
    }

    /** Stand back far enough to see a box of the world, looking at its middle. */
    frame(min, max) {
      this.target = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
      const size = Math.hypot(
        max[0] - min[0] + 1,
        max[1] - min[1] + 1,
        max[2] - min[2] + 1,
      );
      this.distance = Math.min(
        600,
        Math.max(8, (size / 2 / Math.tan(FOV / 2)) * 1.05),
      );
      this.changed = true;
    }
  }

  window.craftosBlockScene = { BlockScene, Sides };
})();
