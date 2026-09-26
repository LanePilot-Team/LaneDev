(() => ({
  ready: !document.querySelector('.loading'),
  loading: document.querySelector('.loading')?.innerText ?? null,
  elapsed: performance.now(),
  measures: performance.getEntriesByType('measure').filter(m => m.name.startsWith('lanedev-boot:'))
    .map(m => ({ name: m.name, duration: Math.round(m.duration), end: Math.round(m.startTime + m.duration) })),
}))()
