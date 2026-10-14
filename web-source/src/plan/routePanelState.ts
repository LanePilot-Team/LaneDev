export function nextRoutePanelCollapsed(collapsed: boolean): boolean {
  return !collapsed
}

export function routePanelToggleLabel(collapsed: boolean): string {
  return collapsed ? '展開路線卡片' : '縮小路線卡片'
}
