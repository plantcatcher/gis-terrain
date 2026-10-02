import { forwardRef } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import echarts from '../utils/echarts'
import type { ProfileResult } from '../types'
import { fmtInt, fmtDist } from '../utils/format'

interface ProfileChartProps {
  profile: ProfileResult
}

export const ProfileChart = forwardRef<InstanceType<typeof ReactEChartsCore>, ProfileChartProps>(
  ({ profile }, ref) => {
    const data = profile.points.map((p) => [+p.distance.toFixed(3), p.elevation])

    const option = {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const p = params[0]
          return `距离：${fmtDist(p.value[0])}<br/>海拔：${fmtInt(p.value[1])} m`
        },
      },
      grid: { left: 55, right: 20, top: 20, bottom: 40 },
      xAxis: {
        type: 'value',
        name: '距离 (km)',
        nameLocation: 'middle',
        nameGap: 25,
        max: +profile.distanceKm.toFixed(2),
      },
      yAxis: {
        type: 'value',
        name: '海拔 (m)',
        nameLocation: 'middle',
        nameGap: 40,
        scale: true,
      },
      series: [
        {
          type: 'line',
          data,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#7c3aed', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(124,58,237,0.4)' },
                { offset: 1, color: 'rgba(124,58,237,0.05)' },
              ],
            },
          },
        },
      ],
    }

    return (
      <ReactEChartsCore
        ref={ref}
        echarts={echarts}
        option={option}
        style={{ height: 260 }}
      />
    )
  },
)

ProfileChart.displayName = 'ProfileChart'
