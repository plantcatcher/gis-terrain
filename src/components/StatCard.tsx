interface StatCardProps {
  label: string
  value: string
  unit?: string
  hint?: string
}

export function StatCard({ label, value, unit, hint }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}
