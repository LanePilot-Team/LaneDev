/**
 * 臺灣道路中央槽化帶的純視覺參數與幾何小工具。
 *
 * 這個檔案刻意不讀取 journal、編輯器或導航狀態；它只負責繪圖，
 * 避免槽化樣式反向改變道路與交通語意。
 */
export const TAIWAN_YELLOW_HATCH_V1 = {
  stripeWidthM: 0.18,
  stripePitchM: 1.25,
  insetM: 0.30,
  minLengthM: 3,
  referenceBandWidthM: 3.2,
} as const

export function buildCappedTriangleRange(input: {
  taperStartM: number
  stopBoundaryM: number
  movingAt: (distanceM: number) => number
  fixedOffsetM: number
}) {
  if (input.stopBoundaryM - input.taperStartM < TAIWAN_YELLOW_HATCH_V1.minLengthM) {
    return null
  }
  return {
    startM: input.taperStartM,
    endM: input.stopBoundaryM,
    movingAt: input.movingAt,
    fixedOffsetM: input.fixedOffsetM,
  }
}

/** 單邊偏心道未使用端位於移動雙黃線的相反側。 */
export function singleBayUnusedSideOffsets(
  direction: 'forward' | 'backward', halfCenterWidthM: number, dividerOffsetM = 0,
) {
  return direction === 'forward'
    ? {
        movingStart: dividerOffsetM - halfCenterWidthM,
        unusedBoundary: dividerOffsetM + halfCenterWidthM,
      }
    : {
        movingStart: dividerOffsetM + halfCenterWidthM,
        unusedBoundary: dividerOffsetM - halfCenterWidthM,
      }
}

export function buildHatchDistances(
  startM: number,
  endM: number,
  pitchM = TAIWAN_YELLOW_HATCH_V1.stripePitchM,
): number[] {
  if (!(endM > startM) || !(pitchM > 0)) return []
  const out: number[] = []
  for (
    let distance = Math.ceil(startM / pitchM) * pitchM;
    distance <= endM - TAIWAN_YELLOW_HATCH_V1.insetM + 1e-6;
    distance += pitchM
  ) {
    out.push(Number(distance.toFixed(6)))
  }
  return out
}
