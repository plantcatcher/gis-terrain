import type { ProgressMessage } from '../types'

interface AnalysisProgressProps {
  progress: ProgressMessage
  onCancel?: () => void
}

const STEPS: { key: string; label: string }[] = [
  { key: 'fetching', label: '获取地形数据' },
  { key: 'elevation', label: '计算高程' },
  { key: 'slope', label: '计算坡度' },
  { key: 'profile', label: '生成剖面' },
  { key: 'features', label: '分析地形特征' },
]

export function AnalysisProgress({ progress, onCancel }: AnalysisProgressProps) {
  const currentIdx = STEPS.findIndex((s) => s.key === progress.step)
  return (
    <div className="progress-overlay">
      <div className="progress-card">
        <div className="progress-title">
          <span className="spinner" aria-hidden />
          正在分析地形
        </div>
        <div className="progress-bar">
          <div
            className="progress-bar-fill"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <div className="progress-percent">{Math.round(progress.percent)}%</div>
        <ul className="progress-steps">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              className={
                i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending'
              }
            >
              {i < currentIdx ? '✓ ' : i === currentIdx ? '● ' : '○ '}
              {s.label}
            </li>
          ))}
        </ul>
        <div className="progress-msg">{progress.message}</div>
        {onCancel && (
          <button className="progress-cancel" onClick={onCancel}>
            中断分析
          </button>
        )}
      </div>
    </div>
  )
}
