import { MercatorCoordinate } from 'maplibre-gl'
import { shapePoint, type Run, type Shape } from './schedule'

// Vehicle trails as the WebGL layer draws them: the stretches of shape each
// vehicle drove in the trail's time before now, with the times it started and
// finished each. Rebuilt every frame, since the stretches follow the vehicles;
// the layer fades each by how long ago it was driven.

// Floats per segment: start x and y, end x and y, start time, end time, then x
// and y of the path's point before the start and of its point after the end,
// which the layer joins the neighboring segments at.
export const TRAIL_SEGMENT_FLOATS = 10

export interface TrailSegments {
  // The Web Mercator point positions are measured from, so they keep their
  // precision as 32-bit floats.
  origin: [number, number]
  // TRAIL_SEGMENT_FLOATS per segment, positions in Web Mercator world units (0 to
  // 1 across the world, as MapLibre's MercatorCoordinate measures them) and times
  // in seconds from midnight.
  positions: Float32Array
  // RGBA bytes per segment.
  colors: Uint8Array
  count: number
}

// '#rrggbb' as bytes; gray for anything else.
function colorBytes (color: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    return [170, 170, 170]
  }
  return [1, 3, 5].map(i => Number.parseInt(color.slice(i, i + 2), 16)) as [number, number, number]
}

// The index of the first of a shape's points past a distance along it.
function firstPointPast (distances: number[], distance: number): number {
  let lo = 0
  let hi = distances.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (distances[mid]! <= distance) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

// The points a run's vehicle drove through, in Web Mercator, with when it
// reached and when it left each, from the leg it was on at `from` to the one it
// is on at `time`, and one point past it.
interface TrailPath {
  xs: number[]
  ys: number[]
  arrive: number[]
  leave: number[]
}

// Between two stops, the path follows the shape's points, reached at times
// between the stops' in proportion to distance. A point the vehicle waited at is
// one point, left when the wait ended.
function runPath (run: Run, shape: Shape, from: number, time: number): TrailPath {
  const path: TrailPath = { xs: [], ys: [], arrive: [], leave: [] }
  function visit (p: [number, number], t: number) {
    const { x, y } = MercatorCoordinate.fromLngLat(p)
    const n = path.xs.length
    if (n > 0 && path.xs[n - 1] === x && path.ys[n - 1] === y) {
      path.leave[n - 1] = t
      return
    }
    path.xs.push(x)
    path.ys.push(y)
    path.arrive.push(t)
    path.leave.push(t)
  }
  const { times, distances } = run
  for (let k = 1; k < times.length; k++) {
    const t0 = times[k - 1]!
    const t1 = times[k]!
    if (t1 < from) {
      continue
    }
    if (t0 > time) {
      break
    }
    const d0 = distances[k - 1]!
    const d1 = distances[k]!
    visit(shapePoint(shape, d0), t0)
    for (let v = firstPointPast(shape.distances, d0); v < shape.distances.length && shape.distances[v]! < d1; v++) {
      const tv = t0 + (shape.distances[v]! - d0) / (d1 - d0) * (t1 - t0)
      visit(shape.coords[v]!, tv)
      if (tv > time) {
        break
      }
    }
    visit(shapePoint(shape, d1), t1)
  }
  return path
}

// The path without the points closer than minStep to the last one kept, its
// ends excepted. A segment shorter than the trail is wide folds its mitered quad
// over itself, and the fold draws darker.
function thinPath (path: TrailPath, minStep: number): TrailPath {
  const n = path.xs.length
  if (n < 3 || minStep <= 0) {
    return path
  }
  const out: TrailPath = { xs: [], ys: [], arrive: [], leave: [] }
  for (let i = 0; i < n; i++) {
    const k = out.xs.length - 1
    if (k >= 0 && i < n - 1 && Math.hypot(path.xs[i]! - out.xs[k]!, path.ys[i]! - out.ys[k]!) < minStep) {
      continue
    }
    out.xs.push(path.xs[i]!)
    out.ys.push(path.ys[i]!)
    out.arrive.push(path.arrive[i]!)
    out.leave.push(path.leave[i]!)
  }
  return out
}

// The segments every run drove between time - trailSeconds and time, each in
// its route's color. minStep, in Web Mercator world units, is the shortest
// segment drawn, which the app sets to the trail's width on screen.
export function buildTrailSegments (
  runs: Run[],
  shapes: Map<number, Shape>,
  routeColors: Map<number, string>,
  time: number,
  trailSeconds: number,
  minStep: number
): TrailSegments {
  const from = time - trailSeconds
  const positions: number[] = []
  const colors: number[] = []
  let origin: [number, number] | undefined
  for (const run of runs) {
    const color = routeColors.get(run.routeId)
    const shape = shapes.get(run.shapeId)
    const { times } = run
    if (!color || !shape || times.length < 2 || times[times.length - 1]! < from || times[0]! > time) {
      continue
    }
    const rgb = colorBytes(color)
    const { xs, ys, arrive, leave } = thinPath(runPath(run, shape, from, time), minStep)
    const last = xs.length - 1
    for (let i = 0; i < last; i++) {
      // Only what the trail shows: driven after it begins, and not after now.
      if (arrive[i + 1]! < from || leave[i]! > time) {
        continue
      }
      origin ??= [xs[i]!, ys[i]!]
      const [ox, oy] = origin
      // A path's ends have no neighbor, and stand in for their own.
      const p = Math.max(i - 1, 0)
      const n = Math.min(i + 2, last)
      positions.push(
        xs[i]! - ox, ys[i]! - oy, xs[i + 1]! - ox, ys[i + 1]! - oy,
        leave[i]!, arrive[i + 1]!,
        xs[p]! - ox, ys[p]! - oy, xs[n]! - ox, ys[n]! - oy
      )
      colors.push(rgb[0], rgb[1], rgb[2], 255)
    }
  }
  return {
    origin: origin ?? [0, 0],
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
    count: colors.length / 4
  }
}
