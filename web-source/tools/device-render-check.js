(async () => {
  const node = document.querySelector('.app')
  let fiber = node[Object.keys(node).find(k => k.startsWith('__reactFiber$'))]
  let core
  for (; fiber && !core; fiber = fiber.return) {
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      if (hook.memoizedState?.current?.mapRef) { core=hook.memoizedState.current; break }
    }
  }
  if (!core) throw new Error('Core not found')
  const map=core.mapRef.current
  const errors=[]
  const error=e=>errors.push(e.error?.message)
  map.on('error',error)
  const zones=await map.getSource('zones').getData()
  const zone=zones.features.find(f=>f.properties.kind==='fill')
  const zoneId=core.zonesRef.current.find(z=>String(zone.id).startsWith(z.id+':'))?.id
  if (!zoneId) throw new Error('Zone identity missing')
  core.setZoneHighlight(zoneId)
  if (!map.getFeatureState({source:'zones',id:zone.id}).highlighted) throw new Error('Zone highlight missing')
  core.setZoneHighlight(null)
  if (map.getFeatureState({source:'zones',id:zone.id}).highlighted) throw new Error('Zone highlight stuck')
  const source=map.getSource('buildings'), overlay=map.getSource('occludedBuildings')
  const original=await source.getData(), building=original.features[0]
  try {
    await source.updateData({remove:[building.id]},true)
    await overlay.updateData({add:[building]},true)
    if ((await source.getData()).features.some(f=>f.id===building.id)) throw new Error('Building not removed')
    if (!(await overlay.getData()).features.some(f=>f.id===building.id)) throw new Error('Overlay missing')
  } finally {
    await source.updateData({add:[building]},true)
    await overlay.updateData({remove:[building.id]},true)
    map.off('error',error)
  }
  if (errors.length) throw new Error(errors.join('; '))
  return { zoneFeatureState:true, buildingIncrementalUpdate:true, restoredBuildingCount:(await source.getData()).features.length,
    externalFontRequests:performance.getEntriesByType('resource').filter(r=>r.name.includes('fonts.openmaptiles')).length }
})()
