import type { Position } from 'geojson'

export interface DEMQueryOptions {
  /** 每完成一个批次（瓦片 / 请求）回调一次，用于进度上报 */
  onProgress?: () => void
  /** 取消信号，一路透传到 fetch */
  signal?: AbortSignal
  /**
   * 期望的地面采样间距（米）。
   * 瓦片类数据源据此挑选最合适的缩放级别——分辨率越细、需要下载的瓦片越多。
   */
  resolutionM?: number
}

/**
 * DEM 数据源抽象接口。
 * 业务代码只依赖此接口，不绑定具体服务。
 */
export interface DEMProvider {
  readonly name: string
  /** 批量查询点高程，返回与输入顺序一致的高程数组 (m)。失败点为 NaN。 */
  queryElevations(points: Position[], options?: DEMQueryOptions): Promise<number[]>
}

export class DEMError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DEMError'
  }
}
