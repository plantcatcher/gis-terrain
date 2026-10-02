import { forwardRef } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import echarts from '../utils/echarts'
import type { ElevationBin } from '../types'

interface ElevationHistogramProps {
  bins: ElevationBin[]
}

export const ElevationHistogram = forwardRef<
  InstanceType<typeof ReactEChartsCore>,
  ElevationHistogramProps
>(({ bins }, ref) => {
  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = params[0]
        const b = bins[p.dataIndex]
        return `${b.label}<br/>像元数：${b.count}<br/>占比：${(b.ratio * 100).toFixed(1)}%`
      },
    },
    grid: { left: 50, right: 20, top: 20, bottom: 50 },
    xAxis: {
      type: 'category',
      data: bins.map((b) => b.label),
      axisLabel: { rotate: 30, fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: '{value}%' },
    },
    series: [
      {
        type: 'bar',
        data: bins.map((b) => +(b.ratio * 100).toFixed(2)),
        itemStyle: { color: '#2563eb' },
        barCategoryGap: '20%',
      },
    ],
  }
  return (
    <ReactEChartsCore
      ref={ref}
      echarts={echarts}
      option={option}
      style={{ height: 240 }}
    />
  )
})

ElevationHistogram.displayName = 'ElevationHistogram'
