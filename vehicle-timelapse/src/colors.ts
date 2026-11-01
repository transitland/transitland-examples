import type { Route } from './api'

// What a route's color shows: its own route_color, or its route type.
export type ColorMode = 'route_color' | 'route_type'

// For a route without a route_color, or of a type with no color of its own.
export const NO_ROUTE_COLOR = '#888888'

// Tableau 10, a categorical colormap. Each basic route type takes the color at its
// place in BASIC_ROUTE_TYPES, so a type keeps its color from one area to the next.
const TABLEAU_10 = ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab']

// GTFS's basic route types: tram, subway, rail, bus, ferry, cable tram, aerial
// lift, funicular, trolleybus and monorail.
const BASIC_ROUTE_TYPES = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12]

// A route's color in a color mode, as #rrggbb.
export function routeColor (route: Route, mode: ColorMode): string {
  if (mode === 'route_type') {
    return TABLEAU_10[BASIC_ROUTE_TYPES.indexOf(route.route_type_basic)] ?? NO_ROUTE_COLOR
  }
  const hex = (route.route_color ?? '').replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : NO_ROUTE_COLOR
}
