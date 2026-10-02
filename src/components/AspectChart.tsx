import { forwardRef } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import echarts from '../utils/echarts'
import type { AspectBin } from '../types'
import { aspectColor } from '../utils/colors'
import { fmtNumber } from '../utils/format'

interface AspectChartProps {
  bins: AspectBin[]
}

const DIR_DEG: Record<string, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
  平坦: NaN,
}

export const AspectChart = forwardRef<InstanceType<typeof ReactEChartsCore>, AspectChartProps>(
  ({ bins }, ref) => {
    const option = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = params[0]
          const b = bins[p.dataIndex]
          return `${b.dir}<br/>占比：${fmtNumber(b.ratio * 100, 1)}%<br/>像元数：${b.count}`
        },
      },
      grid: { left: 50, right: 20, top: 20, bottom: 30 },
      xAxis: {
        type: 'category',
        data: bins.map((b) => b.dir),
        axisLabel: { fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: '{value}%' },
      },
      series: [
        {
          type: 'bar',
          data: bins.map((b) => {
            const deg = DIR_DEG[b.dir]
            const [R, G, B] = isFinite(deg) ? aspectColor(deg) : [200, 200, 200]
            return {
              value: +(b.ratio * 100).toFixed(1),
              itemStyle: { color: `rgb(${R},${G},${B})` },
            }
          }),
          barCategoryGap: '25%',
          label: {
            show: true,
            position: 'top',
            fontSize: 10,
            formatter: (p: any) => (p.value > 0 ? `${p.value}%` : ''),
          },
        },
      ],
    }
    return (
      <ReactEChartsCore
        ref={ref}
        echarts={echarts}
        option={option}
        style={{ height: 220 }}
      />
    )
  },
)

AspectChart.displayName = 'AspectChart'
