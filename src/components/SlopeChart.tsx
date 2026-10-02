import { forwardRef } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import echarts from '../utils/echarts'
import type { SlopeClass } from '../types'
import { fmtNumber } from '../utils/format'
import { SLOPE_COLORS } from '../utils/colors'

interface SlopeChartProps {
  classes: SlopeClass[]
}

export const SlopeChart = forwardRef<InstanceType<typeof ReactEChartsCore>, SlopeChartProps>(
  ({ classes }, ref) => {
    const option = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any) => {
          const p = params[0]
          const c = classes[p.dataIndex]
          return `${c.label}<br/>占比：${fmtNumber(c.ratio * 100, 1)}%<br/>面积：${fmtNumber(c.areaKm2, 2)} km²`
        },
      },
      grid: { left: 70, right: 30, top: 20, bottom: 30 },
      xAxis: {
        type: 'value',
        max: 100,
        axisLabel: { formatter: '{value}%' },
      },
      yAxis: {
        type: 'category',
        data: classes.map((c) => c.label),
        inverse: true,
      },
      series: [
        {
          type: 'bar',
          data: classes.map((c) => ({
            value: +(c.ratio * 100).toFixed(1),
            itemStyle: { color: rgbStr(SLOPE_COLORS[c.label] || [150, 150, 150]) },
          })),
          barWidth: 18,
          label: {
            show: true,
            position: 'right',
            formatter: (p: any) => `${fmtNumber(p.value, 1)}%`,
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

SlopeChart.displayName = 'SlopeChart'

function rgbStr(c: [number, number, number]) {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}
