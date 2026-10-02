import type { TerrainAnalysisResult, TerrainDescription } from '../../types'
import { fmtInt, fmtNumber } from '../../utils/format'

/** 根据计算结果自动生成中文地形描述与关键词 */
export function describeTerrain(r: TerrainAnalysisResult): TerrainDescription {
  const { elevation, slope, slopeClasses, aspectHistogram, landform, localReliefMean, triMean } = r
  const paragraphs: string[] = []
  const keywords: string[] = []

  // 段落 1：整体起伏与海拔
  const relief = classifyRelief(elevation.range)
  const elevBand = classifyElevationBand(elevation.mean)
  let p1 = `该区域整体属于${relief}${elevBand}地形，海拔范围为 ${fmtInt(elevation.min)}–${fmtInt(elevation.max)} 米，最大高差达到 ${fmtInt(elevation.range)} 米，平均海拔约 ${fmtInt(elevation.mean)} 米。`
  paragraphs.push(p1)

  // 段落 2：坡度
  const steepest = slopeClasses[slopeClasses.length - 1]
  const flattest = slopeClasses[0]
  let p2 = `区域平均坡度为 ${fmtNumber(slope.mean, 1)}°，最大坡度 ${fmtNumber(slope.max, 1)}°。`
  if (steepest && steepest.ratio > 0.1) {
    p2 += `其中大于 35° 的陡坡区域约占 ${fmtNumber(steepest.ratio * 100, 1)}%。`
  }
  if (flattest && flattest.ratio > 0.3) {
    p2 += `0–5° 的平缓区域约占 ${fmtNumber(flattest.ratio * 100, 1)}%，多分布于地势较低处。`
  }
  paragraphs.push(p2)

  // 段落 3：坡向
  let p3 = ''
  const asp = aspectHistogram.find((b) => b.dir !== '平坦' && b.ratio === Math.max(
    ...aspectHistogram.filter((x) => x.dir !== '平坦').map((x) => x.ratio),
  ))
  if (asp && asp.ratio > 0) {
    p3 = `坡面整体偏${asp.dir}向（占 ${fmtNumber(asp.ratio * 100, 1)}%）`
    const flat = aspectHistogram.find((b) => b.dir === '平坦')
    if (flat && flat.ratio > 0.2) {
      p3 += `，并有约 ${fmtNumber(flat.ratio * 100, 1)}% 的区域近乎平坦`
    }
    p3 += '，对日照、积雪与建设朝向有直接影响。'
  }
  if (p3) paragraphs.push(p3)

  // 段落 4：地形位置
  const lfEntries: [string, number][] = [
    ['山脊', landform.ridge],
    ['山坡', landform.upperSlope + landform.middleSlope + landform.lowerSlope],
    ['山谷', landform.valley],
    ['平地', landform.flat],
  ]
  lfEntries.sort((a, b) => b[1] - a[1])
  const topLf = lfEntries[0]
  let p4 = `地形位置上以${topLf[0]}为主（约 ${fmtNumber(topLf[1] * 100, 1)}%），平均地形起伏度 ${fmtInt(localReliefMean)} 米、地形粗糙度（TRI）${fmtNumber(triMean, 1)} 米，`
  p4 += triMean > 30 ? '地表较为破碎崎岖' : triMean > 10 ? '地表有一定起伏' : '地表相对平缓规整'
  p4 += '。'
  paragraphs.push(p4)

  // 段落 5：总结
  const complexity =
    slope.mean > 20 || elevation.range > 1500 ? '复杂' : slope.mean > 10 ? '中等起伏' : '较为平缓'
  let p5 = `综合来看，该区域地形起伏${complexity === '复杂' ? '明显' : complexity === '中等起伏' ? '较为明显' : '不大'}，${
    elevation.range > 1000 ? '具有较大的高程差异' : '高程差异相对有限'
  }，${slope.mean > 15 ? '整体坡度偏陡' : '整体坡度适中'}。`
  paragraphs.push(p5)

  // 关键词
  if (elevation.mean >= 3500) keywords.push('高山')
  else if (elevation.mean >= 1500) keywords.push('山地')
  else if (elevation.mean >= 500) keywords.push('低山丘陵')
  else keywords.push('平原/台地')

  if (elevation.range > 1500) keywords.push('高起伏')
  else if (elevation.range > 500) keywords.push('中起伏')
  else keywords.push('低起伏')

  if (slope.mean > 25) keywords.push('陡坡')
  else if (slope.mean > 15) keywords.push('坡度较大')
  else if (slope.mean < 5) keywords.push('平缓地形')

  if (steepest && steepest.ratio > 0.15) keywords.push('陡崖密布')
  if (flattest && flattest.ratio > 0.4) keywords.push('开阔平缓')
  if (elevation.range > 1000) keywords.push('高程差大')
  if (slope.mean > 15 && elevation.range > 1000) keywords.push('复杂地形')
  if (triMean > 30) keywords.push('地表崎岖')
  if (landform.valley > 0.3) keywords.push('沟谷发育')
  if (landform.flat > 0.4) keywords.push('开阔平地')

  return { paragraphs, keywords: Array.from(new Set(keywords)) }
}

function classifyRelief(range: number): string {
  if (range > 1500) return '高起伏'
  if (range > 500) return '中起伏'
  if (range > 200) return '小起伏'
  return '微起伏'
}

function classifyElevationBand(mean: number): string {
  if (mean >= 3500) return '高山'
  if (mean >= 1500) return '中山'
  if (mean >= 500) return '低山丘陵'
  if (mean >= 200) return '丘陵'
  return '平原'
}
