export async function reportRoadEditSave(
  flush: () => Promise<void>,
  report: (message: string) => void,
  warnings: string[],
): Promise<void> {
  const warning = warnings.join('；')
  report(warning
    ? `${warning}；其餘道路設定正在儲存…`
    : '道路設定已套用，正在儲存…')
  try {
    await flush()
    report(warning
      ? `道路設定已儲存；${warning}`
      : '道路設定已儲存並套用')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    report(`設定仍保留在此瀏覽器，但尚未寫入資料庫：${detail}`
      + (warning ? `；${warning}` : ''))
  }
}
