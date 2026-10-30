# Transitland examples

Small apps built on the [Transitland](https://www.transit.land) APIs. Each directory holds one example with its own README and dependencies, so you can copy a directory out and run it by itself.

| Example | What it shows | APIs | Requests per run |
|---|---|---|---|
| [vehicle-timelapse](vehicle-timelapse/) | Every scheduled vehicle in an area moving through one day, with fading trails | REST routes and route patterns, vector tiles | One, plus one per route in view |

The examples need a Transitland API key. To get one, see [Signing up for an API key](https://www.transit.land/documentation#sign-up). Each REST request counts against your plan's monthly allowance, so each README says how many requests its example makes.

The code is under the [MIT License](LICENSE). The transit data the APIs return stays under each feed's own license.
