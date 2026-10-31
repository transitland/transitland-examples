import type { Timetable } from './api'

// Where each vehicle is during a service day, from the static schedule alone: it
// reaches each stop at its scheduled time, and moves along its trip's shape at
// an even speed between stops.

// A shape: its points as [lon, lat], and the distance along it at each, in meters.
export interface Shape {
  coords: [number, number][]
  distances: number[]
}

// One vehicle's run through the day: the times it is at stops, in seconds since
// midnight, and how far along its shape each stop is. A stop where it waits
// appears twice, at arrival and at departure.
export interface Run {
  routeId: number
  shapeId: number
  times: number[]
  distances: number[]
}

// A GTFS time, HH:MM:SS, in seconds. Hours run past 24 for a trip that runs past
// midnight.
function parseTime (s: string): number {
  const [h = 0, m = 0, sec = 0] = s.split(':').map(Number)
  return h * 3600 + m * 60 + sec
}

// Every run a stop pattern's trips make on the day. A trip without a shape makes
// none, since its vehicle would have no path.
export function timetableRuns (timetable: Timetable, routeId: number): Run[] {
  const seconds = (grid: (string | null)[][]) => grid.map(row => row.map(t => t === null ? null : parseTime(t)))
  const arrivals = seconds(timetable.arrival_times.values)
  const departures = seconds(timetable.departure_times.values)
  const distances = timetable.shape_distances.values
  const runs: Run[] = []
  timetable.trips.forEach((trip, j) => {
    const shapeId = trip.shape?.id
    if (shapeId === undefined) {
      return
    }
    const times: number[] = []
    const along: number[] = []
    for (let i = 0; i < distances.length; i++) {
      const distance = distances[i]![j]
      // Either time stands in for the other where the feed left one blank.
      const arrive = arrivals[i]![j] ?? departures[i]![j]
      const leave = departures[i]![j] ?? arrive
      // A stop time out of order would send the vehicle back in time, so it is
      // skipped, and the vehicle drives straight on to the next stop.
      if (distance == null || arrive == null || leave == null || arrive < (times[times.length - 1] ?? 0)) {
        continue
      }
      times.push(arrive)
      along.push(distance)
      if (leave > arrive) {
        times.push(leave)
        along.push(distance)
      }
    }
    if (times.length === 0) {
      return
    }

    // A frequency-based trip runs its stop times again from each start its
    // frequencies give, measured from its first departure. Starts stop short of
    // each frequency's end time.
    const starts: number[] = []
    for (const f of trip.frequencies ?? []) {
      const end = parseTime(f.end_time)
      for (let t = parseTime(f.start_time); f.headway_secs > 0 && t < end; t += f.headway_secs) {
        starts.push(t)
      }
    }
    const anchor = departures.find(row => row[j] != null)?.[j] ?? times[0]!
    const offsets = starts.length > 0 ? starts.map(t => t - anchor) : [0]
    for (const offset of offsets) {
      runs.push({ routeId, shapeId, times: times.map(t => t + offset), distances: along })
    }
  })
  return runs
}

// How far along its shape a run's vehicle is at a time, in meters, or undefined
// before the run starts and after it ends.
function runDistance (run: Run, time: number): number | undefined {
  const { times, distances } = run
  const n = times.length
  if (n === 0 || time < times[0]! || time > times[n - 1]!) {
    return undefined
  }
  for (let i = 1; i < n; i++) {
    const t1 = times[i]!
    if (time > t1) {
      continue
    }
    const t0 = times[i - 1]!
    const f = t1 > t0 ? (time - t0) / (t1 - t0) : 1
    return distances[i - 1]! + (distances[i]! - distances[i - 1]!) * f
  }
  return distances[n - 1]
}

// The point a distance along a shape, between the two points whose distances
// bracket it, and held to the shape's ends.
export function shapePoint (shape: Shape, distance: number): [number, number] {
  const { coords, distances } = shape
  const n = distances.length
  if (distance <= distances[0]!) {
    return coords[0]!
  }
  if (distance >= distances[n - 1]!) {
    return coords[n - 1]!
  }
  // A binary search for the last point at or before the distance.
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (distances[mid]! <= distance) {
      lo = mid
    } else {
      hi = mid
    }
  }
  const d0 = distances[lo]!
  const f = distances[hi]! > d0 ? (distance - d0) / (distances[hi]! - d0) : 0
  const [lon0, lat0] = coords[lo]!
  const [lon1, lat1] = coords[hi]!
  return [lon0 + (lon1 - lon0) * f, lat0 + (lat1 - lat0) * f]
}

// Where a run's vehicle is at a time, or undefined when it isn't running.
export function vehiclePosition (run: Run, shape: Shape, time: number): [number, number] | undefined {
  const d = runDistance(run, time)
  return d === undefined ? undefined : shapePoint(shape, d)
}
