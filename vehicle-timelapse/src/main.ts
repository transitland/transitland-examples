import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import './style.css'
import { fetchPatterns, fetchRoutes, type Route } from './api'
import { decodePolyline, timetableRuns, vehiclePosition, type Run, type Shape } from './schedule'
import { TrailLayer } from './trail-layer'
import { buildTrailSegments } from './trails'

// Loading a view costs one request for its routes and one more per route, so a
// view with more routes than this is refused. Raise it to load bigger areas.
const MAX_ROUTES = 50
// Pattern requests in flight at once.
const PARALLEL_REQUESTS = 6
// The map opens on Santa Cruz, California, which has about two dozen routes.
const START_BOUNDS: [number, number, number, number] = [-122.08, 36.95, -121.98, 37.0]
const SECONDS_PER_DAY = 86400
// For a route without a route_color.
const NO_ROUTE_COLOR = '#888888'
// MapLibre's world at zoom 0, in CSS pixels: one 512 pixel tile.
const WORLD_PIXELS = 512

const dateInput = document.getElementById('date') as HTMLInputElement
const loadButton = document.getElementById('load') as HTMLButtonElement
const playButton = document.getElementById('play') as HTMLButtonElement
const speedSelect = document.getElementById('speed') as HTMLSelectElement
const trailSelect = document.getElementById('trail') as HTMLSelectElement
const widthSelect = document.getElementById('width') as HTMLSelectElement
const clock = document.getElementById('clock') as HTMLSpanElement
const timeSlider = document.getElementById('time') as HTMLInputElement
const statusText = document.getElementById('status') as HTMLSpanElement

// Today, in your own time zone.
const today = new Date()
dateInput.value = [today.getFullYear(), today.getMonth() + 1, today.getDate()]
  .map(n => String(n).padStart(2, '0'))
  .join('-')

/////////////////
// Map
/////////////////

// MapLibre looks for its worker beside its own module, which Vite moves when it
// bundles the library, so the app gives it the worker Vite serves.
maplibregl.setWorkerUrl(workerUrl)

const map = new maplibregl.Map({
  container: 'map',
  // OpenFreeMap's basemaps need no key.
  style: 'https://tiles.openfreemap.org/styles/positron',
  bounds: START_BOUNDS
})

// Fading trails behind the vehicles, drawn with WebGL.
const trailLayer = new TrailLayer()

map.on('load', () => {
  // Transitland's route lines, from its vector tiles, which the dev server
  // fetches with your key. Each line takes its route's own color.
  map.addSource('routes', {
    type: 'vector',
    tiles: [`${location.origin}/tiles/routes/tiles/{z}/{x}/{y}.pbf`],
    maxzoom: 14,
    attribution: '<a href="https://www.transit.land">Transitland</a>'
  })
  map.addLayer({
    'id': 'routes',
    'type': 'line',
    'source': 'routes',
    'source-layer': 'routes',
    'paint': {
      'line-color': ['to-color', ['get', 'route_color'], NO_ROUTE_COLOR],
      'line-width': 2,
      'line-opacity': 0.5
    }
  })

  // The vehicles, as dots in their routes' colors, redrawn on every frame.
  map.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'vehicles',
    type: 'circle',
    source: 'vehicles',
    paint: {
      'circle-radius': 4,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#333333',
      'circle-stroke-width': 1
    }
  })

  // The vehicles' trails, under the vehicles.
  map.addLayer(trailLayer, 'vehicles')
  draw()
})

// Trails drop their points closer together than the trail is wide, which
// depends on the zoom.
map.on('zoomend', () => {
  draw()
})

/////////////////
// Loading
/////////////////

// What the loaded view holds: every run its routes make on the date, the shapes
// the runs follow, and each route's color.
let runs: Run[] = []
let shapes = new Map<number, Shape>()
let routeColors = new Map<number, string>()

// Each load's number. A load that finds a newer one started stops, so a slow
// one cannot add its routes to the next one's.
let loadCount = 0

function routeColor (route: Route): string {
  const hex = (route.route_color ?? '').replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : NO_ROUTE_COLOR
}

