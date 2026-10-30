# Vehicle timelapse

Every scheduled vehicle on the routes in a map view, moving through one service day. Each vehicle follows its trip's shape, reaches each stop at its scheduled time, and leaves a trail in its route's color that fades behind it. The positions come from static GTFS schedules alone, with no realtime data.

The app uses two Transitland APIs:

- The **REST API** for the routes in view, and for each route's stop patterns on the day, with their timetables and shapes.
- The **vector tiles** for the route lines under the vehicles.

The basemap is [OpenFreeMap](https://openfreemap.org), which needs no key.

## Running it

You need Node.js 22 or later, [pnpm](https://pnpm.io), and a Transitland API key. To get a key, see [Signing up for an API key](https://www.transit.land/documentation#sign-up).

```sh
pnpm install
TRANSITLAND_API_KEY=your-key pnpm dev
```

Then open http://localhost:5173, and press **Load this view**. The map opens on Santa Cruz, California. Pan and zoom elsewhere, pick a date, and load again.

The app sends its requests to Vite's dev server, which forwards them to Transitland and adds your key from `TRANSITLAND_API_KEY`. Your key never reaches the browser. The dev server reads no `.env` files, so set the key in the shell that runs `pnpm dev`.

## What a load costs

Each load makes one request for the routes in view, then one request per route. Each REST request counts against your plan's monthly allowance. The opening view of Santa Cruz has about two dozen routes, so loading it costs about 25 requests.

A view with more than 50 routes is refused, so that a load can't use up your allowance by accident. To load bigger areas, raise `MAX_ROUTES` in [src/main.ts](src/main.ts).

Vector tile requests don't count against the REST allowance. Plans include tiles under fair use.

## How it works

1. `GET /api/v2/rest/routes?bbox=west,south,east,north` returns the routes with a stop in view, with their colors.
2. For each route, `GET /api/v2/rest/routes/{id}/patterns?service_date=YYYY-MM-DD&include_timetable=true&include_shapes=true&encoding=polyline` returns the route's stop patterns that run on the date. Each pattern has a timetable and the shapes its trips follow.
   - A timetable's grids hold arrival times, departure times, and distances along the shape: a row per stop and a value per trip, written as encoded polylines.
   - Each shape comes as an encoded polyline, with the distance along it at each point.
3. [src/schedule.ts](src/schedule.ts) decodes the grids and polylines, and turns each trip into a run: the times its vehicle reaches each stop, and how far along its shape each stop is. A frequency-based trip makes a run for each start its frequencies give.
4. On each animation frame, [src/main.ts](src/main.ts) finds where each run's vehicle is. It works out how far along its shape the vehicle has driven at that time, then finds the point on the shape that distance along. The vehicles are drawn as a GeoJSON source on a MapLibre map.
5. On the same frame, [src/trails.ts](src/trails.ts) collects the stretch of shape each vehicle drove during the trail's length, with the time it passed each point. [src/trail-layer.ts](src/trail-layer.ts) draws those stretches as a MapLibre custom layer in WebGL, and fades each point by how long ago the vehicle passed it.

The files:

- [src/api.ts](src/api.ts): the two REST requests, and the parts of their responses the app reads.
- [src/schedule.ts](src/schedule.ts): decoding, and the vehicles' positions.
- [src/trails.ts](src/trails.ts): the stretches each vehicle drove, as segments for the trail layer.
- [src/trail-layer.ts](src/trail-layer.ts): the WebGL layer that draws and fades the trails.
- [src/main.ts](src/main.ts): the map, loading, playback, and each route's color.
- [vite.config.ts](vite.config.ts): the dev server, which adds your key.

## Things to try

- **Trips past midnight.** A trip that leaves at 11:30 pm belongs to that day's service, so its vehicle is still running after midnight of the next calendar day. This app loads one service date, so the early morning misses those vehicles. Load the day before as well, and shift its times back by a day.
- **Other colors.** Vehicles and trails take their route's `route_color` from `routeColor` in [src/main.ts](src/main.ts), with gray for a route that has none. Color them by route type, agency, or how often the route runs instead. The routes request returns more than the app reads, so add the fields you need to `Route` in [src/api.ts](src/api.ts).

## Another server

`TRANSITLAND_API_URL` points the dev server at another Transitland API, such as your own [transitland-lib](https://github.com/interline-io/transitland-lib) server:

```sh
TRANSITLAND_API_URL=http://localhost:8080 pnpm dev
```

That server answers REST requests under `/rest`, but it serves no vector tiles, so the map has no route lines.
