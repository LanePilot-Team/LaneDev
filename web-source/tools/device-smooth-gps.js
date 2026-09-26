// Debug-WebView test only. Injects measured fixes; never included in APK modules.
(async () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  function refs() {
    const node = document.querySelector('.app')
    let fiber = node[Object.keys(node).find(k => k.startsWith('__reactFiber$'))]
    const values = []
    for (; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        if (hook.memoizedState?.current) values.push(hook.memoizedState.current)
      }
    }
    return values
  }
  const core = refs().find(v => v.mapRef && v.vehicleLayerRef)
  if (!core) throw new Error('App refs unavailable')
  const map = core.mapRef.current
  const layer = core.vehicleLayerRef.current
  const originalWatch = navigator.geolocation.watchPosition
  const originalJump = map.jumpTo
  const originalNav = layer.setNav
  const cameras = [], vehicles = [], sources = [], restores = []
  let callback, controlled = false
  navigator.geolocation.watchPosition = function(success, error, options) {
    callback = success
    return originalWatch.call(this, fix => { if (!controlled) success(fix) }, error, options)
  }
  map.jumpTo = function(options, ...rest) {
    if (options.center) cameras.push({ at: performance.now(), pos: options.center })
    return originalJump.call(this, options, ...rest)
  }
  layer.setNav = function(pos, ...rest) {
    if (pos) vehicles.push({ at: performance.now(), pos })
    return originalNav.call(this, pos, ...rest)
  }
  for (const id of ['roads','roadSurfaces','dividers','buildings','occludedBuildings']) {
    const source = map.getSource(id)
    for (const method of ['setData','updateData']) {
      const original = source[method]
      source[method] = function(data, ...rest) {
        sources.push({ id, method, count: data?.features?.length ?? data?.add?.length ?? 0 })
        return original.call(this, data, ...rest)
      }
      restores.push(() => { source[method] = original })
    }
  }
  try {
    const button = [...document.querySelectorAll('button')].find(b => b.innerText === '開始導航')
    if (!button || button.disabled) throw new Error('Plan route first')
    button.click()
    for (let i=0; i<60 && (!callback || !document.querySelector('.banner')); i++) await delay(100)
    const driver = refs().find(v => v.displayPath && typeof v.start === 'function')
    if (!callback || !driver) throw new Error('GPS driver unavailable')
    controlled = true
    const { coords, cum } = driver.displayPath
    function at(distance) {
      let i=1
      while (i<cum.length-1 && cum[i]<distance) i++
      const t=(distance-cum[i-1])/(cum[i]-cum[i-1])
      return coords[i-1].map((n,k)=>n+(coords[i][k]-n)*t)
    }
    let distance = driver.match?.distM ?? 0
    async function inject(step) {
      await delay(1000)
      distance += step
      const pos=at(distance)
      callback({ coords: { longitude:pos[0], latitude:pos[1], accuracy:3, speed:8,
        heading:0, altitude:null, altitudeAccuracy:null }, timestamp:Date.now() })
    }
    cameras.length=vehicles.length=0
    for (let i=0; i<4; i++) await inject(8)
    await delay(1200)
    const movingFrames = cameras.length
    const uniquePositions = new Set(cameras.map(f=>f.pos.join(','))).size
    if (movingFrames < 12 || uniquePositions < 12) throw new Error('GPS movement is still stepping')
    const intervals=cameras.slice(1).map((f,i)=>f.at-cameras[i].at).filter(n=>n<1000).sort((a,b)=>a-b)
    const stoppedFrames = vehicles.length
    await delay(500)
    if (vehicles.length !== stoppedFrames) throw new Error('Animation continued without new GPS')
    map.fire('dragstart', { originalEvent: {} })
    await delay(100)
    const cameraBefore = cameras.length, vehicleBefore = vehicles.length
    await inject(8)
    await delay(1200)
    if (cameras.length !== cameraBefore) throw new Error('Camera stole manual control')
    if (vehicles.length <= vehicleBefore) throw new Error('Vehicle stopped when camera detached')
    if (sources.some(s=>s.method==='setData')) throw new Error('Full static layer upload during navigation')
    return { injectedFixes:5, movingFrames, uniquePositions,
      p50FrameIntervalMs: intervals[Math.floor(intervals.length*0.5)],
      p95FrameIntervalMs: intervals[Math.floor(intervals.length*0.95)],
      stoppedWhenNoFix:true, manualCameraPreserved:true, vehicleUpdatesWhileDetached:vehicles.length-vehicleBefore,
      sourceUpdates:sources }
  } finally {
    [...document.querySelectorAll('button')].find(b=>b.innerText.includes('結束'))?.click()
    navigator.geolocation.watchPosition=originalWatch
    map.jumpTo=originalJump
    layer.setNav=originalNav
    restores.forEach(restore=>restore())
  }
})()
