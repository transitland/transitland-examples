import type * as maplibre from 'maplibre-gl'
import { TRAIL_SEGMENT_FLOATS, type TrailSegments } from './trails'

// Each segment is one instance: a quad stretched from its start to its end and
// widened across it in screen pixels. Time runs along the quad with the vehicle,
// so the fragment shader can tell how long ago each point was driven.
//
// Each end's corners sit on the miter between the segment and its neighbor, which
// the neighbor computes from the same three points. The quads meet edge to edge,
// so a translucent trail is not drawn twice at a shape's points.
const VERTEX_SHADER = `#version 300 es
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_width;
// The quad's corner: along the segment (0 or 1) and across it (-1 or 1).
in vec2 a_corner;
in vec4 a_ends;
in vec2 a_times;
// The path's point before the start, and its point after the end.
in vec4 a_neighbors;
in vec4 a_color;
out float v_time;
out vec4 v_color;

vec4 project(vec2 p) {
  return u_matrix * vec4(p, 0.0, 1.0);
}

// On screen, in device pixels from the center.
vec2 screen(vec4 c) {
  return c.xy / c.w * u_viewport * 0.5;
}

// A step's unit normal on screen, or zero for no step.
vec2 normalOf(vec2 d) {
  float len = length(d);
  return len > 0.0 ? vec2(-d.y, d.x) / len : vec2(0.0);
}

// Where a path from a turning at b toward c has its left edge, from b in half
// widths. The miter is capped, so a hairpin pinches rather than spikes.
vec2 join(vec2 a, vec2 b, vec2 c) {
  vec2 n0 = normalOf(b - a);
  vec2 n1 = normalOf(c - b);
  if (n0 == vec2(0.0)) {
    n0 = n1;
  }
  if (n1 == vec2(0.0)) {
    n1 = n0;
  }
  vec2 m = n0 + n1;
  float len = length(m);
  if (len < 0.001) {
    return n1;
  }
  m /= len;
  return m / max(dot(m, n1), 0.5);
}

void main() {
  vec4 start = project(a_ends.xy);
  vec4 end = project(a_ends.zw);
  vec2 s = screen(start);
  vec2 e = screen(end);
  vec2 edge = a_corner.x == 0.0
    ? join(screen(project(a_neighbors.xy)), s, e)
    : join(s, e, screen(project(a_neighbors.zw)));
  vec4 p = a_corner.x == 0.0 ? start : end;
  p.xy += edge * a_corner.y * u_width / u_viewport * p.w;
  gl_Position = p;
  v_time = mix(a_times.x, a_times.y, a_corner.x);
  v_color = a_color;
}`

