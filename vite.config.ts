import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    // 提高告警阈值，避免拆包后出现大量 500KB 警告噪音
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 按依赖体积拆包，避免单文件过大、提升缓存命中率
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('maplibre-gl')) return 'maplibre'
          if (
            id.includes('echarts') ||
            id.includes('zrender') ||
            id.includes('echarts-for-react')
          )
            return 'echarts'
          // 注：原先这里还有 jspdf / html2canvas / canvg / dompurify 的独立分包。
          // 报告导出已改为手写 PDF 引擎（src/services/export/report.ts），零依赖，这一组不再需要。
          if (id.includes('@turf')) return 'turf'
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/')
          )
            return 'react-vendor'
        },
      },
    },
  },
})
