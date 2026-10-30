// The two Transitland REST API requests the timelapse makes, and the parts of
// their responses it reads. Paths start at /rest, which the dev server forwards
// to the API with your key (see vite.config.ts).

// A route, as /rest/routes returns it.
export interface Route {
  id: number
  // Six hex digits, without a '#', or empty when the feed gives none.
  route_color: string | null
}

// One stop pattern's timetable, from /rest/routes/{route_key}/patterns with
// encoding=polyline. Each grid holds an encoded row per stop of the pattern,
// with a value per trip in the order of `trips` (see decodeGrid in schedule.ts).
export interface Timetable {
  trips: {
    id: number
    shape: { id: number } | null
    // Set for a frequency-based trip, whose stop times are a template the
    // vehicle runs again at each headway.
    frequencies: { start_time: string, end_time: string, headway_secs: number }[] | null
  }[]
  arrival_times: { polyline: string[] }
  departure_times: { polyline: string[] }
  // Meters along the trip's shape at each stop.
  shape_distances: { polyline: string[] }
}

// A stop pattern: a sequence of stops a route's trips serve, with the trips that
// serve it on the requested date.
export interface Pattern {
  timetable: Timetable | null
  // The shapes the pattern's trips follow, each with the distance along it at
  // each of its points, in meters.
  shapes: { id: number, polyline: string | null, distances: number[] | null }[]
}

// A response's data, or what went wrong.
export type Result<T> = { data: T } | { error: string }

// fetch rejects on a network error and json() on a body that isn't JSON, so
// each of those calls is caught and its failure returned as a value.
async function get<T> (path: string, params: Record<string, string>): Promise<Result<T>> {
  let res: Response
  try {
    res = await fetch(`${path}?${new URLSearchParams(params)}`)
  } catch (e) {
    return { error: String(e) }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { error: `${res.status} ${res.statusText}` }
  }
  if (!res.ok) {
    return { error: (body as { error?: string }).error ?? `${res.status} ${res.statusText}` }
  }
  return { data: body as T }
}

// Up to `limit` routes with a stop inside a box, given as west, south, east and
// north edges.
export async function fetchRoutes (bbox: [number, number, number, number], limit: number): Promise<Result<Route[]>> {
  const res = await get<{ routes: Route[] }>('/rest/routes', {
    bbox: bbox.join(','),
    limit: String(limit)
  })
  return 'error' in res ? res : { data: res.data.routes }
}

// A route's stop patterns on a service date, YYYY-MM-DD, with their timetables
// and shapes.
export async function fetchPatterns (routeId: number, date: string): Promise<Result<Pattern[]>> {
  const res = await get<{ routes: { patterns: Pattern[] | null }[] }>(`/rest/routes/${routeId}/patterns`, {
    service_date: date,
    include_timetable: 'true',
    include_shapes: 'true',
    encoding: 'polyline'
  })
  // A route with no trips on the date has no patterns.
  return 'error' in res ? res : { data: res.data.routes.flatMap(r => r.patterns ?? []) }
}
