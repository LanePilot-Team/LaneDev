// Some OSM shared-bike stations were classified as "other" in the source data.
export function isTransitPlace(place) {
  return place.category === 'transport'
    || /bicycle_rental|bus_station|bus_stop|public_transport|railway=(station|halt|tram_stop)/.test(place.rawCategory ?? '')
}