// The runs on every route with a stop in the map's view, a route per request, so
// the vehicles appear as their routes arrive.
async function load () {
  const n = ++loadCount
  const date = dateInput.value
  runs = []
  shapes = new Map()
  routeColors = new Map()
  draw()

  statusText.textContent = 'Finding routes…'
  const b = map.getBounds()
  // One more than the most allowed, to tell when there are too many.
  const found = await fetchRoutes([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], MAX_ROUTES + 1)
  if (n !== loadCount) {
    return
  }
  if ('error' in found) {
    statusText.textContent = found.error
    return
  }
  const routes = found.data
  if (routes.length > MAX_ROUTES) {
    statusText.textContent = `More than ${MAX_ROUTES} routes in view, each a request to load. Zoom in, or raise MAX_ROUTES in src/main.ts.`
    return
  }
  if (routes.length === 0) {
    statusText.textContent = 'No routes stop in this view.'
    return
  }
  for (const route of routes) {
    routeColors.set(route.id, routeColor(route))
  }

  let done = 0
  let next = 0
  const failures: string[] = []
  // Each worker takes the next route until none are left.
  const worker = async () => {
    while (next < routes.length) {
      const route = routes[next++]!
      const res = await fetchPatterns(route.id, date)
      if (n !== loadCount) {
        return
      }
      done++
      statusText.textContent = `Loading routes… ${done} of ${routes.length}`
      if ('error' in res) {
        failures.push(res.error)
        continue
      }
      for (const pattern of res.data) {
        for (const s of pattern.shapes) {
          if (s.polyline && s.distances && !shapes.has(s.id)) {
            shapes.set(s.id, { coords: decodePolyline(s.polyline), distances: s.distances })
          }
        }
        if (pattern.timetable) {
          runs.push(...timetableRuns(pattern.timetable, route.id))
        }
      }
      draw()
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, worker))
  if (n !== loadCount) {
    return
  }
  statusText.textContent = `${runs.length} runs on ${routes.length} routes, ${date}`
  if (failures.length > 0) {
    statusText.textContent += `. ${failures.length} failed: ${failures[0]}`
  }
}

loadButton.addEventListener('click', () => {
  load()
})

/////////////////
// Playback
/////////////////

// Seconds since midnight. Opens on the morning peak.
let time = 8 * 3600
let playing = false
// The next animation frame asked for, and when the last one ran, by the
// animation clock.
let frame: number | undefined
let lastFrame: number | undefined

// Every running vehicle at the playback time, with its trail, and the clock.
function draw () {
  const features = runs.flatMap((run) => {
    const shape = shapes.get(run.shapeId)
    const position = shape && vehiclePosition(run, shape, time)
    if (!position) {
      return []
    }
    return [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: position },
      properties: { color: routeColors.get(run.routeId) ?? NO_ROUTE_COLOR }
    }]
  })
  map.getSource<maplibregl.GeoJSONSource>('vehicles')?.setData({ type: 'FeatureCollection', features })

  const trailSeconds = Number(trailSelect.value) * 60
  const width = Number(widthSelect.value)
  // The trail's width on screen, in world units, is the shortest segment it draws.
  const minStep = width / (WORLD_PIXELS * 2 ** map.getZoom())
  const segments = trailSeconds > 0 ? buildTrailSegments(runs, shapes, routeColors, time, trailSeconds, minStep) : undefined
  trailLayer.draw(segments, time, trailSeconds, width)

  const minutes = Math.floor(time / 60)
  clock.textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  timeSlider.value = String(time)
}

// Moves the clock on by the real time since the last frame, times the speed.
function tick (now: number) {
  if (lastFrame !== undefined) {
    time = Math.min(SECONDS_PER_DAY, time + Number(speedSelect.value) * (now - lastFrame) / 1000)
  }
  lastFrame = now
  draw()
  if (time >= SECONDS_PER_DAY) {
    setPlaying(false)
    return
  }
  frame = requestAnimationFrame(tick)
}

function setPlaying (on: boolean) {
  playing = on
  playButton.textContent = on ? 'Pause' : 'Play'
  if (frame !== undefined) {
    cancelAnimationFrame(frame)
  }
  frame = undefined
  lastFrame = undefined
  if (on) {
    // Played from the end of the day, it starts again from midnight.
    if (time >= SECONDS_PER_DAY) {
      time = 0
    }
    frame = requestAnimationFrame(tick)
  }
}

playButton.addEventListener('click', () => {
  setPlaying(!playing)
})

timeSlider.addEventListener('input', () => {
  time = Number(timeSlider.value)
  draw()
})

for (const select of [trailSelect, widthSelect]) {
  select.addEventListener('change', () => {
    draw()
  })
}

draw()
