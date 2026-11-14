const button = document.getElementById('offline-prepare');
const status = document.getElementById('offline-status');
button.textContent = '檢查離線內容';

async function check() {
  button.disabled = true;
  status.textContent = '正在檢查本機影片…';
  try {
    const response = await fetch('./routes.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('無法讀取路線清單');
    const { routes } = await response.json();
    const totals = { car: 0, scooter: 0 };
    const ready = { car: 0, scooter: 0 };
    for (const vehicles of Object.values(routes)) {
      for (const vehicle of ['car', 'scooter']) {
        for (const screen of ['real', 'google', 'nav']) {
          const src = vehicles[vehicle]?.[screen]?.src;
          if (!src) continue;
          totals[vehicle]++;
          const file = await fetch(src, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
          if (file?.ok && Number(file.headers.get('content-length')) > 0 &&
              file.headers.get('content-type')?.startsWith('video/')) ready[vehicle]++;
        }
      }
    }
    const complete = ready.car === 51 && ready.scooter === 54;
    status.textContent = `汽車 ${ready.car}／${totals.car} 支，機車 ${ready.scooter}／${totals.scooter} 支。` +
      (complete ? '離線內容已備妥。' : '請重新解壓完整資料夾。');
  } catch (error) {
    status.textContent = `無法檢查離線內容。${error.message}`;
  } finally {
    button.disabled = false;
  }
}
button.addEventListener('click', check);
check();