// Nothing ahead of the vehicle, and nothing older than the trail; in between,
// fading with age. Premultiplied, as MapLibre blends.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform float u_time;
uniform float u_trail;
in float v_time;
in vec4 v_color;
out vec4 fragColor;
void main() {
  float age = u_time - v_time;
  if (age < 0.0 || age > u_trail) {
    discard;
  }
  float alpha = 1.0 - age / u_trail;
  fragColor = vec4(v_color.rgb * alpha, alpha);
}`

// Two triangles covering a segment's quad.
const QUAD_CORNERS = new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1])

// A failed compile or link is logged, and the layer draws nothing.
function compileProgram (gl: WebGL2RenderingContext): WebGLProgram | undefined {
  const program = gl.createProgram()
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
    const shader = gl.createShader(type)
    if (!shader) {
      return undefined
    }
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[TrailLayer] shader compile failed:', gl.getShaderInfoLog(shader))
      return undefined
    }
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[TrailLayer] program link failed:', gl.getProgramInfoLog(program))
    return undefined
  }
  return program
}

// Fading vehicle trails, drawn on the GPU, which fades each segment by how long
// ago its vehicle drove it.
export class TrailLayer implements maplibre.CustomLayerInterface {
  readonly id = 'trails'
  readonly type = 'custom'
  readonly renderingMode = '2d'

  private map?: maplibre.Map
  private program?: WebGLProgram
  private vao?: WebGLVertexArrayObject
  private positionBuffer?: WebGLBuffer
  private colorBuffer?: WebGLBuffer
  private uniforms: Record<string, WebGLUniformLocation | null> = {}

  private segments?: TrailSegments
  // Segments set, or buffers made, since the last upload.
  private pending = false
  private time = 0
  // Schedule seconds a trail takes to fade out; 0 draws none.
  private trailSeconds = 0
  // In CSS pixels.
  private width = 0

  // The trails as of a playback time, drawn on the next frame.
  draw (segments: TrailSegments | undefined, time: number, trailSeconds: number, width: number): void {
    this.segments = segments
    this.time = time
    this.trailSeconds = trailSeconds
    this.width = width
    this.pending = true
    this.map?.triggerRepaint()
  }

  onAdd (map: maplibre.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map
    // A restyle removes the layer and adds it again with new buffers, which need
    // the segments it already had.
    this.pending = true
    // Instancing and vertex arrays are WebGL2's.
    if (!(gl instanceof WebGL2RenderingContext)) {
      console.error('[TrailLayer] needs WebGL2; drawing no trails')
      return
    }
    this.program = compileProgram(gl)
    if (!this.program) {
      return
    }
    const program = this.program
    for (const name of ['u_matrix', 'u_viewport', 'u_width', 'u_time', 'u_trail']) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }

    // Our own vertex array, so the per-instance divisors stay out of the state
    // MapLibre draws with.
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)

    const cornerBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_CORNERS, gl.STATIC_DRAW)
    const corner = gl.getAttribLocation(program, 'a_corner')
    gl.enableVertexAttribArray(corner)
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)

    this.positionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer)
    const stride = TRAIL_SEGMENT_FLOATS * 4
    const ends = gl.getAttribLocation(program, 'a_ends')
    gl.enableVertexAttribArray(ends)
    gl.vertexAttribPointer(ends, 4, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(ends, 1)
    const times = gl.getAttribLocation(program, 'a_times')
    gl.enableVertexAttribArray(times)
    gl.vertexAttribPointer(times, 2, gl.FLOAT, false, stride, 16)
    gl.vertexAttribDivisor(times, 1)
    const neighbors = gl.getAttribLocation(program, 'a_neighbors')
    gl.enableVertexAttribArray(neighbors)
    gl.vertexAttribPointer(neighbors, 4, gl.FLOAT, false, stride, 24)
    gl.vertexAttribDivisor(neighbors, 1)

    this.colorBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer)
    const color = gl.getAttribLocation(program, 'a_color')
    gl.enableVertexAttribArray(color)
    gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, 0, 0)
    gl.vertexAttribDivisor(color, 1)

    gl.bindVertexArray(null)
  }

  onRemove (_map: maplibre.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = undefined
    if (!(gl instanceof WebGL2RenderingContext)) {
      return
    }
    gl.deleteProgram(this.program ?? null)
    gl.deleteVertexArray(this.vao ?? null)
    gl.deleteBuffer(this.positionBuffer ?? null)
    gl.deleteBuffer(this.colorBuffer ?? null)
  }

  render (gl: WebGLRenderingContext | WebGL2RenderingContext, options: maplibre.CustomRenderMethodInput): void {
    const segments = this.segments
    if (!(gl instanceof WebGL2RenderingContext) || !this.program || !this.vao || !segments) {
      return
    }
    if (this.pending) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer ?? null)
      gl.bufferData(gl.ARRAY_BUFFER, segments.positions, gl.STATIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer ?? null)
      gl.bufferData(gl.ARRAY_BUFFER, segments.colors, gl.STATIC_DRAW)
      this.pending = false
    }
    if (segments.count === 0 || this.trailSeconds <= 0) {
      return
    }

    // Positions are relative to the segments' origin, so the matrix moves there
    // first. Only its last column changes, computed in 64 bits before the upload
    // rounds it.
    const m = options.defaultProjectionData.mainMatrix
    const [ox, oy] = segments.origin
    const matrix = new Float32Array(m)
    for (let r = 0; r < 4; r++) {
      matrix[12 + r] = m[r]! * ox + m[4 + r]! * oy + m[12 + r]!
    }

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.uniformMatrix4fv(this.uniforms.u_matrix ?? null, false, matrix)
    gl.uniform2f(this.uniforms.u_viewport ?? null, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.uniform1f(this.uniforms.u_width ?? null, this.width * (this.map?.getPixelRatio() ?? 1))
    gl.uniform1f(this.uniforms.u_time ?? null, this.time)
    gl.uniform1f(this.uniforms.u_trail ?? null, this.trailSeconds)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, segments.count)
    gl.bindVertexArray(null)
  }
}
