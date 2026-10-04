(async () => {
  const wait = ms => new Promise(r=>setTimeout(r,ms))
  const assert = (ok,msg) => {if(!ok)throw new Error(msg)}
  let fiber = document.querySelector('.app')[Object.keys(document.querySelector('.app')).find(k=>k.startsWith('__reactFiber$'))]
  let core
  for(;fiber;fiber=fiber.return) for(let h=fiber.memoizedState;h;h=h.next){if(h.memoizedState?.current?.mapRef)core=h.memoizedState.current}
  const map=core.mapRef.current
  map.fire('dragstart',{originalEvent:{}})
  const original = {center:map.getCenter(),zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing(),padding:map.getPadding(),elevation:map.getCameraTargetElevation()}
  const solid=map.getSource('buildings'), faded=map.getSource('occludedBuildings')
  const features=[...(await solid.getData()).features,...(await faded.getData()).features]
  const candidates=features.filter(f=>f.geometry.type==='Polygon' && (f.properties.min_height_m??0)===0 && f.properties.height_m>=15).slice(0,20)
  const originals=[]
  const counts={setData:0,updateData:0}
  for(const source of [solid,faded]) for(const name of Object.keys(counts)) {
    const fn=source[name];originals.push(()=>source[name]=fn)
    source[name]=function(...args){counts[name]++;return fn.apply(this,args)}
  }
  let detected
  try {
    for(const feature of candidates) {
      const ring=feature.geometry.coordinates[0].slice(0,-1)
      const center=ring.reduce((a,p)=>[a[0]+p[0]/ring.length,a[1]+p[1]/ring.length],[0,0])
      map.jumpTo({center,zoom:19,pitch:60,bearing:180,elevation:0,padding:{top:0,bottom:0,left:0,right:0}})
      await wait(450)
      if((await faded.getData()).features.some(f=>f.id===feature.id)){detected={id:feature.id,center,height:feature.properties.height_m};break}
    }
    assert(detected,'ordinary building did not fade with camera movement')
    const fadedCount=(await faded.getData()).features.length
    for(let i=0;i<20;i++){map.jumpTo({bearing:i*3});await wait(16)}
    await wait(300)
    map.jumpTo({zoom:13})
    await wait(400)
    assert((await faded.getData()).features.length===0,'buildings did not restore below 3D zoom')
    assert((await solid.getData()).features.length===features.length,'building feature count changed')
    assert(counts.setData===0,'camera caused full source upload')
    return {detected,fadedCount,restored:features.length,counts,worksWithoutGpsFix:true}
  } finally {originals.forEach(fn=>fn());map.jumpTo(original)}
})()
